import XCTest
import CryptoKit

/// DurableStore 的单元测试（macOS 上运行；文件系统语义与 iOS 相同：APFS、F_FULLFSYNC、rename 原子替换）
/// 运行：xcodegen generate --spec ios/Tests/project-tests.yml && xcodebuild test -project ios/Tests/XiaomiStoreTests.xcodeproj -scheme XiaomiStoreTests -destination 'platform=macOS'
final class DurableStoreTests: XCTestCase {
    var root: URL!
    var store: DurableStore!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("xm-store-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        store = DurableStore(docs: root.appendingPathComponent("Documents", isDirectory: true),
                             diag: root.appendingPathComponent("Diag", isDirectory: true))
        try FileManager.default.createDirectory(at: store.docs, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        // 只读目录要先改回可写，才能删掉
        if let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) {
            for case let u as URL in e { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: u.path) }
        }
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: 工具
    func sha(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }
    func bigText(_ mb: Int) -> Data {
        var s = ""
        s.reserveCapacity(mb << 20)
        let unit = "{\"id\":\"r_x\",\"note\":\"午饭 牛肉面 🍜\",\"amount\":2350},"
        while s.utf8.count < mb << 20 { s += unit }
        return Data(s.utf8)
    }
    func meta(_ d: Data) -> Data {
        try! JSONSerialization.data(withJSONObject: ["v": 1, "batch": "u:1", "uid": "u", "bytes": d.count, "sha256": sha(d)])
    }
    func files(_ dir: URL) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).sorted()
    }
    func openFDs() -> Int { (try? FileManager.default.contentsOfDirectory(atPath: "/dev/fd").count) ?? -1 }
    func code(_ block: () throws -> Void) -> String? {
        do { try block(); return nil } catch let f as DurableStore.Failure { return f.code } catch { return "other" }
    }

    // MARK: B1 10 MB 快照写入、读回、SHA-256 比对
    func testWrite10MBSnapshotReadBackAndVerify() throws {
        let d = bigText(10)
        let r = try store.snapshotWrite(dir: "e1-abcdef12", name: "晓米记账-对齐前备份.json", content: d, bytes: d.count, sha256: sha(d), meta: meta(d))
        XCTAssertEqual(r["bytes"] as? Int, d.count)
        XCTAssertEqual(r["sha256"] as? String, sha(d))
        let folder = store.snapRoot.appendingPathComponent("e1-abcdef12")
        XCTAssertEqual(files(folder), ["晓米记账-对齐前备份.json", "晓米记账-对齐前备份.meta.json"])   // 没有残留的临时文件
        let back = try Data(contentsOf: folder.appendingPathComponent("晓米记账-对齐前备份.json"))
        XCTAssertEqual(sha(back), sha(d))
        let read = try store.snapshotRead(dir: "e1-abcdef12", name: "晓米记账-对齐前备份.json")
        XCTAssertEqual(read["sha256"] as? String, sha(d))
        XCTAssertEqual(read["verified"] as? Bool, true)
        XCTAssertEqual((read["content"] as? String)?.utf8.count, d.count)
    }

    // MARK: B2 文件写入失败（任一步骤）：明确报错、正式文件不存在、临时文件被清掉
    func testWriteFailureAtEveryStepReportsAndLeavesNoFile() throws {
        let d = Data("{\"a\":1}".utf8)
        for step in ["open", "write", "fsync", "close", "rename"] {
            store.fault = { $0 == step ? DurableStore.Failure(code: "EIO", message: "注入：\(step)") : nil }
            let c = code { _ = try store.snapshotWrite(dir: "d-\(step)", name: "s.json", content: d, bytes: d.count, sha256: sha(d), meta: meta(d)) }
            XCTAssertEqual(c, "EIO", step)
            let folder = store.snapRoot.appendingPathComponent("d-\(step)")
            XCTAssertEqual(files(folder).filter { $0.hasSuffix(".tmp") }, [], "\(step) 后残留临时文件")
            XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("s.json").path), step)
        }
        store.fault = nil
    }

    // MARK: B3 目标目录只读
    func testReadOnlyDirectoryFailsWithEACCES() throws {
        try XCTSkipIf(getuid() == 0, "以 root 运行时只读目录不生效")
        let folder = store.snapRoot.appendingPathComponent("ro-dir")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: folder.path)
        let d = Data("{}".utf8)
        XCTAssertEqual(code { _ = try store.snapshotWrite(dir: "ro-dir", name: "s.json", content: d, bytes: d.count, sha256: sha(d), meta: meta(d)) }, "EACCES")
    }

    // MARK: B4 磁盘空间不足（在写入和落盘两步注入 ENOSPC）
    func testDiskFullReportsENOSPC() throws {
        let d = bigText(1)
        for step in ["write", "fsync"] {
            store.fault = { $0 == step ? DurableStore.failure(errno: ENOSPC, "注入") : nil }
            XCTAssertEqual(code { _ = try store.ledgerStage(content: d, bytes: d.count, sha256: sha(d)) }, "ENOSPC", step)
            XCTAssertFalse(FileManager.default.fileExists(atPath: store.nextURL.path))
        }
        store.fault = nil
    }

    // MARK: B5 临时文件残留：启动恢复只清理本模块的临时文件，正式快照不动；未完成的提交移到诊断目录
    func testBootRecoverCleansTempFilesAndUncommittedStage() throws {
        let d = Data("{\"x\":1}".utf8)
        _ = try store.snapshotWrite(dir: "e2-abc", name: "s.json", content: d, bytes: d.count, sha256: sha(d), meta: meta(d))
        let folder = store.snapRoot.appendingPathComponent("e2-abc")
        try Data("half".utf8).write(to: folder.appendingPathComponent(".s.json.123.tmp"))
        try Data("half".utf8).write(to: store.docs.appendingPathComponent(".xiaomi-data.json.456.tmp"))
        try Data("keep".utf8).write(to: store.docs.appendingPathComponent("other.tmp"))      // 不是本模块的：不碰
        try Data("main".utf8).write(to: store.mainURL)
        _ = try store.ledgerStage(content: d, bytes: d.count, sha256: sha(d))
        let info = store.bootRecover()
        XCTAssertEqual(info["tmpRemoved"] as? Int, 2)
        XCTAssertNotNil(info["uncommitted"] as? String)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.nextURL.path))
        XCTAssertEqual(try String(contentsOf: store.mainURL, encoding: .utf8), "main")      // 以正式账本为准
        XCTAssertEqual(files(folder), ["s.json", "s.meta.json"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.docs.appendingPathComponent("other.tmp").path))
        XCTAssertEqual(files(store.diag).count, 1)
        for _ in 0..<5 { _ = try store.ledgerStage(content: d, bytes: d.count, sha256: sha(d)); _ = store.bootRecover() }
        XCTAssertLessThanOrEqual(files(store.diag).count, 3)                                // 诊断文件最多留 3 份
    }

    // MARK: B6 正式文件已有旧版本时替换失败：旧版本完整保留
    func testCommitRenameFailureKeepsOldMain() throws {
        try Data("old".utf8).write(to: store.mainURL)
        let d = Data("{\"new\":true}".utf8)
        _ = try store.ledgerStage(content: d, bytes: d.count, sha256: sha(d))
        store.fault = { $0 == "commit-rename" ? DurableStore.failure(errno: EACCES, "注入") : nil }
        XCTAssertEqual(code { _ = try store.ledgerCommit(bytes: d.count, sha256: sha(d)) }, "EACCES")
        XCTAssertEqual(try String(contentsOf: store.mainURL, encoding: .utf8), "old")
        store.fault = nil
        let r = try store.ledgerCommit(bytes: d.count, sha256: sha(d))                        // 重试成功
        XCTAssertEqual(r["sha256"] as? String, sha(d))
        XCTAssertEqual(try Data(contentsOf: store.mainURL), d)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.nextURL.path))
        // 快照替换失败：同名旧快照保持原样
        let a = Data("A".utf8), b = Data("B".utf8)
        _ = try store.snapshotWrite(dir: "e3-x", name: "s.json", content: a, bytes: 1, sha256: sha(a), meta: meta(a))
        store.fault = { $0 == "rename" ? DurableStore.failure(errno: EIO, "注入") : nil }
        XCTAssertEqual(code { _ = try store.snapshotWrite(dir: "e3-x", name: "s.json", content: b, bytes: 1, sha256: sha(b), meta: meta(b)) }, "EIO")
        store.fault = nil
        XCTAssertEqual(try Data(contentsOf: store.snapRoot.appendingPathComponent("e3-x/s.json")), a)
    }

    // MARK: 提交的其他失败：没有暂存、暂存内容不对、传输不一致、读回不一致
    func testCommitAndTransportGuards() throws {
        let d = Data("{\"v\":1}".utf8)
        XCTAssertEqual(code { _ = try store.ledgerCommit(bytes: d.count, sha256: sha(d)) }, "stage_missing")
        _ = try store.ledgerStage(content: d, bytes: d.count, sha256: sha(d))
        XCTAssertEqual(code { _ = try store.ledgerCommit(bytes: d.count, sha256: String(repeating: "0", count: 64)) }, "stage_mismatch")
        XCTAssertEqual(code { _ = try store.ledgerStage(content: d, bytes: d.count + 1, sha256: sha(d)) }, "transport")
        XCTAssertEqual(code { _ = try store.snapshotWrite(dir: "e4", name: "s.json", content: d, bytes: d.count, sha256: "ab", meta: meta(d)) }, "transport")
        store.readbackTransform = { var x = $0; x.append(0x20); return x }
        XCTAssertEqual(code { _ = try store.snapshotWrite(dir: "e5", name: "s.json", content: d, bytes: d.count, sha256: sha(d), meta: meta(d)) }, "mismatch")
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.snapRoot.appendingPathComponent("e5/s.json").path))   // 读回不一致的快照不留下
        store.readbackTransform = nil
        try store.ledgerDiscard()
        try store.ledgerDiscard()                                                           // 幂等
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.nextURL.path))
    }

    // MARK: B7 重复写入、重复读取和去重；B8 列表、读取、清理
    func testRepeatListReadDeleteAndDedupe() throws {
        let a = Data("{\"a\":1}".utf8), b = Data("{\"b\":2}".utf8)
        for _ in 0..<3 { _ = try store.snapshotWrite(dir: "e6-u", name: "s.json", content: a, bytes: a.count, sha256: sha(a), meta: meta(a)) }
        _ = try store.snapshotWrite(dir: "e7-u", name: "s.json", content: b, bytes: b.count, sha256: sha(b), meta: meta(b))
        var list = try store.snapshotList()
        XCTAssertEqual(list.count, 2)                                                       // 同一批次重复写同一个文件：只有一份
        XCTAssertEqual(list.compactMap { $0["verified"] as? Bool }, [true, true])
        for _ in 0..<3 { XCTAssertEqual(try store.snapshotRead(dir: "e6-u", name: "s.json")["sha256"] as? String, sha(a)) }
        // 内容被改坏：列表里校验失败（不会被当成有效快照）
        try Data("{\"a\":9}".utf8).write(to: store.snapRoot.appendingPathComponent("e7-u/s.json"))
        list = try store.snapshotList()
        XCTAssertEqual(list.first { ($0["dir"] as? String) == "e7-u" }?["verified"] as? Bool, false)
        // 清理：按目录删除，幂等，名字不合法的拒绝
        let r1 = store.snapshotDelete(dirs: ["e6-u", "../x", "nope"])
        XCTAssertEqual(r1.map { $0["code"] as? String }, ["deleted", "bad_request", "absent"])
        let r2 = store.snapshotDelete(dirs: ["e6-u"])
        XCTAssertEqual(r2.first?["code"] as? String, "absent")
        XCTAssertEqual(try store.snapshotList().map { $0["dir"] as? String }, ["e7-u"])
        store.fault = { $0 == "delete" ? DurableStore.Failure(code: "EIO", message: "注入") : nil }
        XCTAssertEqual(store.snapshotDelete(dirs: ["e7-u"]).first?["ok"] as? Bool, false)   // 删除失败：单独回报，不抛错
        store.fault = nil
        XCTAssertEqual(code { _ = try store.snapshotRead(dir: "e6-u", name: "s.json") }, "ENOENT")
        XCTAssertEqual(code { _ = try store.snapshotRead(dir: "a/b", name: "s.json") }, "bad_request")
    }

    // MARK: 文件描述符生命周期：成功和各种失败之后都不泄漏
    func testNoFileDescriptorLeak() throws {
        let d = Data(repeating: 0x61, count: 4096)
        let before = openFDs()
        for i in 0..<200 {
            let step = ["write", "fsync", "close", "rename", "dirsync", ""][i % 6]
            store.fault = { $0 == step ? DurableStore.Failure(code: "EIO", message: "注入") : nil }
            _ = code { _ = try store.ledgerStage(content: d, bytes: d.count, sha256: sha(d)) }
        }
        store.fault = nil
        XCTAssertEqual(openFDs(), before)
    }
}

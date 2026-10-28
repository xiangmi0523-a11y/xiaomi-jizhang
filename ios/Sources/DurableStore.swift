import Foundation
import CryptoKit

/// 晓米记账 · 原生安全持久化（方案 A，协议 v1，设计见 docs/snapshot-native-design.md）
///
/// - 持久写入：临时文件 → 强制落盘（F_FULLFSYNC，失败退回 fsync）→ 原子改名 → 同步目录 → 从正式文件读回、校验字节数和 SHA-256
/// - 账本两步提交：ledgerStage 写暂存文件 → ledgerCommit 核对后原子替换正式账本
/// - 安全快照按批次目录保存在 Documents/安全快照/<dir>/，旁边是 <name>.meta.json
/// - 任何一步失败都抛 Failure（带错误码），由调用方回执给网页；这里不吞任何持久化错误
/// - 只依赖 Foundation + CryptoKit，可以单独编进 macOS 单元测试（ios/Tests）
final class DurableStore {
    struct Failure: Error {
        let code: String
        let message: String
    }

    static let protocolVersion = 1
    static let mainName = "xiaomi-data.json"
    static let nextName = ".xiaomi-data.next.json"
    static let snapFolder = "安全快照"

    let docs: URL
    let diag: URL
    /// 仅测试用：在指定步骤注入故障（返回 nil 表示照常执行）。步骤名见 check(...) 的调用处
    var fault: ((String) -> Failure?)?
    /// 仅测试用：模拟读回时内容被改动
    var readbackTransform: ((Data) -> Data)?

    init(docs: URL, diag: URL) {
        self.docs = docs
        self.diag = diag
    }

    static func standard() -> DurableStore {
        let fm = FileManager.default
        let docs = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let diag = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("xm-diag", isDirectory: true)
        return DurableStore(docs: docs, diag: diag)
    }

    var mainURL: URL { docs.appendingPathComponent(Self.mainName) }
    var nextURL: URL { docs.appendingPathComponent(Self.nextName) }
    var snapRoot: URL { docs.appendingPathComponent(Self.snapFolder, isDirectory: true) }

    // MARK: - 工具

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func failure(errno e: Int32, _ what: String) -> Failure {
        let code: String
        switch e {
        case ENOSPC, EDQUOT: code = "ENOSPC"
        case EACCES, EPERM: code = "EACCES"
        case EROFS: code = "EROFS"
        case ENOENT: code = "ENOENT"
        default: code = "EIO"
        }
        return Failure(code: code, message: "\(what)失败：\(String(cString: strerror(e)))（errno \(e)）")
    }

    static func validDir(_ s: String) -> Bool {
        s.range(of: "^[A-Za-z0-9_-]{1,120}$", options: .regularExpression) != nil
    }

    static func validName(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 150 && !s.hasPrefix(".") && s.hasSuffix(".json") && !s.hasSuffix(".meta.json")
            && !s.contains("/") && !s.contains("\u{0}")
    }

    static func metaName(_ name: String) -> String {
        String(name.dropLast(".json".count)) + ".meta.json"
    }

    private func check(_ step: String) throws {
        if let f = fault?(step) { throw f }
    }

    private func readUncached(_ url: URL, _ what: String) throws -> Data {
        do { return try Data(contentsOf: url, options: .uncached) } catch {
            let ns = error as NSError
            if ns.domain == NSCocoaErrorDomain && (ns.code == NSFileReadNoSuchFileError || ns.code == NSFileNoSuchFileError) {
                throw Failure(code: "ENOENT", message: "\(what)不存在")
            }
            throw Failure(code: "EIO", message: "读取\(what)失败：\(error.localizedDescription)")
        }
    }

    private func syncDirectory(_ dir: URL) throws {
        let dfd = open(dir.path, O_RDONLY | O_CLOEXEC)
        if dfd < 0 { throw Self.failure(errno: errno, "打开目录") }
        defer { close(dfd) }
        if fcntl(dfd, F_FULLFSYNC) != 0 {
            if fsync(dfd) != 0 { throw Self.failure(errno: errno, "同步目录") }
        }
    }

    private func transport(_ data: Data, bytes: Int, sha: String) throws {
        if data.count != bytes || Self.sha256Hex(data) != sha.lowercased() {
            throw Failure(code: "transport", message: "收到的内容与请求声明的大小或校验值不一致")
        }
    }

    // MARK: - 持久写入

    /// 临时文件 → 强制落盘 → 原子改名 → 同步目录 → 读回。返回读回的字节数和 SHA-256
    @discardableResult
    func writeDurably(_ data: Data, to url: URL) throws -> (bytes: Int, sha256: String) {
        let dir = url.deletingLastPathComponent()
        do { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
        catch { throw Failure(code: "EIO", message: "建立目录失败：\(error.localizedDescription)") }
        let tmp = dir.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")

        try check("open")
        let fd = open(tmp.path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0o644)
        if fd < 0 { throw Self.failure(errno: errno, "创建临时文件") }
        var fdOpen = true
        var tmpExists = true
        defer {
            if fdOpen { close(fd) }          // 只关一次：正常路径上已经显式关闭并检查过返回值
            if tmpExists { unlink(tmp.path) }
        }

        try check("write")
        try data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            guard let base = buf.baseAddress else { return }
            var off = 0
            while off < buf.count {
                let n = Darwin.write(fd, base + off, buf.count - off)
                if n < 0 {
                    if errno == EINTR { continue }
                    throw Self.failure(errno: errno, "写入")
                }
                if n == 0 { throw Failure(code: "EIO", message: "写入没有进展") }
                off += n
            }
        }

        try check("fsync")
        if fcntl(fd, F_FULLFSYNC) != 0 {
            if fsync(fd) != 0 { throw Self.failure(errno: errno, "强制落盘") }
        }

        try check("close")
        fdOpen = false
        if close(fd) != 0 { throw Self.failure(errno: errno, "关闭文件") }

        try check("rename")
        if rename(tmp.path, url.path) != 0 { throw Self.failure(errno: errno, "替换正式文件") }
        tmpExists = false

        try check("dirsync")
        try syncDirectory(dir)

        try check("readback")
        var back = try readUncached(url, "刚写入的文件")
        if let t = readbackTransform { back = t(back) }
        return (back.count, Self.sha256Hex(back))
    }

    // MARK: - 快照

    func snapshotWrite(dir: String, name: String, content: Data, bytes: Int, sha256: String, meta: Data) throws -> [String: Any] {
        guard Self.validDir(dir), Self.validName(name) else {
            throw Failure(code: "bad_request", message: "快照目录或文件名不合法")
        }
        try transport(content, bytes: bytes, sha: sha256)
        let folder = snapRoot.appendingPathComponent(dir, isDirectory: true)
        let file = folder.appendingPathComponent(name)
        let r = try writeDurably(content, to: file)
        guard r.bytes == bytes, r.sha256 == sha256.lowercased() else {
            unlink(file.path)   // 内容不对的快照不能留下来被当成有效快照
            throw Failure(code: "mismatch", message: "快照读回的内容与写入的不一致")
        }
        try writeDurably(meta, to: folder.appendingPathComponent(Self.metaName(name)))
        return ["dir": dir, "name": name, "bytes": r.bytes, "sha256": r.sha256]
    }

    private func entry(dir: String, file: URL) -> [String: Any] {
        let name = file.lastPathComponent
        var e: [String: Any] = ["dir": dir, "name": name]
        do {
            let data = try readUncached(file, "快照")
            let sha = Self.sha256Hex(data)
            e["bytes"] = data.count
            e["sha256"] = sha
            let metaURL = file.deletingLastPathComponent().appendingPathComponent(Self.metaName(name))
            if FileManager.default.fileExists(atPath: metaURL.path) {
                let md = try readUncached(metaURL, "快照说明")
                if let meta = try JSONSerialization.jsonObject(with: md) as? [String: Any] {
                    e["meta"] = meta
                    let mb = (meta["bytes"] as? NSNumber)?.intValue
                    let ms = (meta["sha256"] as? String)?.lowercased()
                    e["verified"] = (mb == data.count && ms == sha)
                } else {
                    e["verified"] = false
                    e["error"] = "快照说明格式不对"
                }
            } else {
                e["verified"] = false
                e["error"] = "缺少快照说明"
            }
            let attrs = try FileManager.default.attributesOfItem(atPath: file.path)
            if let d = attrs[.modificationDate] as? Date { e["mtime"] = Int(d.timeIntervalSince1970 * 1000) }
        } catch let f as Failure {
            e["verified"] = false
            e["error"] = f.message
        } catch {
            e["verified"] = false
            e["error"] = error.localizedDescription
        }
        return e
    }

    func snapshotList() throws -> [[String: Any]] {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: snapRoot.path, isDirectory: &isDir), isDir.boolValue else { return [] }
        let dirs: [URL]
        do { dirs = try fm.contentsOfDirectory(at: snapRoot, includingPropertiesForKeys: nil) }
        catch { throw Failure(code: "EIO", message: "读取快照目录失败：\(error.localizedDescription)") }
        var out: [[String: Any]] = []
        for d in dirs.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) where Self.validDir(d.lastPathComponent) {
            let files: [URL]
            do { files = try fm.contentsOfDirectory(at: d, includingPropertiesForKeys: nil) }
            catch { out.append(["dir": d.lastPathComponent, "verified": false, "error": "读取批次目录失败：\(error.localizedDescription)"]); continue }
            for f in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) where Self.validName(f.lastPathComponent) {
                out.append(entry(dir: d.lastPathComponent, file: f))
            }
        }
        return out
    }

    func snapshotRead(dir: String, name: String) throws -> [String: Any] {
        guard Self.validDir(dir), Self.validName(name) else {
            throw Failure(code: "bad_request", message: "快照目录或文件名不合法")
        }
        let file = snapRoot.appendingPathComponent(dir, isDirectory: true).appendingPathComponent(name)
        let data = try readUncached(file, "快照")
        guard let text = String(data: data, encoding: .utf8) else {
            throw Failure(code: "mismatch", message: "快照不是有效的 UTF-8 文本")
        }
        var e = entry(dir: dir, file: file)
        e["content"] = text
        e["bytes"] = data.count
        e["sha256"] = Self.sha256Hex(data)
        return e
    }

    /// 删除整个批次目录。幂等：目录不存在算成功（absent）；每个目录单独回报结果
    func snapshotDelete(dirs: [String]) -> [[String: Any]] {
        dirs.map { dir -> [String: Any] in
            guard Self.validDir(dir) else { return ["dir": dir, "ok": false, "code": "bad_request"] }
            let url = snapRoot.appendingPathComponent(dir, isDirectory: true)
            guard FileManager.default.fileExists(atPath: url.path) else { return ["dir": dir, "ok": true, "code": "absent"] }
            if let f = fault?("delete") { return ["dir": dir, "ok": false, "code": f.code, "message": f.message] }
            do {
                try FileManager.default.removeItem(at: url)
                return ["dir": dir, "ok": true, "code": "deleted"]
            } catch {
                return ["dir": dir, "ok": false, "code": "EIO", "message": error.localizedDescription]
            }
        }
    }

    // MARK: - 账本两步提交

    func ledgerStage(content: Data, bytes: Int, sha256: String) throws -> [String: Any] {
        try transport(content, bytes: bytes, sha: sha256)
        let r = try writeDurably(content, to: nextURL)
        guard r.bytes == bytes, r.sha256 == sha256.lowercased() else {
            unlink(nextURL.path)
            throw Failure(code: "mismatch", message: "暂存的账本读回后不一致")
        }
        return ["bytes": r.bytes, "sha256": r.sha256]
    }

    func ledgerCommit(bytes: Int, sha256: String) throws -> [String: Any] {
        guard FileManager.default.fileExists(atPath: nextURL.path) else {
            throw Failure(code: "stage_missing", message: "找不到暂存的账本")
        }
        let staged = try readUncached(nextURL, "暂存的账本")
        guard staged.count == bytes, Self.sha256Hex(staged) == sha256.lowercased() else {
            throw Failure(code: "stage_mismatch", message: "暂存的账本与要提交的不一致")
        }
        try check("commit-rename")
        if rename(nextURL.path, mainURL.path) != 0 { throw Self.failure(errno: errno, "替换正式账本") }
        try check("commit-dirsync")
        try syncDirectory(docs)
        var back = try readUncached(mainURL, "正式账本")
        if let t = readbackTransform { back = t(back) }
        let sha = Self.sha256Hex(back)
        guard back.count == bytes, sha == sha256.lowercased() else {
            throw Failure(code: "mismatch", message: "提交后读回的账本不一致")
        }
        return ["bytes": back.count, "sha256": sha]
    }

    func ledgerDiscard() throws {
        if unlink(nextURL.path) != 0 && errno != ENOENT { throw Self.failure(errno: errno, "删除暂存的账本") }
    }

    // MARK: - 启动时恢复（读正式账本之前调用）

    /// 清理残留的临时文件；暂存文件还在说明上次提交没完成：移到诊断目录（不在「文件」App 里显示），以正式账本为准
    func bootRecover(now: Date = Date()) -> [String: Any] {
        let fm = FileManager.default
        var info: [String: Any] = [:]
        var removed = 0
        var errors: [String] = []
        var folders = [docs]
        if let ds = try? fm.contentsOfDirectory(at: snapRoot, includingPropertiesForKeys: nil) {   // 快照目录不存在是正常情况
            folders += ds.filter { Self.validDir($0.lastPathComponent) }
        }
        for folder in folders {
            let files: [URL]
            do { files = try fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) }
            catch { errors.append("列目录失败：\(folder.lastPathComponent)"); continue }
            for f in files {
                let n = f.lastPathComponent
                guard n.hasPrefix("."), n.hasSuffix(".tmp") else { continue }   // 只清理本模块的临时文件
                if unlink(f.path) == 0 { removed += 1 } else { errors.append("删除临时文件失败：\(n)") }
            }
        }
        info["tmpRemoved"] = removed
        if fm.fileExists(atPath: nextURL.path) {
            do {
                try fm.createDirectory(at: diag, withIntermediateDirectories: true)
                let fmt = DateFormatter()
                fmt.locale = Locale(identifier: "en_US_POSIX")
                fmt.dateFormat = "yyyyMMdd-HHmmss"
                let name = "uncommitted-\(fmt.string(from: now))-\(UUID().uuidString.prefix(6)).json"
                try fm.moveItem(at: nextURL, to: diag.appendingPathComponent(name))
                info["uncommitted"] = name
                let olds = try fm.contentsOfDirectory(at: diag, includingPropertiesForKeys: nil)
                    .filter { $0.lastPathComponent.hasPrefix("uncommitted-") }
                    .sorted { $0.lastPathComponent > $1.lastPathComponent }
                for old in olds.dropFirst(3) {
                    do { try fm.removeItem(at: old) } catch { errors.append("清理诊断文件失败") }
                }
            } catch {
                errors.append("处理未完成的提交失败：\(error.localizedDescription)")
                if unlink(nextURL.path) != 0 { errors.append("删除未完成的提交失败") }
                info["uncommitted"] = "discarded"
            }
        }
        info["errors"] = errors
        return info
    }
}

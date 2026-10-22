import UIKit
import WebKit
import SwiftUI
import WidgetKit
import LocalAuthentication
import UniformTypeIdentifiers
import UserNotifications

final class ViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, UIDocumentPickerDelegate {
    private var webView: WKWebView!
    private var webBottom: NSLayoutConstraint!
    private var pageReady = false
    private let ioQueue = DispatchQueue(label: "xiaomi.io", qos: .utility)

    /// 写文件时向系统申请一点后台时间：切到后台、锁屏的瞬间保存的数据也能写完，不会只写一半
    private final class BGTask {
        var id: UIBackgroundTaskIdentifier = .invalid
        func end() {
            guard id != .invalid else { return }
            UIApplication.shared.endBackgroundTask(id)
            id = .invalid
        }
    }

    private func runIO(_ name: String, _ work: @escaping () -> Void) {
        let bg = BGTask()
        bg.id = UIApplication.shared.beginBackgroundTask(withName: name) { bg.end() }
        ioQueue.async {
            work()
            DispatchQueue.main.async { bg.end() }
        }
    }

    private var dataFileURL: URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("xiaomi-data.json")
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .default }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? UIColor(red: 0.082, green: 0.075, blue: 0.059, alpha: 1)
                : UIColor(red: 1.0, green: 0.976, blue: 0.925, alpha: 1)
        }

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(LocalSchemeHandler(), forURLScheme: LocalSchemeHandler.scheme)
        let controller = WKUserContentController()
        controller.add(self, name: "native")
        controller.addUserScript(WKUserScript(source: bootstrapScript(),
                                              injectionTime: .atDocumentStart,
                                              forMainFrameOnly: true))
        config.userContentController = controller

        let web = WKWebView(frame: .zero, configuration: config)
        web.translatesAutoresizingMaskIntoConstraints = false
        web.navigationDelegate = self
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        view.addSubview(web)
        webBottom = web.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.topAnchor),
            webBottom,
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        webView = web

        NotificationCenter.default.addObserver(self, selector: #selector(handleQuickAdd),
                                               name: .xmQuickAdd, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillChange(_:)),
                                               name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillHide(_:)),
                                               name: UIResponder.keyboardWillHideNotification, object: nil)
        // 切后台 / 来电 / 下拉控制中心时立刻让网页把数据存一次
        NotificationCenter.default.addObserver(self, selector: #selector(appWillResign),
                                               name: UIApplication.willResignActiveNotification, object: nil)

        if let url = URL(string: "\(LocalSchemeHandler.scheme)://app/index.html") {
            web.load(URLRequest(url: url))
        }
    }

    @objc private func appWillResign() {
        guard pageReady else { return }
        webView.evaluateJavaScript("window.App && App.flush && App.flush()", completionHandler: nil)
    }

    /// 网页进程被系统回收（内存紧张时常见）会白屏：用最新的账本文件重新注入启动脚本后重新加载
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        pageReady = false
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(source: bootstrapScript(), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if let url = URL(string: "\(LocalSchemeHandler.scheme)://app/index.html") {
            webView.load(URLRequest(url: url))
        }
    }

    /// 启动时把上次保存的账本文件交给网页（网页自己的 localStorage 丢失时用来恢复）
    private func bootstrapScript() -> String {
        var js = "window.__NATIVE_APP__ = true; window.__BIO__ = \(jsString(biometryName()));"
        if let folder = backupFolderURL() {
            js += " window.__BACKUP_FOLDER__ = \(jsString(folder.lastPathComponent));"
        }
        // 在 IO 队列里读：保证还没写完的保存先写完，读到的是最新数据
        let url = dataFileURL
        let saved: Data? = ioQueue.sync { try? Data(contentsOf: url) }
        if let data = saved, !data.isEmpty {
            js += " window.__NATIVE_B64__ = \"\(data.base64EncodedString())\";"
        }
        return js
    }

    private func jsString(_ s: String) -> String {
        let escaped = s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\u{2028}", with: " ")
            .replacingOccurrences(of: "\u{2029}", with: " ")
        return "\"" + escaped + "\""
    }

    private func callJS(_ code: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript(code, completionHandler: nil)
        }
    }

    // MARK: - 每晚记账提醒（本地通知，按天预排；当天记过账的那天由网页端去掉）

    private static let remindPrefix = "xm-remind-"

    private func clearReminders(then: (() -> Void)?) {
        let center = UNUserNotificationCenter.current()
        center.getPendingNotificationRequests { requests in
            let ids = requests.map { $0.identifier }.filter { $0.hasPrefix(Self.remindPrefix) }
            center.removePendingNotificationRequests(withIdentifiers: ids)
            then?()
        }
    }

    private func scheduleReminders(_ items: [[String: Any]]) {
        clearReminders {
            let center = UNUserNotificationCenter.current()
            for item in items {
                guard let id = item["id"] as? String, let date = item["date"] as? String else { continue }
                let parts = date.split(separator: "-").compactMap { Int($0) }
                guard parts.count == 3 else { continue }
                var comps = DateComponents()
                comps.year = parts[0]; comps.month = parts[1]; comps.day = parts[2]
                comps.hour = (item["hour"] as? Int) ?? 21
                comps.minute = (item["minute"] as? Int) ?? 0
                let content = UNMutableNotificationContent()
                content.title = (item["title"] as? String) ?? "晓米记账"
                content.body = (item["body"] as? String) ?? "今天还没记账哦～"
                content.sound = .default
                content.userInfo = ["action": "add"]
                let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
                center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
            }
        }
    }

    // MARK: - 面容 ID / 触控 ID

    private func biometryName() -> String {
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else { return "" }
        switch ctx.biometryType {
        case .faceID: return "faceID"
        case .touchID: return "touchID"
        default: return ""
        }
    }

    private func authenticate() {
        let ctx = LAContext()
        ctx.localizedFallbackTitle = "输入密码"
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else {
            callJS("App.Lock && App.Lock.onBio && App.Lock.onBio(false)")
            return
        }
        ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "解锁晓米记账") { [weak self] ok, _ in
            self?.callJS("App.Lock && App.Lock.onBio && App.Lock.onBio(\(ok))")
        }
    }

    // MARK: - 自动备份：用户选一次文件夹（可选 iCloud 云盘），之后凭书签持续写入

    private static let bookmarkKey = "backupFolderBookmark"

    private func backupFolderURL() -> URL? {
        guard let data = UserDefaults.standard.data(forKey: Self.bookmarkKey) else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else { return nil }
        if stale, url.startAccessingSecurityScopedResource() {
            if let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
                UserDefaults.standard.set(fresh, forKey: Self.bookmarkKey)
            }
            url.stopAccessingSecurityScopedResource()
        }
        return url
    }

    private func pickBackupFolder() {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder])
        picker.delegate = self
        picker.allowsMultipleSelection = false
        present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else { return }
        let ok = url.startAccessingSecurityScopedResource()
        defer { if ok { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
            UserDefaults.standard.set(data, forKey: Self.bookmarkKey)
            callJS("App.backup && App.backup.onFolder(\(jsString(url.lastPathComponent)))")
        } catch {
            callJS("App.backup && App.backup.onFolderFail(\(jsString(error.localizedDescription)))")
        }
    }

    private func pruneBackups(in folder: URL, prefix: String, keep: Int, coordinated: Bool) {
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        let mine = files.filter { $0.lastPathComponent.hasPrefix(prefix) }
            .sorted { $0.lastPathComponent > $1.lastPathComponent }
        for old in mine.dropFirst(keep) {
            if coordinated {
                var err: NSError?
                NSFileCoordinator().coordinate(writingItemAt: old, options: .forDeleting, error: &err) { u in
                    try? FileManager.default.removeItem(at: u)
                }
            } else {
                try? FileManager.default.removeItem(at: old)
            }
        }
    }

    private func autoBackup(filename: String, content: String) {
        runIO("xm-backup") { [weak self] in
            guard let self = self else { return }
            guard let folder = self.backupFolderURL() else {
                self.callJS("App.backup && App.backup.onAuto(false, '', '还没有选择备份文件夹')")
                return
            }
            let access = folder.startAccessingSecurityScopedResource()
            defer { if access { folder.stopAccessingSecurityScopedResource() } }
            let target = folder.appendingPathComponent(filename)
            var coordErr: NSError?
            var writeErr: Error?
            NSFileCoordinator().coordinate(writingItemAt: target, options: .forReplacing, error: &coordErr) { url in
                do { try Data(content.utf8).write(to: url, options: .atomic) } catch { writeErr = error }
            }
            let failure: Error? = writeErr ?? (coordErr as Error?)
            if failure == nil {
                self.pruneBackups(in: folder, prefix: "晓米记账自动备份-", keep: 10, coordinated: true)
            }
            let msg = failure.map { self.jsString($0.localizedDescription) } ?? "''"
            self.callJS("App.backup && App.backup.onAuto(\(failure == nil), \(self.jsString(folder.lastPathComponent)), \(msg))")
        }
    }

    /// App 内的本地快照（「文件」App → 我的 iPhone → 晓米记账 → 自动备份），保留最近 7 份
    private func saveSnapshot(filename: String, content: String) {
        let safeName = filename.replacingOccurrences(of: "/", with: "-")
        runIO("xm-snapshot") { [weak self] in
            guard let self = self else { return }
            let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("自动备份", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? Data(content.utf8).write(to: dir.appendingPathComponent(safeName), options: .atomic)
            // 每天的自动快照留 7 份，导入/清空前的「操作前备份」留 5 份；损坏数据的存档不自动删
            for (prefix, keep) in [("晓米记账自动备份-", 7), ("晓米记账-操作前备份-", 5)] where safeName.hasPrefix(prefix) {
                self.pruneBackups(in: dir, prefix: prefix, keep: keep, coordinated: false)
            }
        }
    }

    // MARK: - 键盘：弹出时整个页面缩到键盘上方，输入框（比如记账备注）始终看得见

    @objc private func keyboardWillChange(_ note: Notification) {
        guard let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let local = view.convert(end, from: nil)
        applyKeyboard(height: max(0, view.bounds.maxY - local.minY), note: note)
    }

    @objc private func keyboardWillHide(_ note: Notification) {
        applyKeyboard(height: 0, note: note)
    }

    private func applyKeyboard(height: CGFloat, note: Notification) {
        guard webBottom.constant != -height else { return }
        webBottom.constant = -height
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
        UIView.animate(withDuration: duration, animations: { self.view.layoutIfNeeded() }, completion: { _ in
            // 页面本身是固定布局，不需要系统帮忙滚动；滚偏了就复位，避免收起键盘后页面错位
            self.webView.scrollView.setContentOffset(.zero, animated: false)
        })
        webView.evaluateJavaScript("document.documentElement.classList.toggle('kb-open', \(height > 0))", completionHandler: nil)
    }

    // MARK: - 快速记一笔（小组件 / 快捷指令）

    @objc private func handleQuickAdd() {
        guard pageReady else { return }   // 页面还没加载好，等 didFinish 再处理
        if QuickAction.shared.consume() {
            presentedViewController?.dismiss(animated: false)
            webView.evaluateJavaScript("window.App && App.quickAdd && App.quickAdd()", completionHandler: nil)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        // 等网页初始化完再弹记账面板
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.handleQuickAdd() }
    }

    // MARK: - JS -> 原生

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "save":
            if let text = body["data"] as? String { saveData(text) }
        case "export":
            if let name = body["filename"] as? String, let content = body["content"] as? String {
                shareFile(name: name, content: content)
            }
        case "receiptShot":
            let num = { (k: String) -> CGFloat in CGFloat((body[k] as? NSNumber)?.doubleValue ?? 0) }
            receiptShot(CGRect(x: num("x"), y: num("y"), width: num("w"), height: num("h")))
        case "mode":
            switch body["value"] as? String {
            case "dark": overrideUserInterfaceStyle = .dark
            case "light": overrideUserInterfaceStyle = .light
            default: overrideUserInterfaceStyle = .unspecified
            }
        case "widget":
            if let text = body["data"] as? String { updateWidget(text) }
        case "chart":
            if let text = body["data"] as? String { presentChart(text) }
        case "auth":
            authenticate()
        case "pickBackupFolder":
            pickBackupFolder()
        case "autoBackup":
            if let name = body["filename"] as? String, let content = body["content"] as? String {
                autoBackup(filename: name, content: content)
            }
        case "notifyAuth":
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] granted, _ in
                self?.callJS("App.remind && App.remind.onPerm(\(granted))")
            }
        case "notifySchedule":
            if let items = body["items"] as? [[String: Any]] { scheduleReminders(items) }
        case "notifyClear":
            clearReminders(then: nil)
        case "notifyTest":
            let content = UNMutableNotificationContent()
            content.title = (body["title"] as? String) ?? "晓米记账"
            content.body = (body["body"] as? String) ?? "测试通知"
            content.sound = .default
            content.userInfo = ["action": "add"]
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false)
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "xm-test", content: content, trigger: trigger))
        case "snapshot":
            if let name = body["filename"] as? String, let content = body["content"] as? String {
                saveSnapshot(filename: name, content: content)
            }
        default:
            break
        }
    }

    private func saveData(_ text: String) {
        let url = dataFileURL
        runIO("xm-save") {
            try? Data(text.utf8).write(to: url, options: .atomic)
        }
    }

    /// 把预算/猫咪摘要写进 App Group，刷新桌面小组件（签名证书不支持 App Group 时小组件会显示“打开 App 同步”）
    private var lastWidgetJSON = ""
    private func updateWidget(_ json: String) {
        let stable = json.replacingOccurrences(of: #""updated":\d+(\.\d+)?"#, with: "", options: .regularExpression)
        guard stable != lastWidgetJSON else { return }
        lastWidgetJSON = stable
        XMShared.defaults?.set(Data(json.utf8), forKey: XMShared.widgetKey)
        WidgetCenter.shared.reloadTimelines(ofKind: XMShared.widgetKind)
    }

    /// Swift Charts 马卡龙饼图
    private func presentChart(_ json: String) {
        guard let payload = try? JSONDecoder().decode(ChartPayload.self, from: Data(json.utf8)),
              !payload.items.isEmpty else { return }
        let host = UIHostingController(rootView: ChartSheetHost(payload: payload, onClose: { [weak self] in
            self?.dismiss(animated: true)
        }))
        host.modalPresentationStyle = .pageSheet
        if let sheet = host.sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
        }
        present(host, animated: true)
    }

    private func shareFile(name: String, content: String) {
        let safeName = name.replacingOccurrences(of: "/", with: "-")
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(safeName)
        do {
            try Data(content.utf8).write(to: url, options: .atomic)
        } catch {
            return
        }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
        present(sheet, animated: true)
    }

    // MARK: - 每日小票：截取网页里的小票区域，弹出分享面板（可存到相册）

    private func receiptShot(_ rect: CGRect) {
        let bounds = webView.bounds
        let r = rect.intersection(bounds)
        guard !r.isNull, r.width > 10, r.height > 10 else {
            callJS("App.receipt.onShot(false)")
            return
        }
        let cfg = WKSnapshotConfiguration()
        cfg.rect = r
        cfg.afterScreenUpdates = true
        cfg.snapshotWidth = NSNumber(value: Double(r.width))
        webView.takeSnapshot(with: cfg) { [weak self] image, _ in
            guard let self = self else { return }
            self.callJS("App.receipt.onShot(\(image != nil))")
            guard let image = image else { return }
            let sheet = UIActivityViewController(activityItems: [image], applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = self.view
            sheet.popoverPresentationController?.sourceRect = CGRect(x: self.view.bounds.midX, y: self.view.bounds.midY, width: 0, height: 0)
            self.present(sheet, animated: true)
        }
    }

    // MARK: - 导航：只允许内置页面

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url,
           url.scheme != LocalSchemeHandler.scheme, url.scheme != "about", url.scheme != "blob" {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}

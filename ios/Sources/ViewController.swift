import UIKit
import WebKit
import SwiftUI
import WidgetKit

final class ViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {
    private var webView: WKWebView!
    private var pageReady = false
    private let ioQueue = DispatchQueue(label: "xiaomi.io", qos: .utility)

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
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        webView = web

        NotificationCenter.default.addObserver(self, selector: #selector(handleQuickAdd),
                                               name: .xmQuickAdd, object: nil)

        if let url = URL(string: "\(LocalSchemeHandler.scheme)://app/index.html") {
            web.load(URLRequest(url: url))
        }
    }

    /// 启动时把上次保存的账本文件交给网页（网页自己的 localStorage 丢失时用来恢复）
    private func bootstrapScript() -> String {
        guard let data = try? Data(contentsOf: dataFileURL), !data.isEmpty else {
            return "window.__NATIVE_APP__ = true;"
        }
        return "window.__NATIVE_APP__ = true; window.__NATIVE_B64__ = \"\(data.base64EncodedString())\";"
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
        default:
            break
        }
    }

    private func saveData(_ text: String) {
        let url = dataFileURL
        ioQueue.async {
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

import Foundation
import WebKit

/// 用自定义协议 xiaomi://app/ 提供 App 内置网页，这样网页的 localStorage 来源固定，
/// 重新签名/更新安装后不会因为安装路径变化而丢数据。
final class LocalSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "xiaomi"

    private let root: URL = {
        let base = Bundle.main.resourceURL ?? URL(fileURLWithPath: Bundle.main.bundlePath)
        return base.appendingPathComponent("www", isDirectory: true).standardizedFileURL
    }()

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let relative = String(path.dropFirst())
        let fileURL = root.appendingPathComponent(relative).standardizedFileURL

        guard fileURL.path.hasPrefix(root.path),
              let data = try? Data(contentsOf: fileURL) else {
            let notFound = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "text/plain"])!
            urlSchemeTask.didReceive(notFound)
            urlSchemeTask.didReceive(Data("Not Found".utf8))
            urlSchemeTask.didFinish()
            return
        }

        let headers = [
            "Content-Type": mimeType(for: fileURL.pathExtension),
            "Content-Length": String(data.count),
            "Cache-Control": "no-cache"
        ]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js": return "application/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "woff2": return "font/woff2"
        default: return "application/octet-stream"
        }
    }
}

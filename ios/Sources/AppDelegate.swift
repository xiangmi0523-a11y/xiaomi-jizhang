import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = ViewController()
        window.makeKeyAndVisible()
        self.window = window
        if let url = launchOptions?[.url] as? URL, url.scheme == XMShared.urlScheme, url.host == "add" {
            QuickAction.shared.request()
        }
        return true
    }

    // 小组件“快速记一笔”按钮：xiaomijz://add
    func application(_ app: UIApplication, open url: URL,
                     options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        guard url.scheme == XMShared.urlScheme else { return false }
        if url.host == "add" { QuickAction.shared.request() }   // xiaomijz://open 只是打开 App
        return true
    }
}

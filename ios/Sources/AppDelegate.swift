import UIKit
import UserNotifications

@main
final class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = ViewController()
        window.makeKeyAndVisible()
        self.window = window
        if let url = launchOptions?[.url] as? URL, url.scheme == XMShared.urlScheme, url.host == "add" {
            QuickAction.shared.request()
        }
        return true
    }

    // App 开着的时候到点也显示提醒横幅
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    // 点记账提醒通知：直接弹出记账面板
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if (response.notification.request.content.userInfo["action"] as? String) == "add" {
            QuickAction.shared.request()
        }
        completionHandler()
    }

    // 小组件“快速记一笔”按钮：xiaomijz://add
    func application(_ app: UIApplication, open url: URL,
                     options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        guard url.scheme == XMShared.urlScheme else { return false }
        if url.host == "add" { QuickAction.shared.request() }   // xiaomijz://open 只是打开 App
        return true
    }
}

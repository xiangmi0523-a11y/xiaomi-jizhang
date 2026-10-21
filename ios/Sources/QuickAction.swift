import Foundation
import AppIntents

extension Notification.Name {
    static let xmQuickAdd = Notification.Name("xmQuickAdd")
}

/// “快速记一笔”请求：来自小组件按钮（URL）、快捷指令（App Intents）
final class QuickAction {
    static let shared = QuickAction()
    private(set) var pending = false

    func request() {
        pending = true
        NotificationCenter.default.post(name: .xmQuickAdd, object: nil)
    }

    func consume() -> Bool {
        let p = pending
        pending = false
        return p
    }
}

/// 快捷指令：打开晓米记账并直接弹出记账面板（可用于“敲击背面”等个人自动化）
@available(iOS 16.0, *)
struct QuickAddIntent: AppIntent {
    static let title: LocalizedStringResource = "快速记一笔"
    static let openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        QuickAction.shared.request()
        return .result()
    }
}

@available(iOS 16.0, *)
struct XiaomiShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: QuickAddIntent(), phrases: [
            "用\(.applicationName)记一笔",
            "\(.applicationName)快速记账"
        ])
    }
}

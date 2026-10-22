import Foundation

/// App 和桌面小组件共用的常量与数据结构
enum XMShared {
    static let appGroup = "group.com.xiaomijizhang.app"
    static let widgetKey = "widgetData"
    static let urlScheme = "xiaomijz"
    static let widgetKind = "XiaomiWidget"

    static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }
}

/// 小组件显示的摘要（金额单位：元），由 App 里的网页计算后写入 App Group
struct XMWidgetData: Codable {
    var hasBudget: Bool
    var budget: Double
    var spent: Double
    var remain: Double
    var level: Int
    var catId: String
    var catName: String
    var sleeping: Bool
    var coins: Int
    var monthLabel: String
    var updated: Double
    var smart: Bool? = nil
    var today: Double? = nil

    static func load() -> XMWidgetData? {
        guard let data = XMShared.defaults?.data(forKey: XMShared.widgetKey) else { return nil }
        return try? JSONDecoder().decode(XMWidgetData.self, from: data)
    }

    static let sample = XMWidgetData(hasBudget: true, budget: 3000, spent: 1260, remain: 1740, level: 0,
                                     catId: "n1", catName: "橘子", sleeping: false, coins: 160,
                                     monthLabel: "本月", updated: 0)
}

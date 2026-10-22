import WidgetKit
import SwiftUI

private let ink = Color(red: 0.23, green: 0.16, blue: 0.0)

struct XMEntry: TimelineEntry {
    let date: Date
    let data: XMWidgetData?
}

struct XMProvider: TimelineProvider {
    func placeholder(in context: Context) -> XMEntry {
        XMEntry(date: Date(), data: .sample)
    }

    func getSnapshot(in context: Context, completion: @escaping (XMEntry) -> Void) {
        completion(XMEntry(date: Date(), data: XMWidgetData.load() ?? .sample))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<XMEntry>) -> Void) {
        let entry = XMEntry(date: Date(), data: XMWidgetData.load())
        let cal = Calendar.current
        let halfHour = cal.date(byAdding: .minute, value: 30, to: Date()) ?? Date().addingTimeInterval(1800)
        let midnight = cal.startOfDay(for: cal.date(byAdding: .day, value: 1, to: Date()) ?? Date())
        let next = min(halfHour, midnight.addingTimeInterval(5))
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}

private func yuan(_ v: Double) -> String {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.minimumFractionDigits = 2
    f.maximumFractionDigits = 2
    return "¥" + (f.string(from: NSNumber(value: abs(v))) ?? String(format: "%.2f", abs(v)))
}

struct XMWidgetView: View {
    let entry: XMEntry

    private var data: XMWidgetData? { entry.data }

    private var levelColor: Color {
        switch data?.level ?? 0 {
        case 2: return Color(red: 1.0, green: 0.30, blue: 0.37)
        case 1: return Color(red: 0.95, green: 0.58, blue: 0.0)
        default: return Color(red: 0.20, green: 0.70, blue: 0.42)
        }
    }

    static let tips = [
        "今天的每一笔，都是在给未来的自己存钱喵～",
        "奶茶少喝一杯，猫粮多买一包！",
        "记完账再睡觉，猫咪才不会饿肚子",
        "买之前问问自己：真的需要吗？",
        "小钱也是钱，记下来就知道花去哪了",
        "坚持记账 21 天，就会变成好习惯",
        "月底存下的钱，会自动跑进储蓄罐哦",
        "今天也是认真生活的一天，记一笔吧"
    ]

    static func tip(_ d: Date) -> String {
        let day = Calendar.current.ordinality(of: .day, in: .year, for: d) ?? 0
        return tips[day % tips.count]
    }

    static func dateText(_ d: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "zh_CN")
        f.dateFormat = "M月d日 EEEE"
        return f.string(from: d)
    }

    private var catImage: String {
        guard let d = data else { return "cat_n1" }
        return "cat_" + d.catId + (d.sleeping ? "_sleep" : "")
    }

    private var fraction: Double {
        guard let d = data, d.hasBudget, d.budget > 0 else { return 0 }
        return min(1, max(0, d.spent / d.budget))
    }

    var body: some View {
        HStack(spacing: 10) {
            VStack(spacing: 2) {
                Image(catImage)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 118, maxHeight: 92)
                Text(data?.catName ?? "橘子")
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundColor(ink)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(Capsule().fill(Color.white.opacity(0.75)))
            }
            .frame(width: 122)

            VStack(alignment: .leading, spacing: 5) {
                if let d = data {
                    if d.hasBudget {
                        Text(d.remain >= 0 ? "\(d.monthLabel) 预算剩余" : "\(d.monthLabel) 已超支")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(ink.opacity(0.7))
                            .lineLimit(1)
                        Text(yuan(d.remain))
                            .font(.system(size: 24, weight: .heavy, design: .rounded))
                            .foregroundColor(levelColor)
                            .minimumScaleFactor(0.5)
                            .lineLimit(1)
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(Color.white)
                                Capsule().fill(levelColor)
                                    .frame(width: max(8, geo.size.width * fraction))
                            }
                            .overlay(Capsule().stroke(ink, lineWidth: 1.5))
                        }
                        .frame(height: 10)
                        if let t = d.today {
                            Text(t >= 0 ? "今天还能花 \(yuan(t))" : "今天超出 \(yuan(t))")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundColor(t >= 0 ? ink.opacity(0.75) : Color(red: 0.85, green: 0.2, blue: 0.27))
                                .lineLimit(1)
                        }
                    } else {
                        Text("还没设置每月预算")
                            .font(.system(size: 15, weight: .heavy)).foregroundColor(ink)
                        Text("在 App「我的 → 预算」里设置")
                            .font(.system(size: 11)).foregroundColor(ink.opacity(0.7))
                    }
                } else {
                    // 签名证书不支持 App Group 时读不到账本数据，就显示日期和每日小贴士
                    Text(Self.dateText(entry.date))
                        .font(.system(size: 18, weight: .heavy, design: .rounded)).foregroundColor(ink)
                        .lineLimit(1).minimumScaleFactor(0.7)
                    Text(Self.tip(entry.date))
                        .font(.system(size: 12, weight: .semibold)).foregroundColor(ink.opacity(0.75))
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Link(destination: URL(string: "\(XMShared.urlScheme)://add")!) {
                    HStack(spacing: 4) {
                        Image(systemName: "plus.circle.fill")
                        Text("快速记一笔")
                    }
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundColor(.white)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(Capsule().fill(Color(red: 1.0, green: 0.48, blue: 0.54)))
                    .overlay(Capsule().stroke(ink, lineWidth: 2))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .widgetURL(URL(string: "\(XMShared.urlScheme)://open"))
        .xmBackground()
    }
}

private extension View {
    @ViewBuilder
    func xmBackground() -> some View {
        let bg = LinearGradient(colors: [Color(red: 1.0, green: 0.86, blue: 0.48), Color(red: 1.0, green: 0.76, blue: 0.30)],
                                startPoint: .topLeading, endPoint: .bottomTrailing)
        if #available(iOSApplicationExtension 17.0, *) {
            self.containerBackground(for: .widget) { bg }
        } else {
            self.padding(14).background(bg)
        }
    }
}

struct XiaomiWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: XMShared.widgetKind, provider: XMProvider()) { entry in
            XMWidgetView(entry: entry)
        }
        .configurationDisplayName("晓米记账")
        .description("本月剩余预算、最近遇见的猫咪，一键快速记一笔")
        .supportedFamilies([.systemMedium])
    }
}

@main
struct XiaomiWidgetBundle: WidgetBundle {
    var body: some Widget {
        XiaomiWidget()
    }
}

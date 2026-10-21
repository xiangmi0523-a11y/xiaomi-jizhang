import SwiftUI
import Charts

struct ChartSlice: Identifiable, Decodable {
    let id: String
    let name: String
    let amount: Double
    let color: String
}

struct ChartPayload: Decodable {
    let title: String
    let total: Double
    let unit: String
    let items: [ChartSlice]
}

extension Color {
    init(hex: String) {
        let s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let v = UInt64(s, radix: 16) ?? 0xE5DCCF
        self.init(.sRGB,
                  red: Double((v >> 16) & 0xFF) / 255,
                  green: Double((v >> 8) & 0xFF) / 255,
                  blue: Double(v & 0xFF) / 255,
                  opacity: 1)
    }
}

private let ink = Color(red: 0.23, green: 0.16, blue: 0.0)

private func yuan(_ v: Double) -> String {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.minimumFractionDigits = 2
    f.maximumFractionDigits = 2
    return "¥" + (f.string(from: NSNumber(value: v)) ?? String(format: "%.2f", v))
}

/// 根据系统版本选择：iOS 17 用 Swift Charts 环形饼图，iOS 16 用条形图
struct ChartSheetHost: View {
    let payload: ChartPayload
    let onClose: () -> Void

    var body: some View {
        if #available(iOS 17.0, *) {
            MacaronPieView(payload: payload, onClose: onClose)
        } else if #available(iOS 16.0, *) {
            MacaronBarView(payload: payload, onClose: onClose)
        } else {
            VStack(spacing: 16) {
                Text("需要 iOS 16 以上才能显示原生图表")
                Button("关闭", action: onClose)
            }
            .padding()
        }
    }
}

private struct LegendRow: View {
    let slice: ChartSlice
    let total: Double
    let highlighted: Bool

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(Color(hex: slice.color))
                .frame(width: 16, height: 16)
                .overlay(Circle().stroke(ink, lineWidth: 1.5))
            Text(slice.name).font(.system(size: 15, weight: .semibold))
            Spacer()
            Text(total > 0 ? String(format: "%.1f%%", slice.amount / total * 100) : "0%")
                .font(.system(size: 13)).foregroundColor(.secondary).monospacedDigit()
            Text(yuan(slice.amount)).font(.system(size: 15, weight: .bold)).monospacedDigit()
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(highlighted ? Color(hex: slice.color).opacity(0.35) : Color(.secondarySystemGroupedBackground))
        )
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(ink.opacity(highlighted ? 0.8 : 0.15), lineWidth: highlighted ? 2 : 1))
    }
}

@available(iOS 17.0, *)
struct MacaronPieView: View {
    let payload: ChartPayload
    let onClose: () -> Void
    @State private var selectedValue: Double?
    @State private var selectedId: String?
    @State private var appeared = false

    private func slice(at value: Double) -> ChartSlice? {
        var acc = 0.0
        for s in payload.items {
            acc += s.amount
            if value <= acc { return s }
        }
        return payload.items.last
    }

    private var selected: ChartSlice? { payload.items.first { $0.id == selectedId } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    Chart(payload.items) { s in
                        SectorMark(
                            angle: .value("金额", appeared ? s.amount : 0.0001),
                            innerRadius: .ratio(0.56),
                            outerRadius: .ratio(selectedId == s.id ? 1.0 : 0.92),
                            angularInset: 2.5
                        )
                        .cornerRadius(10)
                        .foregroundStyle(Color(hex: s.color))
                        .opacity(selectedId == nil || selectedId == s.id ? 1 : 0.45)
                    }
                    .chartLegend(.hidden)
                    .chartAngleSelection(value: $selectedValue)
                    .onChange(of: selectedValue) { _, newValue in
                        if let v = newValue {
                            withAnimation(.spring(duration: 0.35)) { selectedId = slice(at: v)?.id }
                        }
                    }
                    .chartBackground { proxy in
                        GeometryReader { geo in
                            if let anchor = proxy.plotFrame {
                                let frame = geo[anchor]
                                VStack(spacing: 4) {
                                    Text(selected?.name ?? "总\(payload.unit)")
                                        .font(.system(size: 14, weight: .semibold)).foregroundColor(.secondary)
                                    Text(yuan(selected?.amount ?? payload.total))
                                        .font(.system(size: 22, weight: .heavy, design: .rounded))
                                        .minimumScaleFactor(0.5).lineLimit(1)
                                    if let s = selected, payload.total > 0 {
                                        Text(String(format: "%.1f%%", s.amount / payload.total * 100))
                                            .font(.system(size: 13, weight: .bold)).foregroundColor(.secondary)
                                    }
                                }
                                .frame(width: frame.width * 0.5)
                                .position(x: frame.midX, y: frame.midY)
                            }
                        }
                    }
                    .frame(height: 300)
                    .padding(.top, 8)

                    Text("轻点或拖动扇区查看每个分类")
                        .font(.system(size: 12)).foregroundColor(.secondary)

                    VStack(spacing: 8) {
                        ForEach(payload.items) { s in
                            LegendRow(slice: s, total: payload.total, highlighted: selectedId == s.id)
                                .onTapGesture {
                                    withAnimation(.spring(duration: 0.35)) {
                                        selectedId = (selectedId == s.id) ? nil : s.id
                                    }
                                }
                        }
                    }
                }
                .padding(16)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(payload.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成", action: onClose) }
            }
        }
        .onAppear {
            withAnimation(.spring(duration: 1.0, bounce: 0.25)) { appeared = true }
        }
    }
}

@available(iOS 16.0, *)
struct MacaronBarView: View {
    let payload: ChartPayload
    let onClose: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    Chart(payload.items) { s in
                        BarMark(x: .value("金额", s.amount), y: .value("分类", s.name))
                            .foregroundStyle(Color(hex: s.color))
                            .cornerRadius(6)
                    }
                    .chartLegend(.hidden)
                    .frame(height: CGFloat(max(160, payload.items.count * 40)))
                    VStack(spacing: 8) {
                        ForEach(payload.items) { s in
                            LegendRow(slice: s, total: payload.total, highlighted: false)
                        }
                    }
                }
                .padding(16)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(payload.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成", action: onClose) }
            }
        }
    }
}

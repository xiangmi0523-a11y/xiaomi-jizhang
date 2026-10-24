import UIKit

/// 系统原生液态玻璃底栏（iOS 26 及以上、并且用 Xcode 26 的 SDK 打包时启用）。
/// 页面内容仍然是同一个网页：网页铺在最底下，系统标签栏浮在上面，点按/拖动标签时通知网页切换页面。
enum NativeTabs {
    static var enabled: Bool {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) { return true }
        #endif
        return false
    }
}

final class RootTabController: UITabBarController, UITabBarControllerDelegate {
    private let web: ViewController
    /// 和网页里的 Tab 名字一一对应；中间的 add 是「记一笔」按钮，不会真的被选中
    private let keys = ["home", "stats", "add", "inn", "mine"]
    private var wantHidden = true
    private var accent = UIColor(red: 0.87, green: 0.52, blue: 0.09, alpha: 1)
    private var plusColor = UIColor(red: 1.0, green: 0.73, blue: 0.18, alpha: 1)

    init(web: ViewController) {
        self.web = web
        super.init(nibName: nil, bundle: nil)
        delegate = self
        let items: [(String, String, String)] = [
            ("明细", "book.closed", "book.closed.fill"),
            ("统计", "chart.pie", "chart.pie.fill"),
            ("记一笔", "plus.circle.fill", "plus.circle.fill"),
            ("客栈", "house", "house.fill"),
            ("我的", "cat", "cat.fill")
        ]
        viewControllers = items.enumerated().map { i, it in
            let vc = UIViewController()
            vc.view.backgroundColor = .clear
            vc.view.isUserInteractionEnabled = false
            vc.tabBarItem = UITabBarItem(title: it.0, image: UIImage(systemName: it.1), selectedImage: UIImage(systemName: it.2))
            vc.tabBarItem.tag = i
            return vc
        }
        refreshPlusIcon()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        // 网页铺满整个屏幕，放在标签栏下面
        addChild(web)
        web.view.frame = view.bounds
        web.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(web.view)
        web.didMove(toParent: self)
        web.tabHost = self
        bringTabBarToFront()
        tabBar.tintColor = accent
        // 启动动画放完、网页准备好之前先不显示底栏
        tabBar.alpha = 0
        tabBar.isHidden = true
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        bringTabBarToFront()
    }

    private func bringTabBarToFront() {
        var v: UIView? = tabBar
        while let cur = v, let sup = cur.superview, sup !== view { v = sup }
        if let top = v, top.superview === view { view.bringSubviewToFront(top) }
    }

    /// 中间「记一笔」用主题色的实心加号，保持原色不被标签栏着色
    private func refreshPlusIcon() {
        guard let vcs = viewControllers, vcs.count > 2 else { return }
        let cfg = UIImage.SymbolConfiguration(pointSize: 30, weight: .bold)
            .applying(UIImage.SymbolConfiguration(paletteColors: [.white, plusColor]))
        let img = UIImage(systemName: "plus.circle.fill", withConfiguration: cfg)?.withRenderingMode(.alwaysOriginal)
        let item = vcs[2].tabBarItem
        item?.image = img
        item?.selectedImage = img
        item?.title = nil
        item?.imageInsets = UIEdgeInsets(top: 6, left: 0, bottom: -6, right: 0)
    }

    // MARK: - 标签栏 → 网页

    func tabBarController(_ tabBarController: UITabBarController, shouldSelect viewController: UIViewController) -> Bool {
        if viewController.tabBarItem.tag == 2 {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            web.runJS("window.App && App.A && App.A.add && App.A.add()")
            return false
        }
        return true
    }

    func tabBarController(_ tabBarController: UITabBarController, didSelect viewController: UIViewController) {
        let key = keys[viewController.tabBarItem.tag]
        web.runJS("window.App && App.nativeTab && App.nativeTab('\(key)')")
    }

    // MARK: - 网页 → 标签栏

    func select(key: String) {
        guard let i = keys.firstIndex(of: key), i != 2, selectedIndex != i else { return }
        selectedIndex = i
    }

    /// 网页里打开了记账面板、弹层、密码锁等全屏内容时把底栏收起来
    func setBar(hidden: Bool) {
        guard hidden != wantHidden else { return }
        wantHidden = hidden
        if !hidden { tabBar.isHidden = false }
        UIView.animate(withDuration: 0.25, animations: {
            self.tabBar.alpha = hidden ? 0 : 1
            self.tabBar.transform = hidden ? CGAffineTransform(translationX: 0, y: 24) : .identity
        }, completion: { _ in
            if self.wantHidden { self.tabBar.isHidden = true }
        })
    }

    func setAccent(hex: String, plus: String?) {
        if let c = UIColor(hexString: hex) { accent = c; tabBar.tintColor = c }
        if let p = plus, let c = UIColor(hexString: p) { plusColor = c }
        refreshPlusIcon()
    }
}

extension UIColor {
    convenience init?(hexString: String) {
        var s = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }
}

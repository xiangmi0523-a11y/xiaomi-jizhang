/* 晓米记账 · 网页版 / PWA
 * - 离线缓存（sw.js）：装到主屏幕后没网也能打开记账
 * - iOS Safari「分享 → 添加到主屏幕」、安卓 / 电脑 Chrome「安装应用」
 * - App（iOS 原生壳）里不会走这里的任何逻辑
 */
(() => {
  'use strict';
  const App = window.App, UI = App.UI, A = App.A;
  const P = App.pwa = {};
  const native = location.protocol === 'xiaomi:' || !!window.__NATIVE_APP__;
  P.web = !native;
  const ua = navigator.userAgent || '';
  P.ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  P.standalone = () => !!(window.navigator.standalone || (window.matchMedia && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: minimal-ui)').matches)));
  const root = document.documentElement;
  if (P.web) {
    root.classList.add('web');
    if (P.ios) root.classList.add('ios');
    const mark = () => root.classList.toggle('standalone', P.standalone());
    mark();
    try { matchMedia('(display-mode: standalone)').addEventListener('change', mark); } catch (e) { /* 旧版 Safari */ }
  }

  // 状态栏 / 浏览器顶栏颜色跟着 App 的主题和深浅色走
  const syncBar = () => {
    if (!P.web) return;
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim(); if (!bg) return;
    document.querySelectorAll('meta[name="theme-color"]').forEach((m, i) => { if (i) m.remove(); else { m.removeAttribute('media'); m.setAttribute('content', bg); } });
  };
  if (P.web) {
    const at = App.applyTheme;
    App.applyTheme = (...a) => { const r = at.apply(App, a); syncBar(); return r; };
    try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(syncBar, 50)); } catch (e) { /* ignore */ }
    window.addEventListener('load', syncBar);
  }

  // 离线缓存：只在 https（或本机调试）下注册
  if (P.web && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* 不影响使用 */ }); });
  }

  // Chrome / Edge：浏览器准备好「安装」时会发这个事件，先存起来，用户点按钮再弹
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; if (App.tab === 'mine') App.render(false); });
  window.addEventListener('appinstalled', () => { deferred = null; UI.toast('已安装到桌面，以后从桌面图标打开就是全屏的晓米记账', 3200, 'gold'); if (App.tab === 'mine') App.render(false); });

  P.canShow = () => P.web && !P.standalone();
  P.label = () => deferred ? '一键安装，全屏使用' : (P.ios ? '添加到主屏幕' : '安装成桌面应用');

  A.installApp = async () => {
    if (deferred) {
      const d = deferred; deferred = null;
      try { d.prompt(); const r = await d.userChoice; if (r && r.outcome === 'accepted') return; } catch (e) { /* 走下面的说明 */ }
    }
    const step = (n, t) => `<li><b>${n}</b><span>${t}</span></li>`;
    const share = '<svg class="pw-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11v8a2 2 0 002 2h8a2 2 0 002-2v-8"/></svg>';
    const steps = P.ios
      ? [step(1, `用 <b>Safari</b> 打开这个网页（Chrome 里也可以：点地址栏右边的 ${share}）`), step(2, `点屏幕下方的「分享」按钮 ${share}`), step(3, '往下滑，点「<b>添加到主屏幕</b>」'), step(4, '右上角点「添加」，桌面上就会出现晓米记账的猫咪图标')]
      : [step(1, '点浏览器右上角的「⋮」菜单（电脑上也可以点地址栏右侧的「安装」小图标）'), step(2, '选「<b>安装应用</b>」或「<b>添加到主屏幕</b>」'), step(3, '确认安装，桌面 / 开始菜单里就会出现晓米记账')];
    UI.sheet({
      title: '装到桌面，像 App 一样用', cls: 'compact',
      render: () => `<div class="pw-sheet"><div class="pw-hero"><img src="icons/icon-192.png" alt="" width="64" height="64"><div><b>晓米记账</b><span>全屏打开 · 没网也能记 · 登录后云端同步</span></div></div>
        <ol class="pw-steps">${steps.join('')}</ol>
        <p class="hint">装好以后从桌面图标打开，就没有浏览器的地址栏了。账本跟着账号走，手机、电脑登录同一个账号就能看到同一本账。</p></div>`
    });
  };

  // 桌面快捷方式「记一笔」（manifest shortcuts）：?action=add
  if (P.web && /[?&]action=add\b/.test(location.search)) {
    const go = () => {
      if (App.authGate && App.authGate.el) return setTimeout(go, 800);   // 没登录先登录
      App.afterSplash(() => App.quickAdd());
    };
    window.addEventListener('load', () => setTimeout(go, 300));
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
  }
})();

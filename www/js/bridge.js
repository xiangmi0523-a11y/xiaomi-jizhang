/* 晓米记账 · 阶段六：和 iOS 原生层的桥（桌面小组件数据、快速记一笔） */
(() => {
  'use strict';
  const App = window.App;

  // 每次保存数据时，把小组件要显示的摘要交给原生层（写入 App Group 并刷新小组件）
  const sendWidget = () => {
    try { App.native('widget', { data: JSON.stringify(App.budget.widgetData()) }); } catch (e) { /* ignore */ }
  };
  App.sendWidget = sendWidget;
  const flush = App.flush;
  // 告诉原生层密码锁是否开启：开启时切后台会盖一层遮罩，多任务界面里看不到账本
  let lastPrivacy = null;
  const sendPrivacy = () => { const on = !!(App.S && App.S.settings.pin); if (on !== lastPrivacy) { lastPrivacy = on; App.native('privacy', { on }); } };
  App.flush = () => { flush(); sendWidget(); sendPrivacy(); if (App.backup) App.backup.run(); if (App.remind) App.remind.sync(); };

  // 小组件按钮 / 快捷指令 / 敲击背面 → 原生层调用这里，直接弹出记账面板
  App.quickAdd = () => {
    if (App.UI && App.UI.closeAll) App.UI.closeAll();
    if (App.receipt && App.receipt.close) App.receipt.close();
    if (App.endSplash) App.endSplash(true);   // 从小组件/通知直接记账时不用等启动动画
    App.tab = 'home';
    App.render(false);
    App.openEditor({});
  };

  window.addEventListener('load', () => setTimeout(sendWidget, 1200));
})();

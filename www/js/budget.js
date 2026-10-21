/* 晓米记账 · 阶段四：预算进度条 + 猫咪超支预警 */
(() => {
  'use strict';
  const App = window.App, U = App.U, money = U.money;
  const B = App.budget = {};

  // 0 安全（<80%）/ 1 快破产（≥80%）/ 2 超支（>100%）
  B.level = (spent, total) => (!total ? 0 : spent > total ? 2 : spent >= total * 0.8 ? 1 : 0);
  B.COLORS = ['green', 'yellow', 'red'];

  // 首页那只猫：最近一次新遇见的猫咪，还没有就用橘子
  B.catId = () => {
    const own = App.S.game.cats;
    let best = 'n1', when = '';
    Object.keys(own).forEach(id => { if (App.cats.byId(id) && (own[id].got || '') >= when) { best = id; when = own[id].got || ''; } });
    return best;
  };

  const MSG = ['预算还很充足，继续保持喵~', '快破产啦…省着点花喵', '超支啦！真的不能再买啦！'];

  const barHTML = (spent, total, lv) => {
    const pct = total ? spent / total * 100 : 0;
    return `<div class="bd-bar ${B.COLORS[lv]}"><i style="width:${Math.min(100, pct).toFixed(1)}%"></i><span class="mark"></span></div>`;
  };

  /* ---------- 首页顶部 ---------- */
  B.heroHTML = spent => {
    const total = App.S.budget.total;
    if (!total) {
      return `<button class="bud2 none" data-act="openBudget"><span class="bd-cat">${App.catArt.svg(B.catId(), { head: true, w: 46 })}</span>
        <span class="bd-main"><b>还没有设置每月预算</b><span class="bd-msg">设置后，猫咪会帮你盯着花销 ›</span></span></button>`;
    }
    const lv = B.level(spent, total), remain = total - spent;
    return `<button class="bud2 lv${lv}" data-act="openBudget">
      <span class="bd-cat">${App.catArt.svg(B.catId(), { head: true, w: 52, mood: App.catArt.moodFor(lv) })}</span>
      <span class="bd-main">
        <span class="bd-row"><span>${remain >= 0 ? '本月预算剩余' : '本月已超支'} <b>¥${money(Math.abs(remain))}</b></span><em>${Math.round(spent / total * 100)}%</em></span>
        ${barHTML(spent, total, lv)}
        <span class="bd-msg">${MSG[lv]}</span>
      </span></button>`;
  };

  /* ---------- 预警弹窗：每个月每个等级只提醒一次 ---------- */
  let open = null;
  const showWarn = (lv, spent, total) => {
    if (open) open.remove();
    const el = open = document.createElement('div');
    el.className = 'wn lv' + lv;
    const title = lv === 2 ? '预算超支啦！这个月真的不能再买啦！' : '铲屎官，快破产啦，不能再买啦！';
    const msg = lv === 2
      ? `本月已花 ¥${money(spent)}，超出预算 ¥${money(spent - total)}`
      : `本月已花 ¥${money(spent)}，用掉了预算的 ${Math.round(spent / total * 100)}%，只剩 ¥${money(total - spent)} 啦`;
    el.innerHTML = `<div class="wn-card">
      <div class="wn-cat">${App.catArt.svg(B.catId(), { w: 170, mood: App.catArt.moodFor(lv) })}</div>
      <div class="wn-title">${title}</div>
      <p class="wn-msg">${msg}</p>
      ${barHTML(spent, total, lv)}
      <div class="wn-btns"><button data-wn="budget">调整预算</button><button data-wn="ok" class="ok">我知道了，忍住！</button></div>
    </div>`;
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-wn]');
      if (!b && e.target !== el) return;
      el.classList.add('out'); setTimeout(() => el.remove(), 200); open = null;
      if (b && b.dataset.wn === 'budget' && App.A.openBudget) App.A.openBudget();
    });
    document.body.appendChild(el);
  };

  B.check = () => {
    const total = App.S.budget.total;
    const ym = U.curYM();
    const w = App.S.game.warn || {};
    const prev = w.ym === ym ? (w.lv || 0) : 0;
    const spent = total ? App.sum(App.recordsByMonth(ym)).expense : 0;
    const lv = B.level(spent, total);
    if (w.ym !== ym || lv !== prev) { App.S.game.warn = { ym, lv }; App.changed(); }
    if (lv > prev) showWarn(lv, spent, total);
    return lv;
  };
})();

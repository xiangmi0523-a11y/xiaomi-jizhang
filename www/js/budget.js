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

  // 当前口径：开启智能预算时 = 本月弹性消费 / 弹性额度；否则 = 本月总支出 / 每月预算
  B.current = () => {
    if (App.smart && App.smart.on()) { const m = App.smart.month(); return { spent: m.spent, total: m.quota, smart: true }; }
    return { spent: App.sum(App.recordsByMonth(U.curYM())).expense, total: App.S.budget.total, smart: false };
  };

  /* ---------- 首页顶部 ---------- */
  B.heroHTML = spent => {
    if (App.smart && App.smart.on()) {
      const SB = App.smart, m = SB.month(), t = SB.today(), lv = B.level(m.spent, m.quota);
      const mood = SB.stressed() ? 'angry' : App.catArt.moodFor(lv);
      return `<button class="bud2 smart lv${lv}" data-act="openSmart">
        <span class="bd-cat">${App.catArt.svg(B.catId(), { head: true, w: 52, mood })}</span>
        <span class="bd-main">
          <span class="bd-row"><span>${t.left >= 0 ? '今天还能花' : '今天超出'} <b>¥${money(Math.abs(t.left))}</b></span><em>今日额度 ¥${money(t.allow)}</em></span>
          ${barHTML(m.spent, m.quota, lv)}
          <span class="bd-msg">本月已花 ¥${money(m.spent)} / 可用 ¥${money(m.quota)} · ${m.remain >= 0 ? '预计存下 ¥' + money(m.expectSave) : '已超支 ¥' + money(-m.remain)}</span>
        </span></button>`;
    }
    const total = App.S.budget.total;
    if (!total) {
      return `<button class="bud2 none" data-act="openSmart"><span class="bd-cat">${App.catArt.svg(B.catId(), { head: true, w: 46 })}</span>
        <span class="bd-main"><b>开启智能预算</b><span class="bd-msg">填收入和固定开销，帮你算出每天能花多少 ›</span></span></button>`;
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

  /* ---------- 弹窗队列：多个提醒依次弹，不会叠在一起 ---------- */
  const queue = [];
  let showing = false;
  const pump = () => {
    if (showing || !queue.length) return;
    showing = true;
    document.body.appendChild(queue.shift()());
  };
  B.enqueue = make => { queue.push(make); pump(); };
  B.closeCard = el => {
    if (el._closed) return; el._closed = true;
    el.classList.add('out');
    setTimeout(() => { el.remove(); showing = false; setTimeout(pump, 200); }, 200);
  };

  /* ---------- 预警弹窗：每个月每个等级只提醒一次 ---------- */
  const showWarn = (lv, spent, total, smart) => B.enqueue(() => {
    const el = document.createElement('div');
    el.className = 'wn lv' + lv;
    const what = smart ? '弹性额度' : '预算';
    const title = lv === 2 ? `${what}超支啦！这个月真的不能再买啦！` : '铲屎官，快破产啦，不能再买啦！';
    const msg = lv === 2
      ? `本月已花 ¥${money(spent)}，超出${what} ¥${money(spent - total)}`
      : `本月已花 ¥${money(spent)}，用掉了${what}的 ${Math.round(spent / total * 100)}%，只剩 ¥${money(total - spent)} 啦`;
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
      B.closeCard(el);
      if (b && b.dataset.wn === 'budget') setTimeout(() => (smart ? App.A.openSmart() : App.A.openBudget()), 260);
    });
    return el;
  });

  // 给桌面小组件的摘要（金额单位：元）
  B.widgetData = () => {
    const ym = U.curYM(), cur = B.current(), total = cur.total, spent = cur.spent;
    const id = B.catId(), c = App.cats.byId(id);
    const t = cur.smart ? App.smart.today() : null;
    return {
      hasBudget: total > 0, budget: total / 100, spent: spent / 100, remain: (total - spent) / 100,
      level: B.level(spent, total), catId: id, catName: c ? c.name : '橘子',
      sleeping: !!(App.mood && App.S.game.cats[id] && App.mood.isSleeping(id)),
      coins: App.S.game.coins, monthLabel: U.ymLabel(ym), updated: Date.now(),
      smart: cur.smart, today: t ? t.left / 100 : null
    };
  };

  // 分类预算：某个分类到 80% / 超支时各提醒一次（每月）
  B.catUsed = ym => {
    const used = {};
    App.recordsByMonth(ym).forEach(r => { if (r.type === 'expense') used[r.cat] = (used[r.cat] || 0) + r.amount; });
    return used;
  };
  B.checkCats = () => {
    const cats = App.S.budget.cats || {}, ids = Object.keys(cats).filter(k => cats[k] > 0);
    if (!ids.length) return;
    const ym = U.curYM(), used = B.catUsed(ym), g = App.S.game;
    if (!g.catWarn || g.catWarn.ym !== ym) g.catWarn = { ym, lv: {} };
    let msg = '', worst = 0, changed = false;
    ids.forEach(id => {
      const spent = used[id] || 0, lv = B.level(spent, cats[id]), prev = g.catWarn.lv[id] || 0;
      if (lv !== prev) { g.catWarn.lv[id] = lv; changed = true; }
      if (lv > prev && lv >= worst) {
        worst = lv;
        const c = App.cat(id);
        msg = lv === 2 ? `「${c.name}」本月预算超支啦！已花 ¥${money(spent)} / ¥${money(cats[id])}`
          : `「${c.name}」本月预算已用 ${Math.round(spent / cats[id] * 100)}%，省着点花喵`;
      }
    });
    if (changed) App.flush();
    if (msg) { if (worst === 2 && App.smart) App.smart.nudge(msg); else App.UI.toast(msg, 2800); }
  };

  B.check = () => {
    if (App.smart) App.smart.check();
    B.checkCats();
    const cur = B.current(), total = cur.total;
    const ym = U.curYM();
    const w = App.S.game.warn || {};
    const prev = w.ym === ym ? (w.lv || 0) : 0;
    const spent = total ? cur.spent : 0;
    const lv = B.level(spent, total);
    if (w.ym !== ym || lv !== prev) { App.S.game.warn = { ym, lv }; App.changed(); }
    if (lv > prev) showWarn(lv, spent, total, cur.smart);
    return lv;
  };
})();

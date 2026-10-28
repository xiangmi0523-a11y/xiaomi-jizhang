/* 晓米记账 · 猫咪财务点评：首页猫咪按本月支出比例吐槽、夸奖或鼓励
 * 纯前端规则，只读账本、不写任何数据：不改 App.S、不调用保存或同步，也不发网络请求。 */
(() => {
  'use strict';
  const App = window.App, U = App.U, money = U.money;
  const C = App.critic = {};

  // 每种情况几句话，{pct} 已花比例、{days} 本月已过比例、{left} 剩余、{over} 超出（元）
  const LINES = {
    over: [
      '预算超了 ¥{over}！本喵的猫粮钱都要被你花光了！',
      '已经花到预算的 {pct}%……铲屎官，你的钱包在哭喵',
      '超支 ¥{over} 啦！再买本喵就要离家出走了！'
    ],
    overIncome: [
      '花的比赚的还多 ¥{over}！本喵要出去打工养你了喵',
      '支出已经是收入的 {pct}%，这个月是在倒贴钱喵！'
    ],
    near: [
      '预算用掉 {pct}% 了，只剩 ¥{left}，剁手警告喵！',
      '钱包快见底啦，只剩 ¥{left}，每一笔都要三思喵'
    ],
    nearIncome: [
      '已经花掉收入的 {pct}% 了，再这样就存不下钱喵！'
    ],
    fast: [
      '这个月才过了 {days}%，钱已经花了 {pct}%，跑这么快干嘛喵？',
      '花钱速度比本喵追激光笔还快！慢一点喵'
    ],
    slow: [
      '这个月过了 {days}%，钱才花了 {pct}%，本喵给你点赞！',
      '存钱小能手！照这个节奏，月底还能剩不少喵~',
      '省钱有方，今晚给你加小鱼干喵~'
    ],
    ontrack: [
      '花钱节奏刚刚好，继续保持喵~',
      '过了 {days}% 的日子，花了 {pct}% 的钱，稳稳的喵'
    ],
    zero: [
      '这个月还一分没花，本喵给你颁个省钱小金牌！',
      '一分钱都没花？铲屎官今天也太自律了喵~'
    ],
    nobudget: [
      '还没设预算喵，设一个本喵就能帮你盯着钱包啦'
    ]
  };
  const KIND = { over: 'roast', overIncome: 'roast', near: 'roast', nearIncome: 'roast', fast: 'roast', slow: 'praise', zero: 'praise', ontrack: 'cheer', nobudget: 'cheer' };
  C.LINES = LINES;

  /* 判断规则（金额单位：分）
   *   比较基准：设了预算就用预算（开启智能预算时是弹性额度），没设预算就用本月收入
   *   r = 已花 / 基准，p = 本月已过天数 / 本月天数
   *   没花钱 → 夸奖；r > 100% → 吐槽超支；r ≥ 80% → 吐槽快花完；r 比 p 快 15 个百分点以上 → 吐槽花得快；
   *   r 比 p 慢 10 个百分点以上 → 夸奖；其余 → 鼓励；既没预算也没收入 → 鼓励去设预算 */
  C.judge = ({ spent = 0, total = 0, income = 0, day = 1, dim = 30 }) => {
    const p = Math.min(1, Math.max(0, day / dim));
    const base = total > 0 ? total : income > 0 ? income : 0, byIncome = !(total > 0);
    const out = (key, r) => ({
      key, kind: KIND[key], pct: Math.round((r || 0) * 100), days: Math.round(p * 100),
      left: Math.max(0, base - spent), over: Math.max(0, spent - base), basis: base ? (byIncome ? 'income' : 'budget') : 'none'
    });
    if (spent <= 0) return out('zero', 0);
    if (!base) return out('nobudget', 0);
    const r = spent / base;
    if (r > 1) return out(byIncome ? 'overIncome' : 'over', r);
    if (r >= 0.8) return out(byIncome ? 'nearIncome' : 'near', r);
    if (r > p + 0.15) return out('fast', r);
    if (r <= p - 0.1) return out('slow', r);
    return out('ontrack', r);
  };

  const fill = (s, v) => s.replace('{pct}', v.pct).replace('{days}', v.days).replace('{left}', money(v.left)).replace('{over}', money(v.over));

  // 同一天显示同一句（不会每次刷新都跳），点一下换下一句；换句只记在内存里
  let taps = 0;
  const seed = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };
  C.text = (v, today, n = 0) => { const list = LINES[v.key]; return fill(list[(seed(today + v.key) + n) % list.length], v); };

  // 本月的点评：只读账本和预算设置
  C.now = () => {
    const today = U.today(), ym = today.slice(0, 7), y = +ym.slice(0, 4), m = +ym.slice(5, 7);
    const cur = App.budget.current();
    const income = App.sum(App.recordsByMonth(ym)).income;
    const v = C.judge({ spent: cur.spent, total: cur.total, income, day: +today.slice(8, 10), dim: U.dim(y, m) });
    v.text = C.text(v, today, taps);
    return v;
  };

  // 首页猫咪的表情跟着点评走
  C.mood = v => (v.key === 'over' || v.key === 'overIncome' ? 'angry' : v.kind === 'roast' ? 'worried' : 'happy');

  C.bubbleHTML = v => `<button class="ck ck-${v.kind}" data-act="${v.key === 'nobudget' ? 'openSmart' : 'criticTap'}" aria-label="猫咪点评">${U.esc(v.text)}</button>`;

  App.A.criticTap = el => {
    taps++;
    const v = C.now();
    el.textContent = v.text;
  };
})();

/* 晓米记账 · 阶段一：金币系统 + 每日签到 */
(() => {
  'use strict';
  const App = window.App, U = App.U, UI = App.UI, A = App.A;
  const G = App.game = {};

  const REWARD_RECORD = 10;   // 每成功保存一笔新账单
  const REWARD_SIGN = 50;     // 每日签到
  G.REWARD_RECORD = REWARD_RECORD;
  G.REWARD_SIGN = REWARD_SIGN;

  const st = () => App.S.game;
  G.coins = () => st().coins;

  // 胶囊上显示的数字：金币飞入动画结束后才追上真实数值（null 表示直接显示真实值）
  G.shown = null;
  const shownVal = () => (G.shown == null ? G.coins() : G.shown);

  /* ---------- 金币（CSS 绘制的立体金币） ---------- */
  G.coinHTML = size => `<span class="gcoin" style="--s:${size || 18}px"></span>`;

  /* ---------- 金币胶囊（首页顶部右侧） ---------- */
  G.pillHTML = () =>
    `<button class="coin-pill" data-act="coinPill" aria-label="金币">${G.coinHTML(20)}<b id="coinNum">${shownVal()}</b></button>`;
  A.coinPill = () => UI.toast('每笔记账 +' + REWARD_RECORD + ' · 每日签到 +' + REWARD_SIGN, 1800, 'gold');

  /* ---------- 金币入库动画 ---------- */
  G.fly = (from, n) => {
    const pill = document.querySelector('.coin-pill');
    const r = pill ? pill.getBoundingClientRect() : null;
    const tx = r ? r.left + 16 : window.innerWidth - 70;
    const ty = r ? r.top + r.height / 2 : 40;
    const count = Math.min(6, Math.max(3, Math.round(n / 10)));
    let landed = false, done = 0;
    const land = () => {
      if (landed) return; landed = true;
      G.shown = null;
      const num = document.getElementById('coinNum');
      if (num) num.textContent = G.coins();
      const p = document.querySelector('.coin-pill');
      if (p) { p.classList.remove('bump'); void p.offsetWidth; p.classList.add('bump'); }
    };
    for (let i = 0; i < count; i++) {
      const el = document.createElement('span');
      el.className = 'coin-fly gcoin';
      el.style.left = from.x + 'px'; el.style.top = from.y + 'px';
      document.body.appendChild(el);
      const spread = (Math.random() - 0.5) * 90;
      const dx = tx - from.x, dy = ty - from.y;
      if (!el.animate) { el.remove(); done++; continue; }
      const a = el.animate([
        { transform: 'translate(0px,0px) scale(.5) rotateY(0deg)', opacity: 0 },
        { transform: `translate(${spread}px,-56px) scale(1.15) rotateY(200deg)`, opacity: 1, offset: 0.28 },
        { transform: `translate(${dx}px,${dy}px) scale(.6) rotateY(720deg)`, opacity: 0.95 }
      ], { duration: 820, delay: i * 90, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'both' });
      a.onfinish = () => { el.remove(); if (++done === count) land(); };
    }
    if (done === count) land();
    setTimeout(land, 820 + count * 90 + 600);   // 兜底：动画被系统打断时也保证数字正确
  };

  // 增加金币。from 传入屏幕坐标时播放飞入动画
  G.add = (n, from) => {
    const s = st();
    if (from && G.shown == null) G.shown = s.coins;
    s.coins += n;
    if (!from) G.shown = null;
    App.changed();
    if (from) G.fly(from, n);
  };

  // 保存一笔新账单后调用
  G.rewardRecord = pos => {
    st().progress += 1;      // 记账次数进度（阶段二抽盲盒会用到）
    if (App.mood) App.mood.onRecord();   // 记账让所有猫咪开心一点
    UI.toast('记账成功，获得 ' + REWARD_RECORD + ' 金币', 2000, 'gold');
    G.add(REWARD_RECORD, pos);
  };

  /* ---------- 签到数据 ---------- */
  G.signedToday = () => st().signed.includes(U.today());
  G.streak = () => {
    const set = new Set(st().signed);
    let d = set.has(U.today()) ? U.today() : U.addDays(U.today(), -1), n = 0;
    while (set.has(d)) { n++; d = U.addDays(d, -1); }
    return n;
  };
  const monthCount = ym => st().signed.filter(d => d.slice(0, 7) === ym).length;

  G.signFabHTML = () =>
    `<button class="sign-fab" data-act="openSign" aria-label="每日签到"><span class="sf-ico">📅</span><span class="sf-txt">签到</span>${G.signedToday() ? '' : '<i class="red-dot"></i>'}</button>`;

  /* ---------- 签到卡片 ---------- */
  let wrap = null;

  const cardHTML = () => {
    const now = U.today(), ym = now.slice(0, 7);
    const y = +ym.slice(0, 4), m = +ym.slice(5, 7);
    const ws = App.S.settings.weekStart;
    const lead = (new Date(y, m - 1, 1).getDay() - ws + 7) % 7, dim = U.dim(y, m);
    const set = new Set(st().signed);
    const signed = set.has(now);
    let cells = '';
    for (let i = 0; i < lead; i++) cells += '<i class="sd blank"></i>';
    for (let d = 1; d <= dim; d++) {
      const ds = ym + '-' + U.pad(d);
      const cls = set.has(ds) ? 'on' : ds === now ? 'today' : ds < now ? 'past' : '';
      cells += `<span class="sd ${cls}" data-d="${ds}">${d}</span>`;
    }
    const heads = Array.from({ length: 7 }, (_, k) => `<span>${U.WD[(ws + k) % 7]}</span>`).join('');
    return `<button class="sg-close" data-sg="close" aria-label="关闭">${UI.icons.close}</button>
      <h2 class="sg-title">每日签到</h2>
      <div class="sg-cat"><div class="sg-face">${App.catArt.svg('n1', { head: true, w: 58, mood: signed ? 'happy' : 'normal' })}</div><div class="sg-bubble">${signed ? '今天已经签到啦，明天见喵~' : '今天还没签到喵，快来领金币~'}</div></div>
      <div class="sg-stats">
        <div><b>${G.streak()}</b><span>连续签到(天)</span></div>
        <div><b>${monthCount(ym)}</b><span>本月已签(天)</span></div>
        <div><b>+${REWARD_SIGN}</b><span>每日奖励 ${G.coinHTML(12)}</span></div>
      </div>
      <div class="sg-board"><div class="sg-month">${y}年${m}月</div><div class="sg-week">${heads}</div><div class="sg-grid">${cells}</div></div>
      ${signed ? '<button class="sg-btn off" disabled>明天再来</button>' : `<button class="sg-btn" data-sg="sign">签到领 ${REWARD_SIGN} 金币</button>`}
      <p class="sg-tip">每天限领一次，以手机本地时间 0 点为界</p>`;
  };

  const paint = () => { if (wrap) wrap.querySelector('.sg-card').innerHTML = cardHTML(); };

  const closeSign = () => {
    if (!wrap) return;
    const w = wrap; wrap = null;
    w.classList.add('out');
    setTimeout(() => w.remove(), 180);
  };

  const doSign = () => {
    if (G.signedToday()) return;
    const btn = wrap && wrap.querySelector('.sg-btn');
    const rect = btn ? btn.getBoundingClientRect() : null;
    const s = st();
    s.signed.push(U.today());
    s.signed = Array.from(new Set(s.signed)).sort().slice(-400);
    UI.toast('签到成功，获得 ' + REWARD_SIGN + ' 金币', 2000, 'gold');
    G.add(REWARD_SIGN, rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: window.innerWidth / 2, y: window.innerHeight / 2 });
    paint();
    const cell = wrap && wrap.querySelector('.sd.on[data-d="' + U.today() + '"]');
    if (cell) cell.classList.add('pop');
  };

  A.openSign = () => {
    if (wrap) return;
    const layer = document.getElementById('layer');
    wrap = document.createElement('div');
    wrap.className = 'dlg-wrap sign-wrap';
    wrap.innerHTML = '<div class="mask show"></div><div class="sg-card"></div>';
    layer.appendChild(wrap);
    paint();
    wrap.addEventListener('click', e => {
      if (e.target.classList.contains('mask')) { closeSign(); return; }
      const b = e.target.closest('[data-sg]'); if (!b) return;
      if (b.dataset.sg === 'close') closeSign();
      else if (b.dataset.sg === 'sign') doSign();
    });
  };

  /* ---------- 跨天：按手机本地时间自动刷新红点和卡片 ---------- */
  let lastDay = U.today();
  const checkNewDay = () => {
    const t = U.today();
    if (t === lastDay) return;
    lastDay = t;
    if (App.S) { if (App.mood) App.mood.decay(); App.changed(); paint(); }
  };
  setInterval(checkNewDay, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkNewDay(); });
})();

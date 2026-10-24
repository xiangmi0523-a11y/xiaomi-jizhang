/* 晓米记账 · 阶段五：猫咪心情值 + 喂食 */
(() => {
  'use strict';
  const App = window.App, U = App.U;
  const M = App.mood = {};

  M.DEFAULT = 70;        // 新猫默认心情
  M.COST = 20;           // 一个罐头 20 金币
  M.FEED = 25;           // 喂一次 +25
  M.WAKE = 65;           // 喂过之后至少到这个值（一定会醒）
  M.SLEEP_BELOW = 60;    // 闲置期间心情低于它就会睡着
  M.IDLE_DAYS = 3;       // 连续 3 天不记账开始掉心情
  M.RECORD_BONUS = 5;    // 每记一笔，所有猫 +5

  const cats = () => App.S.game.cats;
  const clamp = v => Math.max(0, Math.min(100, Math.round(v)));
  const owned = () => Object.keys(cats()).filter(id => App.cats.byId(id));

  M.get = id => { const o = cats()[id]; return !o ? 0 : (typeof o.mood === 'number' ? o.mood : M.DEFAULT); };
  const set = (id, v) => { if (cats()[id]) cats()[id].mood = clamp(v); };

  // 最近一次“自己动手记账”的日期（周期记账自动生成的不算）
  M.lastActiveDay = () => {
    let t = 0;
    App.S.records.forEach(r => { if (!r.rec && (r.ts || 0) > t) t = r.ts; });
    if (!t) t = App.S.created || Date.now();
    return U.ymd(new Date(t));
  };
  M.idleDays = () => Math.max(0, Math.round((U.parse(U.today()) - U.parse(M.lastActiveDay())) / 86400000));

  M.isSleeping = id => M.idleDays() >= M.IDLE_DAYS && M.get(id) < M.SLEEP_BELOW;

  M.label = id => {
    if (M.isSleeping(id)) return '饿得睡着了';
    const v = M.get(id);
    return v >= 85 ? '超开心' : v >= 60 ? '心情不错' : v >= 40 ? '有点低落' : '不太开心';
  };

  // 连续 3 天不记账：第 3 天 -20，之后每天 -10（离线多天打开时一次性补算，同一天只算一次）
  M.decay = () => {
    const g = App.S.game, today = U.today(), last = M.lastActiveDay();
    const first = U.addDays(last, M.IDLE_DAYS);
    let changed = false;
    if (M.idleDays() >= M.IDLE_DAYS) {
      let d = first;
      if (g.decayDay && U.addDays(g.decayDay, 1) > d) d = U.addDays(g.decayDay, 1);
      for (; d <= today; d = U.addDays(d, 1)) {
        const amt = d === first ? 20 : 10;
        owned().forEach(id => set(id, M.get(id) - amt));
        changed = true;
      }
    }
    if (g.decayDay !== today) { g.decayDay = today; changed = true; }
    return changed;
  };

  M.bump = n => { owned().forEach(id => set(id, M.get(id) + n)); };
  M.onRecord = () => { owned().forEach(id => set(id, M.get(id) + M.RECORD_BONUS)); };

  // 喂食：返回 'ok' | 'full' | 'poor' | 'none'
  M.feed = id => {
    if (!cats()[id]) return 'none';
    const sleeping = M.isSleeping(id);
    if (!sleeping && M.get(id) >= 100) return 'full';
    if (App.S.game.coins < M.COST) return 'poor';
    App.S.game.coins -= M.COST;
    App.game.shown = null;
    set(id, Math.max(M.get(id) + M.FEED, M.WAKE));
    cats()[id].fed = U.today();
    return 'ok';
  };

  M.FED_LINES = ['好吃！最喜欢铲屎官了~', '罐头万岁！喵呜~', '吃饱饱，精神满满！', '呼噜呼噜…幸福~', '明天也要记得来看我哦'];
  M.HUNGRY_LINE = '饿饿，饭饭';
  M.FULL_LINE = '吃不下啦，已经饱饱的~';

  /* ---------- SVG 罐头 & 爱心 ---------- */
  M.canSVG = (w = 22) => `<svg class="can-svg" width="${w}" height="${w}" viewBox="0 0 40 40" aria-hidden="true">
    <path d="M6 12v17a14 5 0 0 0 28 0V12" fill="#FF8FA3" stroke="#3B2A00" stroke-width="2.6" stroke-linejoin="round"/>
    <path d="M6 18h28" stroke="#3B2A00" stroke-width="1.6" opacity=".35"/>
    <ellipse cx="20" cy="12" rx="14" ry="5" fill="#E8ECF2" stroke="#3B2A00" stroke-width="2.6"/>
    <ellipse cx="20" cy="12" rx="8.5" ry="2.6" fill="none" stroke="#AEB6C2" stroke-width="1.6"/>
    <path d="M13 25q6-5 12 0q-6 5-12 0zM25 25l4-3v6z" fill="#fff" stroke="#3B2A00" stroke-width="1.4" stroke-linejoin="round"/>
    <circle cx="16" cy="24.4" r="1" fill="#3B2A00"/>
  </svg>`;
  M.heartSVG = c => `<svg viewBox="0 0 24 22" aria-hidden="true"><path d="M12 21C5 15.5 1.5 12 1.5 7.2 1.5 3.9 4 1.5 7 1.5c2 0 3.8 1 5 2.8 1.2-1.8 3-2.8 5-2.8 3 0 5.5 2.4 5.5 5.7 0 4.8-3.5 8.3-10.5 13.8z" fill="${c || '#FF6B8B'}" stroke="#3B2A00" stroke-width="1.8" stroke-linejoin="round"/></svg>`;

  // 在某个元素上方冒出一串爱心
  M.hearts = el => {
    if (!el) return;
    const colors = ['#FF6B8B', '#FF8FA3', '#FFB3C1', '#FF6B8B', '#FFC2D1'];
    colors.forEach((c, i) => {
      const h = document.createElement('i');
      h.className = 'heart-fx';
      h.style.setProperty('--hx', ((i - 2) * 16 + (Math.random() * 10 - 5)).toFixed(0) + 'px');
      h.style.animationDelay = (i * 0.09).toFixed(2) + 's';
      h.innerHTML = M.heartSVG(c);
      el.appendChild(h);
      setTimeout(() => h.remove(), 1600 + i * 90);
    });
  };

  // 罐头从按钮飞到猫咪身上
  M.flyCan = (from, to, done) => {
    const el = document.createElement('span');
    el.className = 'can-fly';
    el.innerHTML = M.canSVG(34);
    el.style.left = (from.x - App.ox()) + 'px'; el.style.top = from.y + 'px';
    document.body.appendChild(el);
    const dx = to.x - from.x, dy = to.y - from.y;
    let fin = false;
    const end = () => { if (fin) return; fin = true; el.remove(); if (done) done(); };
    if (!el.animate) { end(); return; }
    const a = el.animate([
      { transform: 'translate(0,0) scale(.6) rotate(0)', opacity: 0 },
      { transform: `translate(${dx * 0.5}px,${dy * 0.5 - 70}px) scale(1.15) rotate(-200deg)`, opacity: 1, offset: 0.5 },
      { transform: `translate(${dx}px,${dy}px) scale(.5) rotate(-360deg)`, opacity: 0.9 }
    ], { duration: 620, easing: 'cubic-bezier(.4,0,.3,1)', fill: 'both' });
    a.onfinish = end;
    setTimeout(end, 1200);
  };
})();

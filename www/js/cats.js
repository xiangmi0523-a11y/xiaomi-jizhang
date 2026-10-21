/* 晓米记账 · 阶段二：猫咪盲盒 + 图鉴 */
(() => {
  'use strict';
  const App = window.App, U = App.U, UI = App.UI, A = App.A, esc = U.esc;
  const C = App.cats = {};

  const FREE_NEED = 5;     // 记账满 5 次可免费开一次
  const COST = 100;        // 否则花 100 金币
  const DUP_REFUND = 30;   // 抽到重复猫咪返还
  C.FREE_NEED = FREE_NEED; C.COST = COST; C.DUP_REFUND = DUP_REFUND;

  C.RARITY = {
    N: { name: '普通', p: 0.6 },
    R: { name: '稀有', p: 0.3 },
    SR: { name: '超稀有', p: 0.1 }
  };

  // 10 只猫：N×5、R×3、SR×2
  C.LIST = [
    { id: 'n1', e: '🐱', name: '橘子', r: 'N', intro: '爱吃小鱼干的橘猫，你每记一笔账，它就开心地打个滚。' },
    { id: 'n2', e: '😺', name: '豆包', r: 'N', intro: '笑眯眯的看门猫，每天第一个跟你说早安。' },
    { id: 'n3', e: '😸', name: '糯米', r: 'N', intro: '软乎乎的米团猫，最喜欢趴在账本上睡午觉。' },
    { id: 'n4', e: '🐈', name: '灰灰', r: 'N', intro: '安静的小灰猫，会趁你不注意偷偷帮你数硬币。' },
    { id: 'n5', e: '😽', name: '麻薯', r: 'N', intro: '黏人的小猫，你存下一块钱它也要亲亲夸你。' },
    { id: 'r1', e: '😼', name: '墨镜', r: 'R', intro: '自称理财大师，口头禅是“该省省，该花花”。' },
    { id: 'r2', e: '🐈‍⬛', name: '煤球', r: 'R', intro: '神秘的小黑猫，据说能找回你花丢的零钱。' },
    { id: 'r3', e: '😻', name: '桃桃', r: 'R', intro: '看到好看的东西就两眼冒心心，记得看紧钱包哦。' },
    { id: 's1', e: '🦁', name: '金鬃', r: 'SR', intro: '晓米客栈的镇店之宝，威风凛凛的狮子猫，守护你的每一分钱。' },
    { id: 's2', e: '🐯', name: '虎妞', r: 'SR', intro: '力气超大的虎斑猫，能一口气扛走一整袋晓米。' }
  ];
  C.byId = id => C.LIST.find(c => c.id === id);

  const gs = () => App.S.game;
  C.ownedCount = () => C.LIST.filter(c => gs().cats[c.id]).length;
  C.freeDraws = () => Math.floor(gs().progress / FREE_NEED);
  C.canDraw = () => gs().progress >= FREE_NEED || gs().coins >= COST;

  C.roll = () => {
    const x = Math.random();
    const r = x < C.RARITY.N.p ? 'N' : x < C.RARITY.N.p + C.RARITY.R.p ? 'R' : 'SR';
    const pool = C.LIST.filter(c => c.r === r);
    return pool[Math.floor(Math.random() * pool.length)];
  };

  /* ---------- 图形：盲盒 / 猫爪 ---------- */
  const boxSVG = () => `<svg class="mbox" viewBox="0 0 200 200" aria-hidden="true">
    <g class="mb-body">
      <rect x="38" y="92" width="124" height="92" rx="12" fill="#FF8FA3" stroke="#3B2A00" stroke-width="6"/>
      <rect x="90" y="92" width="20" height="92" fill="#FFD34D" stroke="#3B2A00" stroke-width="5"/>
      <circle cx="100" cy="140" r="23" fill="#fff" stroke="#3B2A00" stroke-width="5"/>
      <text x="100" y="153" text-anchor="middle" font-size="36" font-weight="900" fill="#FF6B81" font-family="-apple-system,Helvetica,Arial,sans-serif">?</text>
    </g>
    <g class="mb-lid">
      <path d="M50 70 L58 34 L82 62 Z" fill="#FFA5B6" stroke="#3B2A00" stroke-width="5" stroke-linejoin="round"/>
      <path d="M150 70 L142 34 L118 62 Z" fill="#FFA5B6" stroke="#3B2A00" stroke-width="5" stroke-linejoin="round"/>
      <rect x="28" y="64" width="144" height="34" rx="10" fill="#FFA5B6" stroke="#3B2A00" stroke-width="6"/>
      <rect x="90" y="64" width="20" height="34" fill="#FFD34D" stroke="#3B2A00" stroke-width="5"/>
      <path d="M100 66 C86 44 70 50 78 64 Z" fill="#FFD34D" stroke="#3B2A00" stroke-width="5" stroke-linejoin="round"/>
      <path d="M100 66 C114 44 130 50 122 64 Z" fill="#FFD34D" stroke="#3B2A00" stroke-width="5" stroke-linejoin="round"/>
    </g>
  </svg>`;

  const pawSVG = `<svg class="paw" viewBox="0 0 120 210" aria-hidden="true">
    <rect x="30" y="-20" width="60" height="150" rx="28" fill="#FFF3E0" stroke="#3B2A00" stroke-width="6"/>
    <ellipse cx="60" cy="158" rx="48" ry="44" fill="#FFF3E0" stroke="#3B2A00" stroke-width="6"/>
    <ellipse cx="60" cy="170" rx="20" ry="15" fill="#FFB3C1"/>
    <circle cx="28" cy="148" r="8.5" fill="#FFB3C1"/><circle cx="46" cy="131" r="8.5" fill="#FFB3C1"/>
    <circle cx="74" cy="131" r="8.5" fill="#FFB3C1"/><circle cx="92" cy="148" r="8.5" fill="#FFB3C1"/>
  </svg>`;

  /* ---------- 首页：盲盒入口卡片 ---------- */
  C.boxCardHTML = () => {
    const g = gs(), free = C.freeDraws(), rem = g.progress % FREE_NEED;
    const ready = C.canDraw();
    const dots = Array.from({ length: FREE_NEED }, (_, i) => `<i class="${i < rem ? 'on' : ''}"></i>`).join('');
    const sub = free > 0 ? `记账攒够啦，可以免费开 ${free} 次`
      : g.coins >= COST ? `花 ${COST} 金币开一次，或再记 ${FREE_NEED - rem} 笔免费开`
        : `再记 ${FREE_NEED - rem} 笔免费开，或攒够 ${COST} 金币`;
    const btn = free > 0 ? '免费开' : `${App.game.coinHTML(15)}${COST}`;
    return `<div class="box-card${ready ? ' ready' : ''}" data-act="openBox">
      <div class="bx-art">${boxSVG()}</div>
      <div class="bx-main"><b>猫咪盲盒 <em>${C.ownedCount()}/${C.LIST.length}</em></b><span>${sub}</span>
        <div class="bx-dots">${dots}<small>记账进度 ${rem}/${FREE_NEED}</small></div></div>
      <span class="bx-btn">${btn}</span></div>`;
  };

  /* ---------- 开盒 ---------- */
  let overlay = null, timers = [];

  C.draw = () => {
    if (overlay) return;
    const g = gs();
    let pay;
    if (g.progress >= FREE_NEED) { g.progress -= FREE_NEED; pay = 'free'; }
    else if (g.coins >= COST) { g.coins -= COST; pay = 'coins'; }
    else {
      UI.toast(`金币不足（还差 ${COST - g.coins}），再记 ${FREE_NEED - g.progress % FREE_NEED} 笔也能免费开`, 2400);
      return;
    }
    const cat = C.roll();
    const dup = !!g.cats[cat.id];
    App.game.shown = null;
    if (dup) {
      g.cats[cat.id].n = (g.cats[cat.id].n || 1) + 1;
      g.coins += DUP_REFUND;
      App.game.shown = g.coins - DUP_REFUND;   // 返还的金币等动画飞到胶囊里再显示
    } else {
      g.cats[cat.id] = { got: U.today(), n: 1 };
    }
    App.changed();   // 立即保存，动画中途退出也不会丢
    play(cat, dup, pay);
  };
  A.openBox = () => C.draw();

  const later = (ms, fn) => timers.push(setTimeout(fn, ms));

  const play = (cat, dup, pay) => {
    const el = overlay = document.createElement('div');
    el.className = 'gacha r-' + cat.r;
    const sparks = Array.from({ length: 8 }, (_, i) => `<i style="--a:${i * 45}deg;--d:${(i % 3) * 0.12}s">✦</i>`).join('');
    el.innerHTML = `
      <div class="gc-rays"></div><div class="gc-flash"></div>
      <div class="gc-tip">${pay === 'free' ? '用掉 5 次记账进度' : `花了 ${COST} 金币`} · 轻点可跳过</div>
      <div class="gc-stage">
        <div class="gc-paw">${pawSVG}</div>
        <div class="gc-box">${boxSVG()}</div>
        <div class="gc-sparks">${sparks}</div>
        <div class="gc-cat"><span>${cat.e}</span></div>
      </div>
      <div class="gc-result">
        <div class="gc-rar r-${cat.r}">${cat.r} · ${C.RARITY[cat.r].name}</div>
        <div class="gc-name">${dup ? '又遇见了' : '新猫咪'}「${esc(cat.name)}」</div>
        <p class="gc-intro">${esc(cat.intro)}</p>
        ${dup ? `<div class="gc-dup">已经有这只啦，变成金币啦！ +${DUP_REFUND} ${App.game.coinHTML(16)}</div>` : '<div class="gc-new">已收进图鉴 📖</div>'}
        <div class="gc-btns"><button data-gc="close">收下啦</button><button data-gc="again" class="again">再开一次</button></div>
      </div>`;
    document.body.appendChild(el);

    const finish = () => {
      if (el.classList.contains('done')) return;
      timers.forEach(clearTimeout); timers = [];
      el.classList.add('press', 'shake', 'open', 'done');
      const again = el.querySelector('[data-gc="again"]');
      if (again) {
        again.hidden = !C.canDraw();
        again.innerHTML = C.freeDraws() > 0 ? '再开一次 · 免费' : `再开一次 · ${App.game.coinHTML(15)}${COST}`;
      }
      if (dup) {
        UI.toast(`变成金币啦！+${DUP_REFUND} 金币`, 2000, 'gold');
        const r = el.querySelector('.gc-cat').getBoundingClientRect();
        App.game.fly({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, DUP_REFUND);
      }
    };

    requestAnimationFrame(() => el.classList.add('show'));
    later(350, () => el.classList.add('press'));
    later(1200, () => el.classList.add('shake'));
    later(2150, () => el.classList.add('open'));
    later(2750, finish);

    el.addEventListener('click', e => {
      const b = e.target.closest('[data-gc]');
      if (!el.classList.contains('done')) { finish(); return; }
      if (!b) return;
      close();
      if (b.dataset.gc === 'again') setTimeout(C.draw, 260);
    });
  };

  const close = () => {
    if (!overlay) return;
    const el = overlay; overlay = null;
    timers.forEach(clearTimeout); timers = [];
    el.classList.add('out');
    setTimeout(() => el.remove(), 240);
    App.render(true);
  };

  /* ---------- 图鉴页 ---------- */
  const dexRender = () => {
    const own = gs().cats, n = C.ownedCount(), total = C.LIST.length;
    const hero = `<div class="hero slim">
      <div class="hero-top"><h2 class="hero-title">猫咪图鉴</h2><div class="hero-actions">${App.game.pillHTML()}</div></div>
      <div class="dex-prog"><div class="dex-prog-row"><span>已收集</span><b>${n} / ${total}</b></div><div class="bar"><i style="width:${Math.round(n / total * 100)}%"></i></div></div>
    </div>`;
    const cells = C.LIST.map(c => {
      const o = own[c.id];
      if (!o) return `<button class="dex-cell lock" data-act="dexLock"><span class="dx-r">${c.r}</span><span class="dx-q">?</span><b>未解锁</b></button>`;
      return `<button class="dex-cell r-${c.r}" data-act="dexCat" data-id="${c.id}"><span class="dx-r">${c.r}</span><span class="dx-e">${c.e}</span><b>${esc(c.name)}</b>${o.n > 1 ? `<i class="dx-n">×${o.n}</i>` : ''}</button>`;
    }).join('');
    const legend = `<div class="dex-legend">${Object.keys(C.RARITY).map(r => `<span class="rar r-${r}">${r}</span>${C.RARITY[r].name} ${Math.round(C.RARITY[r].p * 100)}%`).join('　')}</div>`;
    return hero + `<div class="body"><div class="dex-grid">${cells}</div>${legend}
      <p class="muted center pad">在「明细」页开猫咪盲盒收集猫咪<br>每记 ${FREE_NEED} 笔账可以免费开一次，也可以花 ${COST} 金币开</p></div>`;
  };
  App.views.dex = { render: dexRender };

  A.dexLock = () => UI.toast('还没遇见这只猫咪，去明细页开盲盒吧');
  A.dexCat = el => {
    const c = C.byId(el.dataset.id), o = gs().cats[c.id];
    if (!c || !o) return;
    UI.sheet({
      title: '猫咪档案', cls: 'compact',
      render: () => `<div class="dex-detail r-${c.r}">
        <div class="dd-art"><div class="dd-glow"></div><span class="dd-e">${c.e}</span></div>
        <div class="dd-name">${esc(c.name)}<span class="rar r-${c.r}">${c.r}</span></div>
        <div class="dd-rar">${C.RARITY[c.r].name}猫咪</div>
        <p class="dd-intro">${esc(c.intro)}</p>
        <div class="dd-meta">${U.dayLabel(o.got)}第一次遇见 · 一共遇见 ${o.n} 次</div>
      </div>`
    });
  };

  // 图鉴 Tab 图标（猫爪）
  UI.icons.dex = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 12.5c-3 0-5.5 2.6-5.5 4.9 0 1.6 1.3 2.6 2.9 2.6.9 0 1.7-.4 2.6-.4s1.7.4 2.6.4c1.6 0 2.9-1 2.9-2.6 0-2.3-2.5-4.9-5.5-4.9z"/><ellipse cx="5.2" cy="10.6" rx="1.7" ry="2.1"/><ellipse cx="9.2" cy="6.6" rx="1.8" ry="2.3"/><ellipse cx="14.8" cy="6.6" rx="1.8" ry="2.3"/><ellipse cx="18.8" cy="10.6" rx="1.7" ry="2.1"/></svg>';
})();

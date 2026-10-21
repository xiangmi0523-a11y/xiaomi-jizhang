/* 晓米记账 · 阶段三：晓米客栈（场景装扮 + 家具商店 + 猫咪互动） */
(() => {
  'use strict';
  const App = window.App, U = App.U, UI = App.UI, A = App.A, esc = U.esc;
  const I = App.inn = { sub: 'scene', pos: null, posKey: '', shuffle: true };

  /* ---------- 槽位（坐标为场景宽高的百分比；anchor b=底部对齐，c=居中） ---------- */
  I.SLOTS = [
    { id: 'wallA', type: 'wall', name: '墙饰位', x: 17, y: 30, w: 64, anchor: 'c' },
    { id: 'wallB', type: 'wall', name: '墙饰位', x: 83, y: 30, w: 64, anchor: 'c' },
    { id: 'corner', type: 'plant', name: '绿植位', x: 11, y: 70, w: 62, anchor: 'b' },
    { id: 'table', type: 'table', name: '桌子位', x: 33, y: 70, w: 92, anchor: 'b' },
    { id: 'sofa', type: 'sofa', name: '沙发位', x: 73, y: 69, w: 108, anchor: 'b' },
    { id: 'rug', type: 'rug', name: '地毯位', x: 50, y: 85, w: 200, anchor: 'c' },
    { id: 'bowl', type: 'bowl', name: '猫碗位', x: 87, y: 95, w: 54, anchor: 'b' }
  ];

  I.ITEMS = [
    { id: 'w_bell', type: 'wall', e: '🎐', name: '风铃', price: 50 },
    { id: 'w_pic', type: 'wall', e: '🖼️', name: '装饰画', price: 60 },
    { id: 'w_clock', type: 'wall', e: '🕰️', name: '挂钟', price: 90 },
    { id: 'w_mirror', type: 'wall', e: '🪞', name: '小镜子', price: 120 },
    { id: 'p_cactus', type: 'plant', e: '🌵', name: '仙人掌', price: 40 },
    { id: 'p_plant', type: 'plant', e: '🪴', name: '绿植', price: 60 },
    { id: 'p_sun', type: 'plant', e: '🌻', name: '向日葵', price: 70 },
    { id: 'p_tree', type: 'plant', e: '🎄', name: '小松树', price: 150 },
    { id: 't_tea', type: 'table', e: '🍵', name: '茶桌', price: 80 },
    { id: 't_cake', type: 'table', e: '🎂', name: '蛋糕桌', price: 100 },
    { id: 't_book', type: 'table', e: '📚', name: '书桌', price: 120 },
    { id: 't_pc', type: 'table', e: '💻', name: '电脑桌', price: 180 },
    { id: 's_chair', type: 'sofa', e: '🪑', name: '木椅', price: 80 },
    { id: 's_sofa', type: 'sofa', e: '🛋️', name: '沙发', price: 200 },
    { id: 's_tv', type: 'sofa', e: '📺', name: '电视', price: 220 },
    { id: 's_bed', type: 'sofa', e: '🛏️', name: '软床', price: 260 },
    { id: 'r_pink', type: 'rug', rug: 'pink', name: '粉色圆毯', price: 80 },
    { id: 'r_check', type: 'rug', rug: 'check', name: '格子地毯', price: 100 },
    { id: 'r_paw', type: 'rug', rug: 'paw', name: '猫爪地毯', price: 150 },
    { id: 'b_box', type: 'bowl', e: '📦', name: '纸箱', price: 30 },
    { id: 'b_bowl', type: 'bowl', e: '🥣', name: '猫碗', price: 30 },
    { id: 'b_yarn', type: 'bowl', e: '🧶', name: '毛线球', price: 40 },
    { id: 'b_fish', type: 'bowl', e: '🐟', name: '小鱼干', price: 50 }
  ];
  const item = id => I.ITEMS.find(x => x.id === id);
  const slot = id => I.SLOTS.find(x => x.id === id);
  const inn = () => App.S.game.inn;

  I.LINES = [
    '有什么需要修的地方可以找我哦~', '今天记账了吗？', '铲屎官今天也辛苦啦！', '又买东西啦？记得记一笔哦~',
    '存钱的你最可爱了喵~', '客栈的金币全靠你啦！', '要不要给客栈添点家具？', '本喵今天心情超好！',
    '小鱼干…好想吃小鱼干…', '月底了，钱包还好吗？', '喵~ 摸摸头就给你好运！', '这个月也要好好存钱哦'
  ];

  // 猫咪在地板上可以待的位置
  const SPOTS = [[39, 79], [59, 79], [20, 87], [76, 85], [48, 97], [68, 98], [10, 99]];   // 彼此间距 ≥ 一只猫的宽度

  /* ---------- 画家具 ---------- */
  const itemArt = (it, w) => {
    if (it.type === 'rug') return `<i class="rug rug-${it.rug}"></i>`;
    const emo = `<span class="it-e" style="font-size:${Math.round(w * (it.type === 'table' ? 0.42 : 0.82))}px">${it.e}</span>`;
    if (it.type === 'table') return `<span class="tbl">${emo}<i class="tbl-top"></i><i class="tbl-leg l"></i><i class="tbl-leg r"></i></span>`;
    return emo;
  };

  const placeStyle = (x, y, anchor) =>
    `left:${x}%;top:${y}%;transform:translate(-50%,${anchor === 'b' ? '-100%' : '-50%'});z-index:${Math.round(y)}`;

  const slotHTML = s => {
    const id = inn().slots[s.id], it = id && item(id);
    const inner = it ? itemArt(it, s.w)
      : `<span class="slot-empty${s.type === 'rug' ? ' wide' : ''}"><b>＋</b><small>${s.name}</small></span>`;
    return `<button class="slot slot-${s.type}${it ? ' filled' : ''}" data-act="innSlot" data-slot="${s.id}" style="${placeStyle(s.x, s.y, s.anchor)};width:${s.w}px">${inner}</button>`;
  };

  /* ---------- 猫咪站位（每次进入客栈随机） ---------- */
  const ownedCats = () => App.cats.LIST.filter(c => App.S.game.cats[c.id]);
  const catPositions = cats => {
    const key = cats.map(c => c.id).join(',');
    if (!I.shuffle && I.pos && I.posKey === key) return I.pos;
    const spots = SPOTS.slice().sort(() => Math.random() - 0.5);
    const pick = cats.slice().sort(() => Math.random() - 0.5).slice(0, spots.length);
    I.pos = pick.map((c, i) => ({ id: c.id, x: spots[i][0], y: spots[i][1], flip: Math.random() < 0.5, d: (Math.random() * 1.6).toFixed(2) }));
    I.posKey = key; I.shuffle = false;
    return I.pos;
  };

  const sceneHTML = () => {
    const cats = ownedCats(), pos = catPositions(cats);
    const catsHTML = pos.map(p => {
      const c = App.cats.byId(p.id);
      return `<button class="inn-cat r-${c.r}" data-act="innCat" data-id="${c.id}" style="${placeStyle(p.x, p.y, 'b')}">${App.catArt.svg(c.id, { w: c.r === 'SR' ? 86 : 76, cls: p.flip ? 'flip' : '' })}<span class="say"></span></button>`;
    }).join('');
    const empty = cats.length ? '' : '<div class="inn-nocat">还没有猫咪入住～<br>去「明细」开个盲盒吧 🎁</div>';
    return `<div class="inn-scene">
      <div class="inn-wall"></div><div class="inn-floor"></div>
      <div class="inn-sign">晓米客栈</div>
      <div class="inn-window"><i></i></div>
      ${I.SLOTS.map(slotHTML).join('')}
      ${catsHTML}${empty}
    </div>`;
  };

  /* ---------- 页面 ---------- */
  const innRender = () => {
    const placed = Object.keys(inn().slots).length, n = App.cats.ownedCount();
    const head = `<div class="hero slim inn-hero">
      <div class="hero-top"><h2 class="hero-title">晓米客栈</h2><div class="hero-actions">${App.game.pillHTML()}</div></div>
      <div class="seg on-accent inn-seg">
        <button data-act="innSub" data-v="scene" class="${I.sub === 'scene' ? 'on' : ''}">🏠 客栈</button>
        <button data-act="innSub" data-v="dex" class="${I.sub === 'dex' ? 'on' : ''}">📖 图鉴 ${n}/${App.cats.LIST.length}</button>
      </div></div>`;
    if (I.sub === 'dex') return head + `<div class="body">${App.cats.dexBodyHTML()}</div>`;
    return head + `<div class="body">${sceneHTML()}
      <div class="inn-info"><span>🛋️ 家具 ${placed}/${I.SLOTS.length}</span><span>🐾 入住猫咪 ${Math.min(n, SPOTS.length)} 只</span></div>
      <p class="muted center pad">点空位去商店买家具，点已摆的家具可以更换<br>点一下猫咪，听听它想说什么</p></div>`;
  };
  App.views.inn = { render: innRender };

  // 每次切到客栈 Tab 时重新随机猫咪站位
  document.addEventListener('click', e => {
    if (e.target.closest && e.target.closest('[data-act="tab"][data-t="inn"]')) I.shuffle = true;
  }, true);

  A.innSub = el => { I.sub = el.dataset.v; App.render(false); };

  /* ---------- 猫咪散步：随机走到地板上的新位置，朝向自动翻转 ---------- */
  const FLOOR = { x0: 12, x1: 88, y0: 77, y1: 98 };
  I.walk = true;
  const posOf = id => (I.pos || []).find(q => q.id === id);
  const arrive = (el, p) => {
    el.classList.remove('moving');
    const art = el.querySelector('.xc'); if (art) art.classList.remove('walk');
    el.style.transition = ''; el.style.zIndex = Math.round(p.y);
    p.next = Date.now() + 2500 + Math.random() * 6000;
  };
  const stepCats = () => {
    if (!I.walk || document.hidden || App.tab !== 'inn' || I.sub !== 'scene') return;
    const sc = document.querySelector('.inn-scene'); if (!sc) return;
    const now = Date.now(), W = sc.clientWidth, H = sc.clientHeight;
    sc.querySelectorAll('.inn-cat').forEach(el => {
      const p = posOf(el.dataset.id);
      if (!p || el.classList.contains('moving') || el.classList.contains('talk')) return;
      if (!p.next) { p.next = now + 800 + Math.random() * 4000; return; }
      if (now < p.next) return;
      const tx = FLOOR.x0 + Math.random() * (FLOOR.x1 - FLOOR.x0), ty = FLOOR.y0 + Math.random() * (FLOOR.y1 - FLOOR.y0);
      const dist = Math.hypot((tx - p.x) / 100 * W, (ty - p.y) / 100 * H);
      if (dist < 30) { p.next = now + 1500; return; }
      const dur = Math.max(1.2, dist / 42);            // 约 42px/秒，慢悠悠地走
      const art = el.querySelector('.xc');
      const right = tx > p.x;
      p.flip = right; art.classList.toggle('flip', right);
      art.classList.add('walk'); el.classList.add('moving');
      el.style.zIndex = Math.round(Math.max(p.y, ty));
      el.style.transition = `left ${dur}s linear, top ${dur}s linear`;
      void el.offsetWidth;
      el.style.left = tx + '%'; el.style.top = ty + '%';
      p.x = tx; p.y = ty; p.next = Infinity;
      clearTimeout(p.end); p.end = setTimeout(() => arrive(el, p), dur * 1000);
    });
  };
  setInterval(stepCats, 700);

  /* ---------- 点猫咪：停下、跳一下、笑眯眯、冒台词 ---------- */
  const sayTimers = new WeakMap();
  I.lineFor = () => I.LINES[Math.floor(Math.random() * I.LINES.length)];
  A.innCat = el => {
    const p = posOf(el.dataset.id), sc = el.closest('.inn-scene'), art = el.querySelector('.xc');
    if (p && el.classList.contains('moving') && sc) {   // 走到一半被点：原地停下
      const cs = getComputedStyle(el);
      p.x = parseFloat(cs.left) / sc.clientWidth * 100; p.y = parseFloat(cs.top) / sc.clientHeight * 100;
      clearTimeout(p.end); el.style.transition = 'none'; el.style.left = p.x + '%'; el.style.top = p.y + '%';
      el.classList.remove('moving'); art.classList.remove('walk');
    }
    if (p) p.next = Date.now() + 4000;
    art.classList.remove('jump'); void art.offsetWidth; art.classList.add('jump', 'happy');
    clearTimeout(art._t); art._t = setTimeout(() => art.classList.remove('jump', 'happy'), 1700);

    const say = el.querySelector('.say');
    say.textContent = I.lineFor();
    if (sc) {   // 气泡别被场景边缘裁掉
      const sr = sc.getBoundingClientRect(), cr = el.getBoundingClientRect(), w = say.offsetWidth;
      const center = cr.left + cr.width / 2, left = center - w / 2;
      const clamped = Math.min(Math.max(left, sr.left + 6), sr.right - 6 - w);
      say.style.setProperty('--dx', Math.round(clamped - left) + 'px');
    }
    document.querySelectorAll('.inn-cat.talk').forEach(x => { if (x !== el) x.classList.remove('talk'); });
    el.classList.add('talk');
    say.classList.add('show');
    clearTimeout(sayTimers.get(el));
    sayTimers.set(el, setTimeout(() => { say.classList.remove('show'); el.classList.remove('talk'); }, 2000));
  };

  /* ---------- 商店 ---------- */
  const popSlot = id => {
    requestAnimationFrame(() => {
      const el = document.querySelector(`.slot[data-slot="${id}"]`);
      if (el) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
    });
  };

  const place = (slotId, itemId) => {
    const slots = inn().slots;
    Object.keys(slots).forEach(k => { if (slots[k] === itemId) delete slots[k]; });   // 同一件家具只摆一处
    slots[slotId] = itemId;
  };

  A.innSlot = el => {
    const s = slot(el.dataset.slot);
    if (!s) return;
    const h = UI.sheet({
      title: s.name + ' · 家具商店', cls: 'tall shop-sheet', autoRefresh: true,
      render: () => {
        const cur = inn().slots[s.id];
        const list = I.ITEMS.filter(x => x.type === s.type);
        return `<div class="shop-coins">我的金币 ${App.game.coinHTML(18)}<b>${App.game.coins()}</b></div>
          <div class="shop-grid">${list.map(it => {
            const own = inn().owned.includes(it.id), here = cur === it.id;
            const elsewhere = own && !here && Object.keys(inn().slots).find(k => inn().slots[k] === it.id);
            const tag = here ? '<span class="sp-tag on">已摆放</span>'
              : own ? `<span class="sp-tag own">${elsewhere ? '移到这里' : '已拥有 · 摆放'}</span>`
                : `<span class="sp-price${App.game.coins() < it.price ? ' poor' : ''}">${App.game.coinHTML(15)}${it.price}</span>`;
            return `<button class="shop-item${here ? ' cur' : ''}" data-buy="${it.id}"><span class="sp-art sp-${it.type}">${itemArt(it, it.type === 'rug' ? 110 : 64)}</span><b>${esc(it.name)}</b>${tag}</button>`;
          }).join('')}</div>
          ${cur ? '<button class="btn ghost wide" data-buy="__remove">收起这件家具（放回仓库，可随时免费再摆）</button>' : ''}
          <p class="hint center">买过的家具会一直留在仓库里，换着摆不用再花钱</p>`;
      },
      onMount: hh => {
        hh.body.addEventListener('click', e => {
          const b = e.target.closest('[data-buy]'); if (!b) return;
          const id = b.dataset.buy, cur = inn().slots[s.id];
          if (id === '__remove') {
            delete inn().slots[s.id]; App.changed(); hh.close(); UI.toast('已收进仓库'); return;
          }
          const it = item(id);
          if (cur === id) { UI.toast('已经摆在这里啦'); return; }
          if (inn().owned.includes(id)) {
            place(s.id, id); App.changed(); hh.close(); popSlot(s.id); UI.toast('已摆好：' + it.name); return;
          }
          if (App.game.coins() < it.price) { UI.toast(`金币不足（还差 ${it.price - App.game.coins()}），多记账、签到就能攒到哦`, 2400); return; }
          App.S.game.coins -= it.price;
          App.game.shown = null;
          inn().owned.push(id);
          place(s.id, id);
          App.changed(); hh.close(); popSlot(s.id);
          UI.toast(`购买成功！${it.name}已经摆好啦`, 2000, 'gold');
        });
      }
    });
    return h;
  };

  // 底栏图标：小房子
  UI.icons.inn = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/></svg>';
})();

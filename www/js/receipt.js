/* 晓米记账 · 每日小票：打印机吐出一张猫咪主题的收支小票，可以翻日期、换纸、保存成图片 */
(() => {
  'use strict';
  const App = window.App, U = App.U, UI = App.UI, A = App.A, esc = U.esc, money = U.money;
  const RC = App.receipt = {};
  const SKINS = { cream: '奶油纸', pink: '樱花纸', mint: '薄荷纸' };
  let uid = 0;

  const skin = () => (SKINS[App.S.settings.rcSkin] ? App.S.settings.rcSkin : 'cream');
  const dayRecs = d => App.sortDesc(App.S.records.filter(r => r.date === d)).reverse();
  const hhmm = r => {
    if (!r.ts) return '';
    const t = new Date(r.ts);
    return U.ymd(t) === r.date ? U.pad(t.getHours()) + ':' + U.pad(t.getMinutes()) : '';
  };

  /* ---------- 小图案 ---------- */
  const paw = (c, s = 12) => `<svg class="rc-paw" width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true"><g fill="${c}"><ellipse cx="12" cy="15.5" rx="5.2" ry="4.4"/><ellipse cx="5.6" cy="10.4" rx="2.2" ry="2.7"/><ellipse cx="9.6" cy="6.4" rx="2.3" ry="2.9"/><ellipse cx="14.4" cy="6.4" rx="2.3" ry="2.9"/><ellipse cx="18.4" cy="10.4" rx="2.2" ry="2.7"/></g></svg>`;

  const stamp = (text, k) => {
    const id = 'rcp' + k, f = 'rcf' + k;
    return `<svg class="rc-stamp" viewBox="0 0 120 120" aria-hidden="true">
      <defs>
        <path id="${id}" d="M60,60 m-42,0 a42,42 0 1,1 84,0 a42,42 0 1,1 -84,0"/>
        <filter id="${f}"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="1.8"/></filter>
      </defs>
      <g filter="url(#${f})" fill="none" stroke="#DE5446">
        <circle cx="60" cy="60" r="55" stroke-width="4"/>
        <circle cx="60" cy="60" r="49" stroke-width="1.4"/>
        <circle cx="60" cy="60" r="31" stroke-width="1.4" stroke-dasharray="2.5 3"/>
        <text font-size="10.5" font-weight="900" fill="#DE5446" stroke="none" letter-spacing="2.2"><textPath href="#${id}">${esc(text)} ✦ XIAOMI INN ✦</textPath></text>
        <g fill="#DE5446" stroke="none" transform="translate(60 61) scale(1.15)">
          <ellipse cx="0" cy="5" rx="9" ry="7.5"/><ellipse cx="-11" cy="-4.5" rx="3.6" ry="4.6"/><ellipse cx="-4.2" cy="-11" rx="3.8" ry="4.8"/><ellipse cx="4.2" cy="-11" rx="3.8" ry="4.8"/><ellipse cx="11" cy="-4.5" rx="3.6" ry="4.6"/>
        </g>
      </g>
    </svg>`;
  };

  // 趴在小票边上的猫：头 + 两只搭在纸上的爪子
  const peek = id => {
    const L = (App.catArt.LOOKS || {})[id] || { white: '#FFF6E6', ol: '#5A2E1A' };
    const pawSvg = `<svg class="rc-pp" viewBox="0 0 40 26" aria-hidden="true"><ellipse cx="20" cy="15" rx="16" ry="10" fill="${L.white}" stroke="${L.ol}" stroke-width="3.2"/><path d="M14 19v4M20 20v4M26 19v4" stroke="${L.ol}" stroke-width="2" stroke-linecap="round"/></svg>`;
    return `<div class="rc-peek"><div class="rc-peek-head">${App.catArt.svg(id, { head: true, w: 92, mood: 'happy' })}</div><div class="rc-peek-paws">${pawSvg}${pawSvg}</div></div>`;
  };

  const quoteFor = (recs, s, d) => {
    if (!recs.length) return '今天一分钱都没花，猫咪为你鼓掌！';
    if (App.smart && App.smart.on() && d.slice(0, 7) === U.curYM()) {
      const x = App.smart.dayInfo(d);
      if (x.spent > x.allow) return '今天超出额度啦，明天少喝一杯奶茶吧喵～';
      return `今天没超出额度，省下 ¥${money(x.allow - x.spent)}，真棒！`;
    }
    if (s.income > s.expense) return '今天赚得比花得多，存钱罐鼓起来啦～';
    if (s.expense === 0) return '今天只有收入没有支出，完美的一天！';
    return '每一笔都记下来，钱就不会悄悄溜走喵～';
  };

  /* ---------- 小票本体 ---------- */
  RC.paperHTML = d => {
    const k = ++uid, recs = dayRecs(d), s = App.sum(recs);
    const catId = App.budget.catId(), cat = App.cats.byId(catId);
    const no = 'XM' + d.replace(/-/g, '') + '-' + U.pad(recs.length);
    const LINE = 'var(--rc-line)';
    const rows = recs.slice(0, 14).map(r => {
      const isT = r.type === 'transfer', c = isT ? { icon: '🔁', name: '转账' } : App.cat(r.cat);
      const acc = isT ? App.accName(r.acc) + '→' + App.accName(r.to) : App.accName(r.acc);
      const sign = r.type === 'income' ? '+' : r.type === 'expense' ? '-' : '';
      const t = hhmm(r);
      return `<div class="rc-tr"><span class="it"><i>${c.icon}</i><span><b>${esc(c.name)}</b>${r.note || t ? `<small>${esc([t, r.note].filter(Boolean).join(' · '))}</small>` : ''}</span></span><span class="ac">${esc(acc)}</span><span class="amt ${r.type}">${sign}${money(r.amount)}</span></div>`;
    }).join('');
    const more = recs.length > 14 ? `<div class="rc-more">…还有 ${recs.length - 14} 笔，没印下啦</div>` : '';
    const smart = App.smart && App.smart.on() && d.slice(0, 7) === U.curYM() ? App.smart.dayInfo(d) : null;
    const bal = s.income - s.expense;
    const pawsRow = Array.from({ length: 13 }, (_, i) => paw('var(--rc-ink)', i % 3 === 1 ? 15 : i % 2 ? 10 : 12)).join('');
    return `<div class="rc-sheet"><div class="rc-paper">
      <div class="rc-holes">${'<i></i>'.repeat(7)}</div>
      <div class="rc-head">
        <span class="rc-logo">${App.catArt.svg(catId, { head: true, w: 40 })}</span>
        <span class="rc-title"><b>晓米客栈</b><small>XIAOMI INN · 每日消费小票</small></span>
      </div>
      <div class="rc-sep">${paw(LINE, 13)}</div>
      <div class="rc-meta">
        <span>单号：${no}</span><span>收银员：${esc(cat ? cat.name : '橘子')}喵</span>
        <span>日期：${d.replace(/-/g, '.')} 周${U.WD[U.wd(d)]}</span><span>${recs.length} 笔</span>
      </div>
      ${recs.length ? `<div class="rc-table"><div class="rc-th"><span>消费项目</span><span>账户</span><span>金额</span></div>${rows}${more}</div>`
        : `<div class="rc-empty">${App.catArt.svg(catId, { w: 128, sleep: true })}<p>今天还没有记账喵～</p></div>`}
      <div class="rc-sep">${paw(LINE, 13)}</div>
      <div class="rc-sum">
        <div><span>消费合计（${recs.filter(r => r.type === 'expense').length} 笔）</span><b>¥${money(s.expense)}</b></div>
        <div><span>今日收入</span><b>¥${money(s.income)}</b></div>
        ${smart ? `<div><span>今日额度</span><b>¥${money(smart.allow)}</b></div>` : ''}
        <div class="total"><span>今日结余</span><b class="${bal < 0 ? 'neg' : 'pos'}">${bal < 0 ? '-' : ''}¥${money(Math.abs(bal))}</b></div>
      </div>
      <div class="rc-quote"><span>“</span>${esc(quoteFor(recs, s, d))}<span>”</span></div>
      <div class="rc-code"><div class="rc-pawbar">${pawsRow}</div><small>${d.replace(/-/g, '')} ${U.pad(recs.length)}${U.pad(Math.round(s.expense / 100) % 100)} ✦ ${App.S.records.length}</small></div>
      <div class="rc-thanks">— 谢谢惠顾 · 明天也要来记账喵 —</div>
      ${stamp(recs.length ? '今日已记账' : '今日零消费', k)}
    </div>
    <div class="rc-tear"></div></div>
    ${peek(catId)}`;
  };

  /* ---------- 弹层 ---------- */
  let wrap = null, cur = '';

  const paint = (animate = true) => {
    if (!wrap) return;
    wrap.className = 'rc-wrap skin-' + skin() + (animate ? ' printing' : '');
    wrap.querySelector('.rc-nav b').textContent = `${U.dayLabel(cur)} 周${U.WD[U.wd(cur)]}`;
    wrap.querySelector('[data-rc="next"]').disabled = cur >= U.today();
    wrap.querySelector('.rc-shot').innerHTML = RC.paperHTML(cur);
    wrap.querySelector('.rc-scroll').scrollTop = 0;
  };

  RC.open = d => {
    cur = d || U.today();
    if (wrap) { paint(); return; }
    wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="rc-top">
        <button class="rc-btn" data-rc="close" aria-label="关闭">${UI.icons.close}</button>
        <div class="rc-nav"><button data-rc="prev" aria-label="前一天">${UI.icons.back}</button><b></b><button data-rc="next" aria-label="后一天">${UI.icons.chev}</button></div>
        <button class="rc-btn rc-skinbtn" data-rc="skin">换纸</button>
      </div>
      <div class="rc-scroll">
        <div class="rc-printer"><span class="rc-led"></span><span class="rc-brand">晓米 · 小票机</span><div class="rc-slot"></div></div>
        <div class="rc-clip"><div class="rc-shot"></div></div>
      </div>
      <div class="rc-actions"><button data-rc="reprint">🖨️ 再打印一次</button><button data-rc="save" class="ok">保存图片</button></div>`;
    document.body.appendChild(wrap);
    paint();
    wrap.addEventListener('click', e => {
      const b = e.target.closest('[data-rc]'); if (!b) return;
      const a = b.dataset.rc;
      if (a === 'close') RC.close();
      else if (a === 'prev') { cur = U.addDays(cur, -1); paint(); }
      else if (a === 'next') { if (cur < U.today()) { cur = U.addDays(cur, 1); paint(); } }
      else if (a === 'reprint') paint();
      else if (a === 'skin') {
        const keys = Object.keys(SKINS), nx = keys[(keys.indexOf(skin()) + 1) % keys.length];
        App.S.settings.rcSkin = nx; App.flush(); paint(false); UI.toast('换成「' + SKINS[nx] + '」');
      } else if (a === 'save') RC.save();
    });
  };

  RC.close = () => {
    if (!wrap) return;
    const w = wrap; wrap = null; box = null;
    w.classList.add('out');
    setTimeout(() => w.remove(), 220);
  };

  // 保存图片：把小票复制一份平铺到纯色背景上、缩放到一屏内，再让原生层截图并弹出分享面板（可存到相册）
  let box = null;
  RC.save = () => {
    if (!window.__NATIVE_APP__) { UI.toast('网页版请直接截屏保存小票（iPhone：侧边键 + 音量上键）', 3200); return; }
    if (box) return;
    const src = wrap.querySelector('.rc-shot');
    wrap.classList.remove('printing');
    box = document.createElement('div');
    box.className = 'rc-snapbox';
    const clone = src.cloneNode(true);
    clone.style.width = src.offsetWidth + 'px';
    box.appendChild(clone);
    wrap.appendChild(box);
    const sc = Math.min(1, (window.innerHeight - 36) / clone.offsetHeight);
    clone.style.transform = `scale(${sc.toFixed(3)})`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const r = clone.getBoundingClientRect(), pad = 18 * sc;
      App.native('receiptShot', { x: Math.max(0, r.left - pad), y: Math.max(0, r.top - pad / 2), w: r.width + pad * 2, h: r.height + pad });
      clearTimeout(RC._t);
      RC._t = setTimeout(() => RC.onShot(true), 4000);   // 兜底：原生没回调也恢复界面
    }));
  };
  RC.onShot = ok => {
    clearTimeout(RC._t);
    if (box) { box.remove(); box = null; }
    if (!ok) UI.toast('截图失败了，再试一次喵');
  };

  A.openReceipt = el => RC.open(el && el.dataset && el.dataset.d);
  UI.icons.receipt = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21z"/><path d="M9 8h6M9 12h6M9 16h3.5"/></svg>';
})();

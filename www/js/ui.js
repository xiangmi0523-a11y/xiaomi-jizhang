/* 晓米记账 · 界面基础：图标、弹层、对话框、提示 */
(() => {
  'use strict';
  const App = window.App, U = App.U, esc = U.esc;
  const UI = App.UI = {};

  const ic = d => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  UI.icons = {
    home: ic('<path class="tf" d="M6 3.5h11.5a1.5 1.5 0 011.5 1.5v14.5a1.5 1.5 0 01-1.5 1.5H6a1.5 1.5 0 01-1.5-1.5V5A1.5 1.5 0 016 3.5z"/><path d="M8.5 3.5v17"/><path d="M11.5 8.5h4.5M11.5 12h4.5M11.5 15.5h2.5"/>'),
    stats: ic('<path class="tf" d="M13 3.2v8.8h8.8A8.8 8.8 0 0013 3.2z"/><path d="M10.6 5.6a8 8 0 108.8 8.8h-8.8z"/>'),
    assets: ic('<path d="M3 8a2 2 0 012-2h13a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/><path d="M3 8l11-3.5V6"/><circle cx="16.5" cy="13" r="1.2"/>'),
    mine: ic('<path class="tf" d="M4.5 4.5l4 3.4a10 10 0 017 0l4-3.4.6 8.1c.3 4.6-3.4 8-8.1 8s-8.4-3.4-8.1-8z"/><circle cx="9.3" cy="13" r="1" fill="currentColor" stroke="none"/><circle cx="14.7" cy="13" r="1" fill="currentColor" stroke="none"/><path d="M11 15.6c.6.5 1.4.5 2 0"/>'),
    plus: ic('<path d="M12 5v14M5 12h14"/>'),
    search: ic('<circle cx="11" cy="11" r="6.5"/><path d="M20.5 20.5L16 16"/>'),
    cal: ic('<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
    list: ic('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
    close: ic('<path d="M6 6l12 12M18 6L6 18"/>'),
    back: ic('<path d="M15 5l-7 7 7 7"/>'),
    chev: ic('<path d="M9 5l7 7-7 7"/>'),
    down: ic('<path d="M6 9l6 6 6-6"/>'),
    trash: ic('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/>'),
    swap: ic('<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>'),
    up: ic('<path d="M6 15l6-6 6 6"/>'),
    check: ic('<path d="M5 12.5l4.5 4.5L19 7.5"/>')
  };

  /* ---------- 奶油马卡龙风的小装饰（猫爪、爱心、星星、金币堆、小猪、波浪边） ---------- */
  const sv = (vb, body, cls) => `<svg class="dc ${cls || ''}" viewBox="${vb}" aria-hidden="true">${body}</svg>`;
  UI.deco = {
    paw: (cls = '') => sv('0 0 24 24', '<g fill="currentColor"><ellipse cx="12" cy="15.6" rx="5" ry="4.2"/><ellipse cx="5.6" cy="10.6" rx="2.1" ry="2.6"/><ellipse cx="9.6" cy="6.6" rx="2.2" ry="2.8"/><ellipse cx="14.4" cy="6.6" rx="2.2" ry="2.8"/><ellipse cx="18.4" cy="10.6" rx="2.1" ry="2.6"/></g>', cls),
    pawLine: (cls = '') => sv('0 0 24 24', '<g fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 11.6c-2.9 0-5 2.4-5 4.4 0 1.6 1.2 2.5 2.7 2.5.9 0 1.5-.4 2.3-.4s1.4.4 2.3.4c1.5 0 2.7-.9 2.7-2.5 0-2-2.1-4.4-5-4.4z"/><ellipse cx="5.8" cy="10.4" rx="1.7" ry="2.1"/><ellipse cx="9.5" cy="6.6" rx="1.8" ry="2.3"/><ellipse cx="14.5" cy="6.6" rx="1.8" ry="2.3"/><ellipse cx="18.2" cy="10.4" rx="1.7" ry="2.1"/></g>', cls),
    heart: (cls = '') => sv('0 0 24 22', '<path d="M12 19.5C6 15 2.6 12 2.6 7.8 2.6 5 4.8 2.8 7.4 2.8c1.8 0 3.4.9 4.6 2.6 1.2-1.7 2.8-2.6 4.6-2.6 2.6 0 4.8 2.2 4.8 5 0 4.2-3.4 7.2-9.4 11.7z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>', cls),
    spark: (cls = '') => sv('0 0 24 24', '<path d="M12 2.5c.6 4.6 2.9 6.9 7.5 7.5-4.6.6-6.9 2.9-7.5 7.5-.6-4.6-2.9-6.9-7.5-7.5 4.6-.6 6.9-2.9 7.5-7.5z" fill="currentColor"/>', cls),
    coins: (cls = '') => sv('0 0 40 40', '<g stroke="#C9922F" stroke-width="1.8"><ellipse cx="17" cy="31" rx="11" ry="4.2" fill="#FBD678"/><path d="M6 25v6M28 25v6" /><ellipse cx="17" cy="25" rx="11" ry="4.2" fill="#FFE29A"/><path d="M6 19v6M28 19v6"/><ellipse cx="17" cy="19" rx="11" ry="4.2" fill="#FFE9B0"/><circle cx="29" cy="14" r="7.2" fill="#FFE29A"/></g><text x="29" y="17.6" text-anchor="middle" font-size="9.5" font-weight="900" fill="#C9922F" font-family="-apple-system,PingFang SC,sans-serif">¥</text>', cls),
    piggy: (cls = '') => sv('0 0 40 40', '<g stroke="#C98B5A" stroke-width="1.8" stroke-linejoin="round"><path d="M8 21c0-6.6 5.6-11 13-11 4.4 0 8 1.6 10.2 4.2l3.3-1.4-.8 4.6c.8 1.2 1.3 2.6 1.3 4.1 0 3.4-2 6.2-5 7.8V33h-4.4v-2.4c-1.4.3-3 .4-4.6.2V33h-4.4v-3.6C12 27.8 8 25 8 21z" fill="#F9DDBE"/><path d="M8.2 19.6c-2 0-3.2-1.2-3.2-2.6" fill="none"/><path d="M17 10.6c.6-2 2.2-3.4 4.2-3.4" fill="none"/></g><circle cx="28" cy="18" r="1.4" fill="#8A5A34"/><path d="M18 13.2h5.6" stroke="#C98B5A" stroke-width="1.8" stroke-linecap="round"/>', cls),
    purse: (cls = '') => sv('0 0 44 36', '<g stroke="#7A4A22" stroke-width="2.2" stroke-linejoin="round"><path d="M6 12.5c0-2.6 2-4.5 4.6-4.5h22.8c2.6 0 4.6 1.9 4.6 4.5V28c0 2.6-2 4.5-4.6 4.5H10.6C8 32.5 6 30.6 6 28z" fill="#E8913A"/><path d="M6 15h32" fill="none" opacity=".45"/><path d="M13 8c1-3.4 4.6-5 9-5s8 1.6 9 5" fill="none"/></g><g fill="#FFE9C8"><ellipse cx="22" cy="24.4" rx="3.6" ry="3"/><circle cx="17.4" cy="20.6" r="1.4"/><circle cx="20.2" cy="18.6" r="1.4"/><circle cx="23.8" cy="18.6" r="1.4"/><circle cx="26.6" cy="20.6" r="1.4"/></g>', cls),
    wave: (cls = '') => `<svg class="dc ${cls}" viewBox="0 0 320 16" preserveAspectRatio="none" aria-hidden="true"><path d="M0 16V9c26-9 54-9 80-2s54 9 80 1 54-10 80-2 54 9 80 2v8z" fill="currentColor"/><path d="M0 9c26-9 54-9 80-2s54 9 80 1 54-10 80-2 54 9 80 2" fill="none" stroke="var(--edge)" stroke-width="1.6"/></svg>`
  };

  /* ---------- 轻提示 ---------- */
  UI.toast = (msg, ms, cls) => {
    const t = document.getElementById('toast');
    t.classList.toggle('gold', cls === 'gold');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(UI._tt);
    UI._tt = setTimeout(() => t.classList.remove('show'), ms || 1800);
  };

  /* ---------- 底部弹层 ---------- */
  UI.sheet = opt => {
    const layer = document.getElementById('layer');
    const mask = document.createElement('div'); mask.className = 'mask';
    const el = document.createElement('div');
    el.className = 'sheet' + (opt.full ? ' full' : '') + (opt.cls ? ' ' + opt.cls : '');
    el.innerHTML = (opt.bare ? '' :
      `<div class="sheet-head"><button class="icon-btn" data-act="sheetClose" aria-label="关闭">${UI.icons.close}</button>` +
      `<h3 class="sheet-title">${esc(opt.title || '')}</h3><div class="sheet-right">${opt.right || ''}</div></div>`) +
      '<div class="sheet-body"></div>';
    const body = el.querySelector('.sheet-body');
    const h = {
      el, body, mask, opt, closed: false,
      update() { if (opt.render) { body.innerHTML = opt.render(h); } if (opt.onUpdate) opt.onUpdate(h); },
      close() {
        if (h.closed) return; h.closed = true;
        App.sheets = App.sheets.filter(x => x !== h);
        mask.classList.remove('show'); el.classList.remove('show');
        setTimeout(() => { mask.remove(); el.remove(); }, 230);
        if (opt.onClose) opt.onClose(h);
      }
    };
    el._h = h;
    mask.addEventListener('click', () => { if (opt.maskClose !== false) h.close(); });
    layer.appendChild(mask); layer.appendChild(el);
    App.sheets.push(h);
    h.update();
    if (opt.onMount) opt.onMount(h);
    requestAnimationFrame(() => requestAnimationFrame(() => { mask.classList.add('show'); el.classList.add('show'); }));
    return h;
  };
  UI.closeAll = () => { App.sheets.slice().forEach(h => h.close()); };

  /* ---------- 对话框 ---------- */
  UI.confirm = o => new Promise(res => {
    const layer = document.getElementById('layer');
    const wrap = document.createElement('div'); wrap.className = 'dlg-wrap';
    wrap.innerHTML = `<div class="mask show"></div><div class="dlg"><h4>${esc(o.title || '')}</h4>` +
      (o.msg ? `<p>${esc(o.msg)}</p>` : '') +
      `<div class="dlg-btns"><button data-r="0">${esc(o.cancel || '取消')}</button>` +
      `<button data-r="1" class="${o.danger ? 'danger' : 'primary'}">${esc(o.ok || '确定')}</button></div></div>`;
    wrap.addEventListener('click', e => {
      const b = e.target.closest('[data-r]'); if (!b) return;
      wrap.remove(); res(b.dataset.r === '1');
    });
    layer.appendChild(wrap);
  });

  UI.prompt = o => new Promise(res => {
    const layer = document.getElementById('layer');
    const wrap = document.createElement('div'); wrap.className = 'dlg-wrap';
    wrap.innerHTML = `<div class="mask show"></div><div class="dlg"><h4>${esc(o.title || '')}</h4>` +
      `<input class="dlg-input" type="text" maxlength="${o.max || 20}" value="${esc(o.value || '')}" placeholder="${esc(o.placeholder || '')}">` +
      `<div class="dlg-btns"><button data-r="0">取消</button><button data-r="1" class="primary">${esc(o.ok || '确定')}</button></div></div>`;
    const input = wrap.querySelector('input');
    wrap.addEventListener('click', e => {
      const b = e.target.closest('[data-r]'); if (!b) return;
      const v = input.value.trim(); wrap.remove();
      res(b.dataset.r === '1' ? v : null);
    });
    layer.appendChild(wrap);
    setTimeout(() => { try { input.focus(); } catch (e) { /* ignore */ } }, 60);
  });

  // 单选列表：items = [{value,label,icon,sub}]
  UI.pick = o => {
    const h = UI.sheet({
      title: o.title, cls: 'compact',
      render: () => `<div class="menu">${o.items.map((it, i) =>
        `<button class="menu-row${it.value === o.selected ? ' sel' : ''}" data-pick="${i}">` +
        `<span class="mi">${it.icon || ''}</span><span class="mt">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>` +
        `<span class="mr">${it.value === o.selected ? UI.icons.check : ''}</span></button>`).join('')}</div>`,
      onMount: hh => {
        hh.body.addEventListener('click', e => {
          const b = e.target.closest('[data-pick]'); if (!b) return;
          const it = o.items[+b.dataset.pick];
          hh.close(); if (o.onPick) o.onPick(it.value, it);
        });
      }
    });
    return h;
  };
})();

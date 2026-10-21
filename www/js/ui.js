/* 晓米记账 · 界面基础：图标、弹层、对话框、提示 */
(() => {
  'use strict';
  const App = window.App, U = App.U, esc = U.esc;
  const UI = App.UI = {};

  const ic = d => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  UI.icons = {
    home: ic('<path d="M7 3h10a2 2 0 012 2v14a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2z"/><path d="M9 8h6M9 12h6M9 16h3"/>'),
    stats: ic('<path d="M5 20V11M12 20V4M19 20v-6"/>'),
    assets: ic('<path d="M3 8a2 2 0 012-2h13a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/><path d="M3 8l11-3.5V6"/><circle cx="16.5" cy="13" r="1.2"/>'),
    mine: ic('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.2 3.6-6.5 8-6.5s8 2.3 8 6.5"/>'),
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

  /* ---------- 轻提示 ---------- */
  UI.toast = (msg, ms) => {
    const t = document.getElementById('toast');
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

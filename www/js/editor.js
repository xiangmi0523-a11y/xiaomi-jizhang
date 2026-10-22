/* 晓米记账 · 记一笔 / 编辑一笔 */
(() => {
  'use strict';
  const App = window.App, U = App.U, UI = App.UI, esc = U.esc;

  const keyBtn = (k, label, cls) => `<button class="key${cls ? ' ' + cls : ''}" data-k="${k}">${label}</button>`;

  App.openEditor = (opts = {}) => {
    const S = App.S;
    const vis = App.visibleAccounts();
    if (!vis.length) { UI.toast('请先在「资产」里添加账户'); return; }
    const rec = opts.id ? S.records.find(r => r.id === opts.id) : null;
    const lastOk = S.settings.lastAcc && vis.some(a => a.id === S.settings.lastAcc);
    const E = rec
      ? { id: rec.id, type: rec.type, cat: rec.cat || '', acc: rec.acc, to: rec.to || '', date: rec.date, expr: U.centsToStr(rec.amount), note: rec.note || '' }
      : { id: null, type: opts.type || 'expense', cat: '', acc: lastOk ? S.settings.lastAcc : vis[0].id, to: '', date: opts.date || U.today(), expr: '', note: '' };
    if (E.type === 'transfer' && !E.to) { const o = vis.find(a => a.id !== E.acc); E.to = o ? o.id : ''; }

    let h, catsEl, chipsEl, exprEl, prevEl, doneEl, dateTxt, noteEl;
    const hasOp = () => /[+-]/.test(E.expr);

    const accLabel = id => { const a = App.acc(id); return a ? `${App.ACC_TYPES[a.type] ? App.ACC_TYPES[a.type].i : '👛'} ${esc(a.name)}` : '选择账户'; };

    const paintCats = () => {
      if (E.type === 'transfer') {
        catsEl.innerHTML = `<div class="tf"><button class="tf-card" data-ed="pickFrom"><span class="lbl">转出账户</span><span class="v">${accLabel(E.acc)}</span></button>` +
          `<button class="tf-swap" data-ed="swap" aria-label="互换">${UI.icons.swap}</button>` +
          `<button class="tf-card" data-ed="pickTo"><span class="lbl">转入账户</span><span class="v">${accLabel(E.to)}</span></button></div>` +
          `<p class="tf-tip">转账只在账户之间挪钱，不计入收支统计</p>`;
        return;
      }
      const list = S.cats[E.type].filter(c => !c.hidden || c.id === E.cat);
      catsEl.innerHTML = '<div class="cats">' + list.map(c =>
        `<button class="cat${c.id === E.cat ? ' on' : ''}" data-cat="${esc(c.id)}"><span class="ci">${c.icon}</span><span class="cn">${esc(c.name)}</span></button>`
      ).join('') + `<button class="cat" data-ed="manage"><span class="ci">⚙️</span><span class="cn">管理</span></button></div>`;
    };
    const paintChips = () => {
      chipsEl.style.display = E.type === 'transfer' ? 'none' : '';
      chipsEl.innerHTML = `<button class="chip" data-ed="pickAcc">${accLabel(E.acc)} <span class="caret">${UI.icons.down}</span></button>`;
    };
    const paintAmount = () => {
      exprEl.textContent = (E.expr === '' ? '0' : E.expr.replace(/\+/g, ' + ').replace(/-/g, ' − '));
      exprEl.classList.toggle('empty', E.expr === '');
      const v = U.evalExpr(E.expr);
      prevEl.textContent = hasOp() ? '= ' + U.money(v) : '';
      doneEl.textContent = hasOp() ? '=' : '完成';
    };
    const paintTabs = () => {
      h.el.querySelectorAll('[data-ed="type"]').forEach(b => b.classList.toggle('on', b.dataset.v === E.type));
    };
    const paintDate = () => {
      const t = U.today();
      dateTxt.textContent = E.date === t ? '今天' : U.dayLabel(E.date);
    };

    const press = k => {
      let e = E.expr;
      const last = e.split(/[+-]/).pop();
      if (/^[0-9]$/.test(k)) {
        if (last === '0') e = e.slice(0, -1) + k;
        else if (/\.\d{2}$/.test(last)) return;
        else if (last.replace('.', '').length >= 10) return;
        else e += k;
      } else if (k === '.') {
        if (last.includes('.')) return;
        e += last === '' ? '0.' : '.';
      } else if (k === '+' || k === '-') {
        if (e === '') return;
        e = /[+-]$/.test(e) ? e.slice(0, -1) + k : e + k;
      } else if (k === 'del') {
        e = e.slice(0, -1);
      } else if (k === 'done') {
        if (hasOp()) {
          const v = U.evalExpr(e);
          if (v <= 0) { UI.toast('金额需要大于 0'); return; }
          E.expr = U.centsToStr(v); paintAmount(); return;
        }
        save(); return;
      }
      E.expr = e; paintAmount();
    };

    let saved = false;   // 防止连点「完成」记成两笔
    const save = () => {
      if (saved) return;
      const amt = U.evalExpr(E.expr);
      if (amt <= 0) { UI.toast('请输入金额'); return; }
      if (E.type === 'transfer') {
        if (!E.acc || !E.to) { UI.toast('请选择转出和转入账户'); return; }
        if (E.acc === E.to) { UI.toast('转出和转入账户不能相同'); return; }
      } else if (!E.cat) { UI.toast('请先选择分类'); return; }
      const data = {
        type: E.type, amount: amt, cat: E.type === 'transfer' ? '' : E.cat, acc: E.acc,
        to: E.type === 'transfer' ? E.to : '', date: E.date, note: noteEl.value.trim()
      };
      if (E.id && !S.records.some(r => r.id === E.id)) { h.close(); UI.toast('这笔记录已经被删除了'); return; }
      saved = true;
      S.settings.lastAcc = E.acc;
      const added = E.id ? null : App.addRecord(data);
      if (E.id) App.updateRecord(E.id, data);
      const from = doneEl.getBoundingClientRect();
      h.close();
      if (E.id) UI.toast('已修改');
      else App.game.rewardRecord({ x: from.left + from.width / 2, y: from.top + from.height / 2 }, added);
      setTimeout(() => App.budget.check(), 1100);   // 支出快超预算时猫咪会出来提醒
    };

    const pickAccount = (title, current, cb) => {
      UI.pick({
        title, selected: current,
        items: App.visibleAccounts().map(a => ({ value: a.id, label: a.name, icon: App.ACC_TYPES[a.type] ? App.ACC_TYPES[a.type].i : '👛' })),
        onPick: v => cb(v)
      });
    };

    const keys =
      keyBtn('7', '7') + keyBtn('8', '8') + keyBtn('9', '9') +
      `<label class="key date"><span id="edDateTxt"></span><input type="date" id="edDate" value="${E.date}"></label>` +
      keyBtn('4', '4') + keyBtn('5', '5') + keyBtn('6', '6') + keyBtn('+', '+', 'op') +
      keyBtn('1', '1') + keyBtn('2', '2') + keyBtn('3', '3') + keyBtn('-', '−', 'op') +
      keyBtn('.', '.') + keyBtn('0', '0') + keyBtn('del', '⌫') + keyBtn('done', '完成', 'done');

    h = UI.sheet({
      bare: true, full: true, cls: 'editor', maskClose: false,
      render: () => `<div class="ed">
        <div class="ed-top">
          <button class="icon-btn" data-act="sheetClose" aria-label="关闭">${UI.icons.close}</button>
          <div class="seg ed-seg">
            <button data-ed="type" data-v="expense">支出</button>
            <button data-ed="type" data-v="income">收入</button>
            <button data-ed="type" data-v="transfer">转账</button>
          </div>
          ${E.id ? `<button class="icon-btn danger" data-ed="del" aria-label="删除">${UI.icons.trash}</button>` : '<span class="icon-btn"></span>'}
        </div>
        <div class="ed-cats" id="edCats"></div>
        <div class="ed-panel">
          <div class="ed-note"><label class="note-box" for="edNote"><span class="note-ic">✏️</span><input id="edNote" type="text" maxlength="40" enterkeyhint="done" autocomplete="off" placeholder="点这里写备注，比如买了什么…" value="${esc(E.note)}"></label><button class="note-done" data-ed="noteDone">完成</button><span class="ed-chips" id="edChips"></span></div>
          <div class="ed-amt"><span class="cur">¥</span><span class="expr" id="edExpr">0</span><span class="prev" id="edPrev"></span></div>
          <div class="keypad">${keys}</div>
        </div>
      </div>`,
      onMount: hh => {
        h = hh;
        const el = hh.el;
        catsEl = el.querySelector('#edCats'); chipsEl = el.querySelector('#edChips');
        exprEl = el.querySelector('#edExpr'); prevEl = el.querySelector('#edPrev');
        doneEl = el.querySelector('[data-k="done"]'); dateTxt = el.querySelector('#edDateTxt'); noteEl = el.querySelector('#edNote');
        paintTabs(); paintCats(); paintChips(); paintAmount(); paintDate();

        el.querySelector('#edDate').addEventListener('change', e => {
          if (e.target.value) { E.date = e.target.value; paintDate(); }
        });
        noteEl.addEventListener('focus', () => el.classList.add('typing'));
        noteEl.addEventListener('blur', () => el.classList.remove('typing'));
        noteEl.addEventListener('keydown', e => { if (e.key === 'Enter') noteEl.blur(); });

        el.addEventListener('click', e => {
          if (e.target.closest('.note-box')) { if (document.activeElement !== noteEl) noteEl.focus(); return; }
          if (document.activeElement === noteEl && e.target !== noteEl) noteEl.blur();
          const kb = e.target.closest('[data-k]');
          if (kb) { press(kb.dataset.k); return; }
          const cb = e.target.closest('[data-cat]');
          if (cb) { E.cat = cb.dataset.cat; paintCats(); return; }
          const ed = e.target.closest('[data-ed]');
          if (!ed) return;
          const a = ed.dataset.ed;
          if (a === 'type') {
            if (E.type === ed.dataset.v) return;
            E.type = ed.dataset.v; E.cat = '';
            if (E.type === 'transfer' && (!E.to || E.to === E.acc)) { const o = App.visibleAccounts().find(x => x.id !== E.acc); E.to = o ? o.id : ''; }
            paintTabs(); paintCats(); paintChips();
          } else if (a === 'pickAcc') pickAccount('选择账户', E.acc, v => { E.acc = v; paintChips(); });
          else if (a === 'pickFrom') pickAccount('转出账户', E.acc, v => { E.acc = v; paintCats(); });
          else if (a === 'pickTo') pickAccount('转入账户', E.to, v => { E.to = v; paintCats(); });
          else if (a === 'noteDone') noteEl.blur();
          else if (a === 'swap') { const t = E.acc; E.acc = E.to; E.to = t; paintCats(); }
          else if (a === 'manage') App.openCatManager(E.type, () => { if (E.cat && !S.cats[E.type].some(c => c.id === E.cat)) E.cat = ''; paintCats(); });
          else if (a === 'del') {
            UI.confirm({ title: '删除这笔记录？', msg: '删除后无法恢复', ok: '删除', danger: true }).then(ok => {
              if (ok) { App.deleteRecord(E.id); h.close(); UI.toast(App.game.refunded ? `已删除，收回 ${App.game.refunded} 金币` : '已删除'); App.budget.check(); }
            });
          }
        });
      }
    });
    return h;
  };
})();

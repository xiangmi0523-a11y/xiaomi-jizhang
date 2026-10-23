/* 晓米记账 · 「我的」页与各设置面板 */
(() => {
  'use strict';
  const App = window.App, U = App.U, UI = App.UI, esc = U.esc, money = U.money;
  const A = App.A;

  /* ================= 我的 ================= */
  const row = (act, icon, title, sub) =>
    `<button class="menu-row" data-act="${act}"><span class="mi">${icon}</span><span class="mt">${title}${sub ? `<small>${sub}</small>` : ''}</span><span class="mr">${UI.icons.chev}</span></button>`;

  const assetCard = () => {
    let a = 0, d = 0;
    App.S.accounts.filter(x => !x.hidden).forEach(x => { const b = App.balance(x.id); if (b >= 0) a += b; else d -= b; });
    return `<button class="card asset-card" data-act="tab" data-t="assets"><div class="ac-main"><span>💰 我的资产 · 净资产</span><b>${a - d < 0 ? '-' : ''}¥${money(Math.abs(a - d))}</b><small>总资产 ${money(a)} · 总负债 ${money(d)} · 账户 ${App.visibleAccounts().length} 个</small></div><span class="mr">${UI.icons.chev}</span></button>`;
  };

  const mineRender = () => {
    const S = App.S;
    const days = App.recordDays(), n = S.records.length;
    const bud = S.budget.total > 0 ? '每月 ¥' + money(S.budget.total) : '未设置';
    const rec = S.recurring.filter(r => r.enabled).length;
    return `<div class="hero slim mine-hero"><div class="avatar">${App.catArt.svg('n1', { head: true, w: 48 })}</div><div><h2 class="hero-title">晓米记账</h2><div class="hero-sub">已记 ${days} 天 · 共 ${n} 笔</div></div></div>
      <div class="body">
        ${assetCard()}
        ${App.savings.cardHTML()}
        <div class="card list menu">
          ${row('openSmart', '🧠', '智能预算', App.smart.on() ? (t => (t.left >= 0 ? '今天还能花 ¥' : '今天超出 ¥') + money(Math.abs(t.left)))(App.smart.today()) : '按收入算出每天能花多少')}
          ${row('openBudget', '🎯', '每月预算', App.smart.on() ? '已由智能预算接管' : bud)}
          ${row('openRecurring', '🔁', '周期记账', rec ? rec + ' 项运行中' : '房租、会员等固定支出自动记')}
          ${row('openCats', '🗂️', '分类管理', '增删、改图标、调整顺序')}
        </div>
        <div class="card list menu">
          ${row('openLook', '🎨', '外观', (App.THEMES[S.settings.theme] || {}).n + ' · ' + ({ auto: '跟随系统', light: '浅色', dark: '深色' }[S.settings.mode]))}
          ${row('openSecurity', '🔒', '密码锁', S.settings.pin ? '已开启' : '未开启')}
          ${row('openRemind', '⏰', '记账提醒', (App.S.settings.remind && App.S.settings.remind.on) ? '每天 ' + App.S.settings.remind.time + ' 没记账会提醒' : '未开启')}
          ${row('openData', '💾', '数据与备份', '导出、导入、清空')}
        </div>
        <div class="card list menu">${row('openAbout', '🌾', '关于晓米记账', 'v3.0')}</div>
      </div>`;
  };
  App.views.mine = { render: mineRender };

  /* ================= 预算 ================= */
  A.openBudget = () => {
    const S = App.S;
    UI.sheet({
      title: '每月预算', full: true,
      render: () => {
        const used = {};
        App.recordsByMonth(U.curYM()).forEach(r => { if (r.type === 'expense') used[r.cat] = (used[r.cat] || 0) + r.amount; });
        const spent = Object.values(used).reduce((a, b) => a + b, 0);
        return `<div class="form">
          <label class="field"><span>总预算</span><input id="bd-total" type="text" inputmode="decimal" placeholder="不设置" value="${S.budget.total ? U.centsToStr(S.budget.total) : ''}"></label>
          <p class="hint">本月已支出 ¥${money(spent)}。设置后，明细页顶部会显示预算剩余。</p>
          ${App.smart.on() ? '<p class="hint sb-note">已开启智能预算：首页卡片和超支提醒按智能预算的弹性额度计算。这里的总预算在关闭智能预算后才生效。</p>' : ''}
          <div class="card-title pad-t">分类预算（可选）</div>
          <div class="card list">${S.cats.expense.filter(c => !c.hidden).map(c =>
            `<label class="rec"><div class="ico">${c.icon}</div><div class="rec-main"><div class="rec-title">${esc(c.name)}</div><div class="rec-sub">本月已花 ${money(used[c.id] || 0)}${S.budget.cats[c.id] ? ` · 已用 ${Math.round((used[c.id] || 0) / S.budget.cats[c.id] * 100)}%` : ''}</div></div>` +
            `<input class="mini-input" data-bc="${esc(c.id)}" type="text" inputmode="decimal" placeholder="不限" value="${S.budget.cats[c.id] ? U.centsToStr(S.budget.cats[c.id]) : ''}"></label>`).join('')}</div>
          <button class="btn primary wide" data-bd="save">保存预算</button>
        </div>`;
      },
      onMount: h => {
        h.body.addEventListener('click', e => {
          if (!e.target.closest('[data-bd="save"]')) return;
          S.budget.total = U.toCents(h.body.querySelector('#bd-total').value);
          const cats = {};
          h.body.querySelectorAll('[data-bc]').forEach(i => { const v = U.toCents(i.value); if (v > 0) cats[i.dataset.bc] = v; });
          S.budget.cats = cats;
          App.changed(); h.close(); UI.toast('预算已保存');
          setTimeout(() => App.budget.check(), 400);
        });
      }
    });
  };

  /* ================= 分类管理 ================= */
  const EMOJI = ['🍜', '🍔', '🍕', '🍣', '🍰', '☕', '🧋', '🍺', '🍎', '🥬', '🍪', '🚌', '🚕', '🚇', '🚗', '⛽', '✈️', '🚲',
    '🛍️', '👗', '👟', '💄', '📱', '💻', '🎮', '🎬', '🏠', '🔑', '💡', '🧻', '🛏️', '💊', '🏥', '🏋️', '📚', '🎓',
    '🧸', '🐱', '🐶', '🎁', '🧧', '💰', '📈', '💼', '🧾', '🔧', '🎵', '🌿', '☎️', '✨'];

  App.openCatManager = (type, onClose) => {
    const S = App.S;
    let cur = type === 'income' ? 'income' : 'expense';
    UI.sheet({
      title: '分类管理', full: true, autoRefresh: true, onClose,
      render: () => {
        const list = S.cats[cur];
        return `<div class="seg wide"><button data-cm="tab" data-v="expense" class="${cur === 'expense' ? 'on' : ''}">支出分类</button><button data-cm="tab" data-v="income" class="${cur === 'income' ? 'on' : ''}">收入分类</button></div>
          <div class="card list cm">${list.map((c, i) =>
            `<div class="rec${c.hidden ? ' dim' : ''}"><div class="ico">${c.icon}</div><div class="rec-main" data-cm="edit" data-id="${esc(c.id)}"><div class="rec-title">${esc(c.name)}${c.hidden ? ' <i class="rec-flag">已隐藏</i>' : ''}</div></div>` +
            `<button class="icon-btn sm" data-cm="up" data-id="${esc(c.id)}" ${i === 0 ? 'disabled' : ''} aria-label="上移">${UI.icons.up}</button>` +
            `<button class="icon-btn sm" data-cm="edit" data-id="${esc(c.id)}" aria-label="编辑">✎</button></div>`).join('')}</div>
          <button class="btn wide" data-cm="add">＋ 添加分类</button>`;
      },
      onMount: h => {
        h.body.addEventListener('click', e => {
          const b = e.target.closest('[data-cm]'); if (!b) return;
          const a = b.dataset.cm;
          if (a === 'tab') { cur = b.dataset.v; h.update(); }
          else if (a === 'up') {
            const list = S.cats[cur], i = list.findIndex(c => c.id === b.dataset.id);
            if (i > 0) { const t = list[i - 1]; list[i - 1] = list[i]; list[i] = t; App.changed(); h.update(); }
          } else if (a === 'edit') catForm(cur, S.cats[cur].find(c => c.id === b.dataset.id), () => h.update());
          else if (a === 'add') catForm(cur, null, () => h.update());
        });
      }
    });
  };
  A.openCats = () => App.openCatManager('expense');

  const catForm = (type, cat, done) => {
    const S = App.S;
    let icon = cat ? cat.icon : '✨';
    UI.sheet({
      title: cat ? '编辑分类' : '添加分类', cls: 'tall',
      render: () => `<div class="form">
        <div class="cf-preview"><div class="ico big" id="cf-prev">${esc(icon)}</div></div>
        <label class="field"><span>名称</span><input id="cf-name" type="text" maxlength="8" placeholder="分类名称" value="${esc(cat ? cat.name : '')}"></label>
        <label class="field"><span>图标</span><input id="cf-icon" type="text" maxlength="8" placeholder="可直接输入 emoji" value="${esc(icon)}"></label>
        <div class="emoji-grid">${EMOJI.map(e => `<button data-emoji="${e}">${e}</button>`).join('')}</div>
        <button class="btn primary wide" data-cf="save">保存</button>
        ${cat ? `<button class="btn ghost wide" data-cf="hide">${cat.hidden ? '取消隐藏' : '隐藏（记账时不显示）'}</button><button class="btn danger wide" data-cf="del">删除分类</button>` : ''}
      </div>`,
      onMount: h => {
        const b = h.body, prev = b.querySelector('#cf-prev'), iconIn = b.querySelector('#cf-icon');
        iconIn.addEventListener('input', () => { icon = iconIn.value.trim() || '✨'; prev.textContent = icon; });
        b.addEventListener('click', e => {
          const em = e.target.closest('[data-emoji]');
          if (em) { icon = em.dataset.emoji; iconIn.value = icon; prev.textContent = icon; return; }
          const bt = e.target.closest('[data-cf]'); if (!bt) return;
          const a = bt.dataset.cf;
          if (a === 'save') {
            const name = b.querySelector('#cf-name').value.trim();
            if (!name) { UI.toast('请填写分类名称'); return; }
            if (S.cats[type].some(c => c.name === name && (!cat || c.id !== cat.id))) { UI.toast('已经有同名分类了'); return; }
            icon = U.cleanIcon(icon);
            if (cat) { cat.name = name; cat.icon = icon; }
            else S.cats[type].push({ id: U.uid('c'), name, icon });
            App.changed(); h.close(); done(); UI.toast('已保存');
          } else if (a === 'hide') { cat.hidden = !cat.hidden; App.changed(); h.close(); done(); }
          else if (a === 'del') {
            if (App.catUsed(cat.id)) { UI.toast('这个分类已有记录，不能删除，可以选择隐藏'); return; }
            UI.confirm({ title: '删除分类「' + cat.name + '」？', ok: '删除', danger: true }).then(ok => {
              if (ok) { S.cats[type] = S.cats[type].filter(c => c.id !== cat.id); delete S.budget.cats[cat.id]; App.changed(); h.close(); done(); }
            });
          }
        });
      }
    });
  };

  /* ================= 周期记账 ================= */
  A.openRecurring = () => {
    const S = App.S;
    UI.sheet({
      title: '周期记账', full: true, autoRefresh: true,
      render: () => {
        const list = S.recurring;
        return (list.length ? `<div class="card list">${list.map(r => {
          const c = App.cat(r.cat);
          return `<div class="rec${r.enabled ? '' : ' dim'}"><div class="ico">${c.icon}</div><div class="rec-main" data-rc="edit" data-id="${esc(r.id)}">` +
            `<div class="rec-title">${esc(c.name)}${r.note ? '　' + esc(r.note) : ''}</div><div class="rec-sub">${App.FREQ[r.freq]} · ${U.md(r.start)}起 · ${esc(App.accName(r.acc))}</div></div>` +
            `<div class="rec-amt ${r.type === 'income' ? 'in' : ''}">${r.type === 'income' ? '+' : '-'}${money(r.amount)}</div>` +
            `<button class="switch${r.enabled ? ' on' : ''}" data-rc="toggle" data-id="${esc(r.id)}" aria-label="开关"><i></i></button></div>`;
        }).join('')}</div>` : '<div class="empty"><div class="empty-cat">🔁</div><p>还没有周期记账<br>房租、会员费、固定收入都可以设成自动记</p></div>') +
          '<button class="btn wide" data-rc="add">＋ 添加周期记账</button>';
      },
      onMount: h => {
        h.body.addEventListener('click', e => {
          const b = e.target.closest('[data-rc]'); if (!b) return;
          const a = b.dataset.rc;
          if (a === 'add') recForm(null, () => h.update());
          else if (a === 'edit') recForm(S.recurring.find(r => r.id === b.dataset.id), () => h.update());
          else if (a === 'toggle') {
            const r = S.recurring.find(x => x.id === b.dataset.id); r.enabled = !r.enabled;
            if (r.enabled) App.runRecurring();
            App.changed(); h.update();
          }
        });
      }
    });
  };

  const recForm = (item, done) => {
    const S = App.S;
    const st = item ? { type: item.type } : { type: 'expense' };
    const catOpts = sel => S.cats[st.type].filter(c => !c.hidden || c.id === sel).map(c => `<option value="${esc(c.id)}"${c.id === sel ? ' selected' : ''}>${c.icon} ${esc(c.name)}</option>`).join('');
    UI.sheet({
      title: item ? '编辑周期记账' : '添加周期记账', full: true,
      render: () => `<div class="form">
        <div class="seg wide"><button data-rf="type" data-v="expense" class="${st.type === 'expense' ? 'on' : ''}">支出</button><button data-rf="type" data-v="income" class="${st.type === 'income' ? 'on' : ''}">收入</button></div>
        <label class="field"><span>金额</span><input id="rf-amt" type="text" inputmode="decimal" placeholder="0.00" value="${item ? U.centsToStr(item.amount) : ''}"></label>
        <label class="field"><span>分类</span><select id="rf-cat">${catOpts(item ? item.cat : '')}</select></label>
        <label class="field"><span>账户</span><select id="rf-acc">${App.visibleAccounts().map(a => `<option value="${esc(a.id)}"${item && item.acc === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
        <label class="field"><span>频率</span><select id="rf-freq">${Object.keys(App.FREQ).map(k => `<option value="${k}"${(item ? item.freq : 'monthly') === k ? ' selected' : ''}>${App.FREQ[k]}</option>`).join('')}</select></label>
        <label class="field"><span>开始日期</span><input id="rf-start" type="date" value="${item ? item.start : U.today()}"></label>
        <label class="field"><span>备注</span><input id="rf-note" type="text" maxlength="20" placeholder="例如：房租" value="${esc(item ? item.note : '')}"></label>
        <p class="hint">到了日期，打开晓米记账时会自动补记。开始日期是过去的话，会把到今天为止没记的都补上。</p>
        <button class="btn primary wide" data-rf="save">保存</button>
        ${item ? '<button class="btn danger wide" data-rf="del">删除这条周期记账</button>' : ''}
      </div>`,
      onMount: h => {
        const b = h.body;
        b.addEventListener('click', e => {
          const bt = e.target.closest('[data-rf]'); if (!bt) return;
          const a = bt.dataset.rf;
          if (a === 'type') {
            st.type = bt.dataset.v;
            b.querySelectorAll('[data-rf="type"]').forEach(x => x.classList.toggle('on', x.dataset.v === st.type));
            b.querySelector('#rf-cat').innerHTML = catOpts('');
          } else if (a === 'save') {
            const amount = U.toCents(b.querySelector('#rf-amt').value);
            const cat = b.querySelector('#rf-cat').value, acc = b.querySelector('#rf-acc').value;
            const start = b.querySelector('#rf-start').value;
            if (amount <= 0) { UI.toast('请填写金额'); return; }
            if (!cat) { UI.toast('请选择分类'); return; }
            if (!acc) { UI.toast('请先添加账户'); return; }
            if (!start) { UI.toast('请选择开始日期'); return; }
            const data = { type: st.type, amount, cat, acc, freq: b.querySelector('#rf-freq').value, start, note: b.querySelector('#rf-note').value.trim() };
            if (item) Object.assign(item, data);
            else S.recurring.push(Object.assign({ id: U.uid('p'), enabled: true, last: '' }, data));
            const n = App.runRecurring();
            App.changed(); h.close(); done();
            UI.toast(n ? '已保存，补记了 ' + n + ' 笔' : '已保存');
          } else if (a === 'del') {
            UI.confirm({ title: '删除这条周期记账？', msg: '已经生成的记录不会被删除', ok: '删除', danger: true }).then(ok => {
              if (ok) { S.recurring = S.recurring.filter(r => r.id !== item.id); App.changed(); h.close(); done(); }
            });
          }
        });
      }
    });
  };

  /* ================= 外观 ================= */
  A.openLook = () => {
    const S = App.S;
    UI.sheet({
      title: '外观', autoRefresh: true,
      render: () => {
        const st = S.settings;
        return `<div class="form">
          <div class="card-title">主题色</div>
          <div class="swatches">${Object.keys(App.THEMES).map(k => `<button class="sw${st.theme === k ? ' on' : ''}${App.themes.owned(k) ? '' : ' locked'}" data-lk="theme" data-v="${k}"><i style="background:${App.THEMES[k].c}">${App.themes.owned(k) ? '' : '🔒'}</i><span>${App.THEMES[k].n}</span></button>`).join('')}</div>
          <p class="hint">带 🔒 的限定主题可以在「客栈 → 主题」用金币解锁</p>
          <div class="card-title pad-t">深浅模式</div>
          <div class="seg wide">${[['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(m => `<button data-lk="mode" data-v="${m[0]}" class="${st.mode === m[0] ? 'on' : ''}">${m[1]}</button>`).join('')}</div>
          <div class="card-title pad-t">每周从哪天开始</div>
          <div class="seg wide"><button data-lk="week" data-v="1" class="${st.weekStart === 1 ? 'on' : ''}">周一</button><button data-lk="week" data-v="0" class="${st.weekStart === 0 ? 'on' : ''}">周日</button></div>
        </div>`;
      },
      onMount: h => {
        h.body.addEventListener('click', e => {
          const b = e.target.closest('[data-lk]'); if (!b) return;
          const st = S.settings, v = b.dataset.v;
          if (b.dataset.lk === 'theme') { if (!App.themes.owned(v)) { UI.toast('这是限定主题，去「客栈 → 主题」用金币解锁吧', 2200); return; } st.theme = v; }
          else if (b.dataset.lk === 'mode') st.mode = v;
          else st.weekStart = +v;
          App.applyTheme(); App.changed(); h.update();
        });
      }
    });
  };

  /* ================= 密码锁 ================= */
  A.openSecurity = () => {
    const S = App.S;
    UI.sheet({
      title: '密码锁', cls: 'compact', autoRefresh: true,
      render: () => S.settings.pin
        ? `<div class="menu">${window.__BIO__ ? `<button class="menu-row" data-act="secBio"><span class="mi">🙂</span><span class="mt">用${App.bioName()}解锁<small>${S.settings.bio ? '已开启，失败时可以输入密码' : '打开后不用每次输密码'}</small></span><span class="switch${S.settings.bio ? ' on' : ''}"><i></i></span></button>` : ''}${row('secChange', '🔑', '修改密码')}${row('secOff', '🔓', '关闭密码锁')}</div><p class="hint pad">离开 App 再回来时需要解锁。这是一个简易的隐私锁，防止别人随手翻看。</p>`
        : `<div class="menu">${row('secOn', '🔒', '开启 4 位密码锁')}</div><p class="hint pad">开启后，每次打开或切回晓米记账都需要输入密码。忘记密码时只能清空数据重置，建议先做个备份。</p>`
    });
  };
  const setNewPin = async () => {
    const a = await App.Lock.ask('设置 4 位密码', { cancel: true });
    if (a == null) return false;
    const b = await App.Lock.ask('再输入一次确认', { cancel: true, validate: v => v === a, mismatch: '两次输入不一致，请重试' });
    if (b == null) return false;
    App.S.settings.pin = U.hash('xm:' + a);
    App.changed(); return true;
  };
  const verifyPin = title => App.Lock.ask(title, { cancel: true, validate: v => U.hash('xm:' + v) === App.S.settings.pin, mismatch: '密码不对' });
  A.secOn = async () => {
    if (!await setNewPin()) return;
    if (window.__BIO__) { App.S.settings.bio = true; App.changed(); UI.toast(`密码锁已开启，也可以用${App.bioName()}解锁`, 2400); } else UI.toast('密码锁已开启');
  };
  A.secBio = () => { App.S.settings.bio = !App.S.settings.bio; App.changed(); UI.toast(App.S.settings.bio ? `已开启${App.bioName()}解锁` : `已关闭${App.bioName()}解锁`); };
  A.secChange = async () => { if (await verifyPin('输入当前密码') == null) return; if (await setNewPin()) UI.toast('密码已修改'); };
  A.secOff = async () => {
    if (await verifyPin('输入当前密码') == null) return;
    App.S.settings.pin = ''; App.S.settings.bio = false; App.changed(); UI.toast('密码锁已关闭');
  };

  /* ================= 数据与备份 ================= */
  const stamp = () => U.today();
  A.openData = () => {
    UI.sheet({
      title: '数据与备份', cls: 'compact', autoRefresh: true,
      render: () => `<div class="menu">
        ${row('backupPick', '☁️', App.backup.folder() ? '自动备份（已开启）' : '自动备份到 iCloud 云盘', App.backup.status())}
        ${App.backup.folder() ? row('backupNow', '🔄', '立即备份一次', '点上一行可以换一个文件夹') : ''}
        ${row('dataExport', '📤', '导出备份（JSON）', '换手机、重装、更新前先做一份')}
        <label class="menu-row" for="importFile"><span class="mi">📥</span><span class="mt">导入备份<small>用备份文件覆盖当前数据</small></span><span class="mr">${UI.icons.chev}</span></label>
        ${row('dataCsv', '📊', '导出表格（CSV）', '可以用 Excel / WPS 打开')}
        ${row('dataClear', '🗑️', '清空所有数据', '会先让你确认')}
      </div><input id="importFile" type="file" accept=".json,application/json,text/plain" hidden>
      <p class="hint pad">账本平时只保存在这台手机里。开启自动备份后，每次有改动（最多每 2 小时一次）都会在你选的文件夹里存一份，保留最近 10 天；选 iCloud 云盘的话，删 App、换手机都能找回。恢复时用「导入备份」选那份文件就行。</p>`,
      onMount: h => {
        h.body.querySelector('#importFile').addEventListener('change', e => {
          const f = e.target.files && e.target.files[0]; if (!f) return;
          const rd = new FileReader();
          rd.onload = () => {
            let obj = null;
            try { obj = JSON.parse(String(rd.result)); } catch (er) { obj = null; }
            if (!obj || !Array.isArray(obj.records) || !Array.isArray(obj.accounts)) { UI.toast('这不是有效的晓米记账备份文件', 2600); return; }
            UI.confirm({ title: '用备份覆盖当前数据？', msg: `备份里有 ${obj.records.length} 笔记录，当前的 ${App.S.records.length} 笔会被替换。`, ok: '覆盖导入', danger: true }).then(ok => {
              if (!ok) return;
              App.replaceState(obj); h.close(); UI.toast('导入成功');
            });
          };
          rd.readAsText(f); e.target.value = '';
        });
      }
    });
  };
  A.dataExport = () => { App.backup.markExport(); App.shareFile('晓米记账备份-' + stamp() + '.json', JSON.stringify(App.S), 'application/json'); };
  A.dataCsv = () => { App.shareFile('晓米记账-' + stamp() + '.csv', App.csv(), 'text/csv'); };
  A.dataClear = async () => {
    if (!await UI.confirm({ title: '清空所有数据？', msg: '所有记录、账户、预算都会被删除，无法恢复。', ok: '继续', danger: true })) return;
    if (!await UI.confirm({ title: '再确认一次', msg: '真的要全部清空吗？建议先导出备份。', ok: '清空', danger: true })) return;
    UI.closeAll(); App.replaceState(null); UI.toast('已清空');
  };

  A.openAbout = () => {
    UI.sheet({
      title: '关于', cls: 'compact',
      render: () => `<div class="about"><div class="avatar big">${App.catArt.svg('n1', { head: true, w: 70, mood: 'happy' })}</div><h3>晓米记账</h3><p class="muted">v3.0 · 给自己用的小账本</p>
        <p>所有数据只存在这台手机里，没有账号、没有联网、没有广告。</p>
        <p class="muted">记一笔 · 明细日历 · 统计图表 · 资产账户 · 预算 · 周期记账 · 备份导出</p></div>`
    });
  };
})();

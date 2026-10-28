/* 晓米记账 · 冲突箱
 *
 * 另一台设备恢复了备份（或这台手机导入备份覆盖云端）时，这台手机上「还没同步上去的修改」不会被静默丢掉：
 * 覆盖本机之前，先把它们连同原始内容放进冲突箱，和覆盖后的账本在同一次原子提交里确认写入成功（durable.js），
 * 之后由用户逐条决定「加回去」还是「不要了」。
 *
 * - 每一项：{ id, batch, src, from, to, at, table, key, kind: add|edit|delete|state, local, status, doneAt }
 *   status：pending 待处理 / applied 已加回去 / discarded 不要了 / same 与云端一致（自动关闭）
 * - 处理是幂等的：只处理 pending 的项，状态和修改在同一次保存里落盘；重复点击、重启后再点都不会重复生效
 * - 加回去时直接改账本数据，不经过记账 / 删除的入口，所以不会重复发金币、签到、盲盒进度、猫咪心情等奖励
 */
(() => {
  'use strict';
  const App = window.App, U = App.U, UI = App.UI, A = App.A, esc = U.esc;
  const X = App.conflicts = {};
  const clone = o => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  const P = () => App.cloud.kit;

  const all = () => (Array.isArray(App.S.conflicts) ? App.S.conflicts : []);
  X.all = all;
  X.pending = () => all().filter(c => c.status === 'pending');

  // 安全快照、批次记录、「从快照恢复本机」见 safety.js；持久化走 durable.js 的原子提交（这里只改内存）

  // 把未同步的修改放进冲突箱（只改内存：由调用方在同一次原子提交里连同覆盖后的账本一起保存）
  // - 同一批次重复调用只会更新、不会重复生成；用户已经处理过的不再改动
  // - 跨批次去重：其他批次里已有「表、键、类型、本机内容」都相同的待处理项，就不再新建
  X.protect = (batch, info, items) => {
    const list = all().slice();
    const byId = new Map(list.map(c => [c.id, c]));
    const sig = c => c.table + '|' + c.key + '|' + c.kind + '|' + JSON.stringify(c.local === undefined ? null : c.local);
    const elsewhere = new Set(list.filter(c => c.status === 'pending' && c.batch !== batch).map(sig));
    let added = 0;
    items.forEach(it => {
      const id = batch + '|' + it.table + '|' + it.key;
      const old = byId.get(id);
      if (old && old.status !== 'pending') return;
      const item = {
        id, batch, src: info.src || 'rebase', from: info.from, to: info.to, at: (old && old.at) || Date.now(),
        table: it.table, key: it.key, kind: it.kind, local: it.local === undefined ? null : clone(it.local), status: 'pending'
      };
      if (!old && elsewhere.has(sig(item))) return;
      if (!old) added++;
      byId.set(id, item);
    });
    App.S.conflicts = Array.from(byId.values());
    return added;
  };

  // 本机现在的这一项（对齐之后 = 云端的样子）
  const tableOf = name => P().TABLES.find(t => t.name === name);
  const currentItem = (table, key) => { const t = tableOf(table); return t.list().find(x => t.toRow(x)[t.key] === key); };
  const sameAsNow = c => {
    if (c.table === 'xm_state') return JSON.stringify(P().stateOut()[c.key]) === JSON.stringify(c.local);
    const t = tableOf(c.table), cur = currentItem(c.table, c.key);
    if (c.kind === 'delete') return !cur;
    return !!cur && P().rowHash(t, t.toRow(cur)) === P().rowHash(t, t.toRow(c.local));
  };
  // 3) 对齐之后：和云端已经一样的项自动关闭（例如两边改成了同样的内容、或者都已删除）
  X.prune = batch => {
    all().forEach(c => { if (c.batch === batch && c.status === 'pending' && sameAsNow(c)) { c.status = 'same'; c.doneAt = Date.now(); } });
    // 只留最近 30 天处理过的记录，待处理的永远保留
    const cut = Date.now() - 30 * 864e5;
    App.S.conflicts = all().filter(c => c.status === 'pending' || (c.doneAt || 0) > cut);
  };

  // 把一项「加回去」：直接改账本数据，不调用记账 / 删除入口（避免重复奖励或退金币）
  const strip = (o, keys) => { const x = clone(o); keys.forEach(k => { delete x[k]; }); return x; };
  const putById = (arr, item) => { const i = arr.findIndex(x => x.id === item.id); if (i >= 0) arr[i] = item; else arr.push(item); };
  const applyItem = c => {
    const S = App.S;
    if (c.table === 'xm_records') {
      if (c.kind === 'delete') S.records = S.records.filter(r => r.id !== c.key); else putById(S.records, clone(c.local));
    } else if (c.table === 'xm_accounts') {
      if (c.kind === 'delete') S.accounts = S.accounts.filter(a => a.id !== c.key); else putById(S.accounts, strip(c.local, ['_sort']));
    } else if (c.table === 'xm_categories') {
      ['expense', 'income'].forEach(k => { if (c.kind === 'delete' || (c.local && c.local._kind !== k)) S.cats[k] = S.cats[k].filter(x => x.id !== c.key); });
      if (c.kind !== 'delete') putById(S.cats[c.local._kind === 'income' ? 'income' : 'expense'], strip(c.local, ['_kind', '_sort']));
    } else if (c.table === 'xm_cats') {
      if (c.kind === 'delete') delete S.game.cats[c.key]; else S.game.cats[c.key] = strip(c.local, ['id']);
    } else if (c.table === 'xm_state') {
      if (c.key === 'game') S.game = Object.assign({}, clone(c.local), { cats: S.game.cats });
      else if (c.key === 'settings') S.settings = Object.assign({}, S.settings, clone(c.local));   // 只属于这台手机的设置不在快照里，保持不变
      else S[c.key] = clone(c.local);
      const keep = S.sync;
      App.S = App.normalize(S); App.S.sync = keep;
    }
  };

  // 处理一项：action = 'apply'（加回去 / 也删掉 / 用这台手机的）或 'discard'（不要了 / 保留云端的）
  X.resolve = (id, action) => {
    const c = all().find(x => x.id === id);
    if (!c || c.status !== 'pending') return false;
    if (action === 'apply') applyItem(c);
    const cur = all().find(x => x.id === id);          // 整块设置会生成新的 App.S，重新取一次
    cur.status = action === 'apply' ? 'applied' : 'discarded';
    cur.doneAt = Date.now();
    if (App.safety) App.safety.batchCheck(cur.batch);   // 批次里最后一项处理完：记下完成时间（快照清理按它算 30 天）
    App.flush();                                      // 修改和处理状态在同一次保存里落盘
    if (App.render) App.render(true);
    return true;
  };

  /* ---------- 界面 ---------- */
  const MOD = { budget: '预算', recurring: '周期记账', game: '金币、签到、客栈', smart: '智能预算', saving: '存钱计划', settings: '外观等设置', created: '账本创建时间' };
  const KIND = { add: '新增', edit: '修改', delete: '删除', state: '修改' };
  const describe = c => {
    if (c.table === 'xm_state') return { title: MOD[c.key] || c.key, sub: '这台手机上的设置和云端不一样' };
    const it = c.kind === 'delete' ? currentItem(c.table, c.key) : c.local;
    if (c.table === 'xm_records') {
      if (!it) return { title: '一笔账单', sub: '' };
      const label = it.type === 'income' ? '收入' : it.type === 'transfer' ? '转账' : '支出';
      return { title: `${label} ¥${U.money(it.amount)}`, sub: [it.type === 'transfer' ? '' : App.cat(it.cat).name, U.md(it.date), it.note].filter(Boolean).join(' · ') };
    }
    if (c.table === 'xm_accounts') return { title: '账户：' + ((it && it.name) || c.key), sub: '' };
    if (c.table === 'xm_categories') return { title: '分类：' + ((it && it.name) || c.key), sub: '' };
    const cat = App.cats && App.cats.byId && App.cats.byId(c.key);
    return { title: '猫咪：' + ((cat && cat.name) || c.key), sub: '' };
  };
  const BTN = {
    add: ['加回去', '不要了'], edit: ['用这台手机的', '保留云端的'], delete: ['也删掉', '保留云端的'], state: ['用这台手机的', '用云端的']
  };

  A.openConflicts = () => {
    UI.sheet({
      title: '冲突箱', cls: 'tall',
      render: () => {
        const items = X.pending();
        if (!items.length) return '<div class="form"><p class="hint">冲突箱是空的，没有需要处理的修改。</p></div>';
        return `<div class="form cf-list">
          <p class="hint">另一台设备恢复了备份，或者这台手机导入了备份。下面是这台手机当时还没同步上去的修改，已经替你保存好了。逐条决定要不要加回去；加回去的会正常同步到云端。处理之前它们会一直留在这里。</p>
          <div class="cf-bulk"><button class="btn" data-cf="all-apply">全部加回去</button><button class="btn" data-cf="all-discard">全部不要</button></div>
          ${items.map(c => { const d = describe(c), b = BTN[c.kind]; return `<div class="cf-item" data-id="${esc(c.id)}">
            <div class="cf-main"><span class="cf-kind">${KIND[c.kind]}</span><b>${esc(d.title)}</b>${d.sub ? `<small>${esc(d.sub)}</small>` : ''}</div>
            <div class="cf-btns"><button class="btn primary" data-cf="apply" data-id="${esc(c.id)}">${b[0]}</button><button class="btn" data-cf="discard" data-id="${esc(c.id)}">${b[1]}</button></div>
          </div>`; }).join('')}
        </div>`;
      },
      onMount: h => {
        h.body.addEventListener('click', e => {
          const b = e.target.closest('[data-cf]'); if (!b) return;
          const a = b.dataset.cf;
          if (a === 'apply' || a === 'discard') X.resolve(b.dataset.id, a);
          else if (a === 'all-apply' || a === 'all-discard') X.pending().forEach(c => X.resolve(c.id, a === 'all-apply' ? 'apply' : 'discard'));
          h.update();
          if (App.cloud && App.cloud.paint) App.cloud.paint();
        });
      }
    });
  };
})();

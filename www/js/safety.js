/* 晓米记账 · 安全快照、批次记录、清理、「从快照恢复本机」（设计见 docs/snapshot-native-design.md 第 6–8 节）
 *
 * - 对齐 / 恢复前的快照按批次独立保存（原生：Documents/安全快照/<dir>/；网页版：localStorage xm_snap:<dir>:<name>），
 *   必须拿到 durable.js 的严格确认才算写成功
 * - 批次记录 S.safety.batches[批次] = { dir, kind, at, items, doneAt }：清理只看它，不把「冲突箱为空」当成可删
 * - 「从快照恢复本机」：只改这台手机，不发任何网络请求；恢复前先存保护点；恢复后暂停云同步（S.sync.hold），
 *   之后「恢复云同步」（差异进冲突箱）或「撤销本机恢复」
 * - 不经过记账 / 删除 / 奖励的入口
 */
(() => {
  'use strict';
  const App = window.App, U = App.U, UI = App.UI, A = App.A, esc = U.esc;
  const F = App.safety = {};
  const D = () => App.durable, C = () => App.cloud, K = () => App.cloud.kit, SB = () => App.supabase;
  const clone = o => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  const fail = (code, msg) => { const e = new Error(msg); e.code = code; return e; };
  const DAY = 864e5, KEEP = 30 * DAY;
  F.log = [];
  const log = (kind, msg, extra) => {
    F.log.push(Object.assign({ at: Date.now(), kind, msg }, extra || {})); if (F.log.length > 50) F.log.shift();
    try { console.info('[xm-safety]', kind, msg, extra || ''); } catch (e) { /* ignore */ }
  };

  /* ---------- 工具 ---------- */
  const uidNow = () => (SB() && SB().user() && SB().user().id) || (App.S.sync && App.S.sync.uid) || '';
  const u8 = uid => (String(uid || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'nouser');
  // 批次目录名：同一批次重试写同一个文件（原子替换，天然去重）；不同批次互不覆盖
  F.dirFor = (kind, uid, x) => ({ align: 'e', restore: 'e', resume: 'r', protect: 'p' }[kind] || 'x') + x + '-' + u8(uid);
  const LABEL = { align: '对齐前备份', restore: '恢复前备份', resume: '恢复云同步前', protect: '本机恢复前' };
  const counts = S => ({ records: S.records.length, accounts: S.accounts.length, categories: S.cats.expense.length + S.cats.income.length, cats: Object.keys((S.game && S.game.cats) || {}).length });
  F.counts = counts;

  // 在账本副本上执行（fn 里可以照常用读写 App.S 的同步代码），返回副本；App.S 本身不变。全程同步，中间没有 await
  F.onCopy = (base, fn) => {
    const keep = App.S;
    App.S = JSON.parse(base);
    try { fn(); return App.S; } finally { App.S = keep; }
  };

  // 数据部分的指纹（用来判断本机恢复之后有没有改过数据）
  F.dataHash = S => {
    const st = {}; Object.keys(S.settings || {}).forEach(k => { if (!K().LOCAL_ONLY.includes(k)) st[k] = S.settings[k]; });
    return K().hash(JSON.stringify([S.records, S.accounts, S.cats, S.budget, S.recurring, S.game, S.smart, S.saving, S.created, st]));
  };

  /* ---------- 写快照（必须拿到严格确认） ---------- */
  const why = e => {
    const c = e && e.code;
    if (c === 'quota') return '浏览器的存储空间不够（网页版能保存的账本有上限）。建议在晓米记账 App 里打开，或清理浏览器数据后重试';
    if (c === 'ENOSPC') return '手机存储空间不足，请清理一些空间后重试';
    if (c === 'timeout') return '没有收到手机存储的确认（超时），稍后会重试';
    if (c === 'mismatch' || c === 'transport' || c === 'bad_receipt') return '手机存储的确认与写入内容不一致，稍后会重试';
    return (e && e.message) || '未知原因';
  };
  F.why = why;
  // { batch, kind, content, uid, from, to, counts, dir? } → { dir, name, ... }；失败抛 xm_snapshot_failed（本机不动）
  F.snapshot = async o => {
    const at = Date.now(), dir = o.dir || F.dirFor(o.kind, o.uid, o.x != null ? o.x : o.to);
    const name = '晓米记账-' + (o.label || LABEL[o.kind] || '安全快照') + '.json';
    try {
      const r = await D().writeSnapshot({ dir, name, content: o.content, meta: { kind: o.kind, batch: o.batch, uid: o.uid, at, from: o.from, to: o.to, label: o.label || LABEL[o.kind], counts: o.counts } });
      log('snapshot', '安全快照已确认写入', { dir, store: r.store, bytes: r.bytes });
      return r;
    } catch (e) {
      log('snapshot-failed', '安全快照没写成功：' + (e.message || e), { dir, code: e.code });
      throw fail('xm_snapshot_failed', '没能先保存本机账本的安全快照：' + why(e) + '。已暂停覆盖本机（本机数据没有改动）');
    }
  };
  F.commitError = e => (e && e.code === 'xm_retry' ? e : fail('xm_commit_failed', '没能保存冲突箱和更新后的账本：' + why(e) + '（本机数据没有改动）'));

  /* ---------- 批次记录（在调用方给的 App.S 上改：对齐时是副本，处理冲突时是正式账本） ---------- */
  const batches = () => {
    const S = App.S;
    if (!S.safety || typeof S.safety !== 'object' || !S.safety.batches) S.safety = { v: 1, batches: {} };
    return S.safety.batches;
  };
  F.recordBatch = (batch, o) => {
    const bs = batches(), b = bs[batch] || { at: Date.now(), doneAt: null };
    b.dir = o.dir; b.kind = o.kind;
    b.items = (App.S.conflicts || []).filter(c => c.batch === batch).length;
    bs[batch] = b;
    F.batchCheck(batch);
  };
  // 批次里没有待处理项、也没被「本机恢复」引用时，记下完成时间；又有待处理项时清掉
  F.batchCheck = batch => {
    const S = App.S, b = S.safety && S.safety.batches && S.safety.batches[batch];
    if (!b) return;
    const hold = S.sync && S.sync.hold;
    const referenced = hold && hold.batch === batch;
    const open = (S.conflicts || []).some(c => c.batch === batch && c.status === 'pending');
    if (open || referenced) b.doneAt = null;
    else if (!b.doneAt) b.doneAt = Date.now();
  };

  /* ---------- 清理（每 24 小时最多一次；失败不影响记账） ---------- */
  const GC_KEY = 'xm_snap_gc_at';
  let gcMem = 0, gcBusy = false;
  F.housekeep = async force => {
    if (gcBusy) return null;
    let last = gcMem; try { last = Number(localStorage.getItem(GC_KEY)) || gcMem; } catch (e) { /* ignore */ }
    if (!force && Date.now() - last < DAY) return null;
    gcBusy = true; gcMem = Date.now();
    try { localStorage.setItem(GC_KEY, String(gcMem)); } catch (e) { /* 存不下也没关系：只是多清理几次 */ }
    const report = { kept: [], deleted: [], failed: [] };
    try {
      const uid = uidNow();
      if (!uid) return report;
      const list = await D().listSnapshots();
      const S = App.S, bs = (S.safety && S.safety.batches) || {}, hold = S.sync && S.sync.hold;
      const job = App.restore && App.restore.job();
      const jobBatch = job && job.phase === 'applied' && job.result ? job.uid + ':' + job.result.epoch : '';
      const refDirs = new Set(hold ? [hold.protect && hold.protect.dir, hold.snap && hold.snap.dir].filter(Boolean) : []);
      const byDir = {};
      list.forEach(x => { if (x.dir) (byDir[x.dir] = byDir[x.dir] || []).push(x); else report.kept.push({ dir: x.name, why: '旧格式，批次未知' }); });
      const dels = [];
      Object.keys(byDir).forEach(dir => {
        const xs = byDir[dir], keep = r => report.kept.push({ dir, why: r });
        if (xs.some(x => !x.verified || !x.meta)) return keep('校验没通过或缺少说明');
        const metas = xs.map(x => x.meta);
        if (metas.some(m => m.uid !== uid)) return keep('不属于当前账号，或无法判断归属');
        const batchIds = Array.from(new Set(metas.map(m => m.batch)));
        if (batchIds.length !== 1 || !batchIds[0]) return keep('无法判断批次');
        const bid = batchIds[0], b = bs[bid];
        if (!b) return keep('批次不在记录里');
        if (!b.doneAt) return keep('批次还有待处理的冲突、仍在使用或状态不确定（没有完成时间）');
        if (Date.now() - b.doneAt <= KEEP) return keep('处理完还没满 30 天');
        if ((S.conflicts || []).some(c => c.batch === bid && c.status === 'pending')) return keep('冲突箱里还有这个批次的待处理项');
        if (bid === jobBatch) return keep('仍被恢复任务引用');
        if (refDirs.has(dir)) return keep('仍被本机恢复引用');
        dels.push(dir);
      });
      if (dels.length) {
        const res = await D().deleteSnapshots(dels);
        res.forEach(r => { if (r.ok) report.deleted.push(r.dir); else { report.failed.push(r); log('gc-failed', '清理快照失败：' + r.dir, r); } });
      }
      log('gc', `快照清理：删除 ${report.deleted.length}，保留 ${report.kept.length}，失败 ${report.failed.length}`);
    } catch (e) {
      log('gc-error', '快照清理没完成（不影响记账）：' + (e.message || e), { code: e.code });
      report.error = e.message || String(e);
    } finally { gcBusy = false; }
    return report;
  };

  /* ---------- 「从快照恢复本机」 ---------- */
  F.held = () => !!(App.S && App.S.sync && App.S.sync.hold);
  F.hold = () => (App.S && App.S.sync && App.S.sync.hold) || null;

  // 列出这个账号的快照（附带能不能恢复、为什么）
  F.list = async () => {
    const uid = uidNow(), items = await D().listSnapshots();
    return items.map(x => {
      const m = x.meta || {}, own = !!uid && m.uid === uid;
      const why = !x.verified ? (x.error || '校验没通过') : !own ? '不是当前账号的快照' : '';
      return Object.assign({}, x, { own, restorable: !why, reason: why, label: m.label || LABEL[m.kind] || '快照', at: m.at || x.mtime || 0 });
    }).filter(x => x.own || !uid || x.legacy || (x.meta && x.meta.uid === uid)).sort((a, b) => b.at - a.at);
  };

  const idle = async () => { for (let i = 0; i < 300 && C().busy; i++) await new Promise(r => setTimeout(r, 100)); };
  const checkLedger = (snap, from) => {
    if (!snap || typeof snap !== 'object' || Array.isArray(snap)) throw fail('xm_bad_snapshot', from + '不是有效的账本');
    if (!Array.isArray(snap.records) || !Array.isArray(snap.accounts) || !snap.cats || !Array.isArray(snap.cats.expense) || !Array.isArray(snap.cats.income)) throw fail('xm_bad_snapshot', from + '缺少账单、账户或分类');
    const L = App.normalize(clone(snap));
    if (L.records.length !== snap.records.length || L.accounts.length !== snap.accounts.length) throw fail('xm_bad_snapshot', from + '里有格式不对的条目，为了不丢数据不能恢复');
    return L;
  };
  const readChecked = async (dir, name, what) => {
    const r = await D().readSnapshot(dir, name).catch(e => { throw fail('xm_bad_snapshot', '读不出' + what + '：' + why(e)); });
    if (!r.verified) throw fail('xm_bad_snapshot', what + '校验没通过（字节数或 SHA-256 不一致），不能用来恢复');
    let snap; try { snap = JSON.parse(r.content); } catch (e) { throw fail('xm_bad_snapshot', what + '不是有效的 JSON'); }
    return { snap, meta: r.meta || {} };
  };

  // 恢复到本机：校验 → 保护点 → 原子提交（不发任何网络请求）
  let busy = false;
  F.restoreLocal = async entry => {
    if (busy) return false;
    if (F.held()) throw fail('xm_held', '已经从快照恢复过本机，请先「恢复云同步」或「撤销本机恢复」');
    if (App.restore && App.restore.pending()) throw fail('xm_busy', '有一个备份恢复还没完成，请先在「云端同步」里处理它');
    busy = true;
    try {
      await idle();
      if (C().busy) throw fail('xm_busy', '正在同步，请稍后再试');
      if (!SB() || !SB().user()) throw fail('xm_owner', '请先登录，再从快照恢复本机');
      const uid = uidNow();
      if (!uid) throw fail('xm_owner', '无法确认当前账号，不能恢复');
      const { snap, meta } = await readChecked(entry.dir, entry.name, '这份快照');
      const owner = meta.uid || (snap.sync && snap.sync.uid) || '';
      if (owner !== uid) throw fail('xm_owner', '这份快照不属于当前账号，不能恢复到本机');
      checkLedger(snap, '这份快照');
      if (!App.S.sync || !App.S.sync.uid) throw fail('xm_owner', '这台手机还没和云端同步过，不能做本机恢复');
      if (App.S.sync.uid !== uid) throw fail('xm_owner', '这台手机上的账本不属于当前登录的账号，不能做本机恢复');

      const before = JSON.stringify(App.S), ts = Date.now();
      const pBatch = uid + ':p' + ts, protectDir = F.dirFor('protect', uid, ts);
      const next = F.onCopy(before, () => {
        // 1) 这台手机现在还没同步的修改：放进冲突箱（不会被快照内容盖掉）
        const ep = App.S.sync.epoch;
        App.conflicts.protect(pBatch, { src: 'local', from: ep, to: ep }, C().pendingChanges());
        // 2) 快照里有、现在没有的冲突项也带上（当前冲突箱不会被覆盖）
        const ids = new Set(App.S.conflicts.map(c => c.id));
        (Array.isArray(snap.conflicts) ? snap.conflicts : []).forEach(c => { if (c && c.id && !ids.has(c.id)) App.S.conflicts.push(clone(c)); });
        // 3) 数据来自快照；同步基线和 epoch 保持当前的（绝不用快照里的旧 epoch）；只属于这台手机的设置保持当前的
        const keepSync = clone(App.S.sync), keepConf = App.S.conflicts, keepSafety = App.S.safety, mine = {};
        K().LOCAL_ONLY.forEach(k => { if (k in App.S.settings) mine[k] = App.S.settings[k]; });
        const data = clone(snap); delete data.sync; delete data.conflicts; delete data.safety; delete data._manifest;
        data.settings = Object.assign({}, data.settings || {}, mine);
        App.S = App.normalize(data);
        App.S.sync = keepSync; App.S.conflicts = keepConf; App.S.safety = keepSafety;
        App.S.sync.hold = { kind: 'local-restore', at: ts, batch: pBatch, snap: { dir: entry.dir, name: entry.name, at: meta.at || 0, label: meta.label || '' }, protect: { dir: protectDir, name: '晓米记账-' + LABEL.protect + '.json' } };
        F.recordBatch(pBatch, { dir: protectDir, kind: 'protect' });
        App.S.sync.hold.dataHash = F.dataHash(App.S);
      });
      // 保护点：现在的完整账本，必须拿到严格确认
      await F.snapshot({ batch: pBatch, kind: 'protect', dir: protectDir, content: before, uid, from: App.S.sync.epoch, to: App.S.sync.epoch, counts: counts(App.S) });
      try { await D().commitLedger(JSON.stringify(next), () => JSON.stringify(App.S) === before, () => { App.S = next; }); }
      catch (e) { throw e.code === 'xm_retry' ? fail('xm_retry', '恢复时账本刚好有改动，请再点一次（本机数据没有改动）') : F.commitError(e); }
      log('local-restore', '已从快照恢复本机', { snap: entry.dir + '/' + entry.name, protect: protectDir });
      if (App.applyTheme) App.applyTheme();
      if (App.render) App.render(true);
      if (C().paint) C().paint();
      return true;
    } finally { busy = false; }
  };

  // 撤销本机恢复：只有恢复后没改过数据才允许；原子提交保护点
  F.undoLocal = async () => {
    const h = F.hold();
    if (!h || busy) return false;
    if (F.dataHash(App.S) !== h.dataHash) throw fail('xm_changed', '本机恢复之后改过数据，不能直接撤销。请用「恢复云同步」：所有不同的地方都会进冲突箱，不会丢');
    busy = true;
    try {
      await idle();
      const { snap } = await readChecked(h.protect.dir, h.protect.name, '保护点');
      checkLedger(snap, '保护点');
      const before = JSON.stringify(App.S);
      const next = F.onCopy(before, () => {
        const keepSync = clone(App.S.sync), keepSafety = App.S.safety, hb = keepSync.hold.batch;
        delete keepSync.hold;
        const conf = Array.isArray(snap.conflicts) ? clone(snap.conflicts) : [];
        const data = clone(snap); delete data.sync; delete data.conflicts; delete data.safety;
        App.S = App.normalize(data);
        App.S.sync = keepSync; App.S.conflicts = conf; App.S.safety = keepSafety;
        F.batchCheck(hb);
      });
      try { await D().commitLedger(JSON.stringify(next), () => JSON.stringify(App.S) === before, () => { App.S = next; }); }
      catch (e) { throw e.code === 'xm_retry' ? fail('xm_retry', '账本刚好有改动，请再点一次（本机数据没有改动）') : F.commitError(e); }
      log('local-undo', '已撤销本机恢复');
      if (App.applyTheme) App.applyTheme();
      if (App.render) App.render(true);
      if (C().paint) C().paint();
      return true;
    } finally { busy = false; }
  };

  // 恢复云同步：强制对齐一次（快照和云端不同的地方进冲突箱，不自动上传）
  F.resumeInfo = () => {
    const h = F.hold(); if (!h) return null;
    return {
      src: 'snapshot', kind: 'resume', label: LABEL.resume, batchSuffix: ':r' + h.at, x: h.at, clearHold: true,
      toast: n => (n ? `已恢复云同步：本机恢复的内容和云端不同的 ${n} 处放进了冲突箱，逐条决定要不要加回去` : '已恢复云同步，本机和云端一致')
    };
  };
  F.resumeSync = async () => {
    if (!F.held()) return true;
    await idle();
    C().resuming = true;
    const ok = await C().sync(true);
    return ok && !F.held();
  };

  /* ---------- 界面 ---------- */
  const when = t => { if (!t) return '时间未知'; const d = new Date(t); return `${U.ymd(d)} ${U.pad(d.getHours())}:${U.pad(d.getMinutes())}`; };
  const scope = m => { const c = (m && m.counts) || null; return c ? `${c.records} 笔账单 · ${c.accounts} 个账户 · ${c.categories} 个分类 · ${c.cats} 只猫咪` : '范围未知'; };
  const batchText = x => {
    const m = x.meta || {};
    if (m.kind === 'protect') return '本机恢复前的保护点';
    if (m.kind === 'resume') return '恢复云同步前';
    if (Number.isInteger(m.to)) return `对齐到第 ${m.to} 版之前` + (m.kind === 'restore' ? '（这台手机恢复备份）' : '');
    return x.legacy ? '旧格式' : '批次未知';
  };

  A.openSnapshots = () => {
    let items = null, err = '', working = false;
    const load = async () => {
      try { items = await F.list(); err = ''; } catch (e) { items = []; err = '读不出快照列表：' + why(e); }
      if (!h.closed) h.update();
    };
    const h = UI.sheet({
      title: '从快照恢复本机', cls: 'tall',
      render: () => {
        const hd = F.hold();
        const head = hd ? `<div class="sf-hold"><b>已从快照恢复了本机</b><small>${esc(hd.snap.label || '快照')} · ${esc(when(hd.snap.at))}。云端同步已暂停：选「恢复云同步」时，本机和云端不同的地方会进冲突箱，由你逐条决定；或者「撤销本机恢复」回到恢复之前。</small>
          <div class="sf-btns"><button class="btn primary" data-sf="resume" ${working ? 'disabled' : ''}>恢复云同步</button><button class="btn" data-sf="undo" ${working ? 'disabled' : ''}>撤销本机恢复</button></div></div>` : '';
        const intro = '<p class="hint">每次和云端对齐、恢复备份之前，App 都会先给这台手机的账本存一份「安全快照」。这里可以把某一份快照恢复到这台手机：<b>只改这台手机，不会恢复、也不会改动云端。</b></p>';
        if (items === null) return `<div class="form">${head}${intro}<p class="hint">正在读取快照…</p></div>`;
        const rows = items.length ? items.map((x, i) => `<div class="cf-item sf-item">
            <div class="cf-main"><span class="cf-kind">${esc(x.label)}</span><b>${esc(when(x.at))}</b>
              <small>${esc(batchText(x))} · ${esc(scope(x.meta))} · ${x.store === 'native' ? 'App 文件' : '浏览器存储'}</small>
              <small class="${x.verified ? 'sf-ok' : 'sf-bad'}">${x.verified ? '✓ 已校验（字节数和 SHA-256 一致）' : '✗ ' + esc(x.reason || '校验没通过')}</small></div>
            ${!hd && x.restorable ? `<div class="cf-btns"><button class="btn" data-sf="restore" data-i="${i}" ${working ? 'disabled' : ''}>恢复到本机</button></div>` : ''}
          </div>`).join('') : '<p class="hint">还没有快照。</p>';
        return `<div class="form cf-list">${head}${intro}${err ? `<p class="hint cl-err">${esc(err)}</p>` : ''}${rows}</div>`;
      },
      onMount: hh => {
        hh.body.addEventListener('click', async e => {
          const b = e.target.closest('[data-sf]'); if (!b || b.disabled || working) return;
          const a = b.dataset.sf;
          try {
            if (a === 'restore') {
              const x = items[+b.dataset.i];
              if (!await UI.confirm({ title: '把这份快照恢复到本机？', msg: `快照时间：${when(x.at)}（${scope(x.meta)}）。只会改这台手机上的数据，不会恢复、也不会改动云端。恢复前会先给现在的账本存一份保护点；冲突箱里的内容会保留，这台手机还没同步的修改会放进冲突箱。恢复后云端同步会暂停，直到你选择「恢复云同步」或「撤销本机恢复」。`, ok: '继续' })) return;
              if (!await UI.confirm({ title: '再确认一次', msg: '这台手机上的账单、账户、分类、预算、存钱计划、金币和猫咪都会变成快照里的样子。', ok: '恢复到本机', danger: true })) return;
              working = true; hh.update();
              if (await F.restoreLocal(x)) UI.toast('已从快照恢复本机数据，云端同步已暂停', 3200, 'gold');
            } else if (a === 'resume') {
              working = true; hh.update();
              if (!await F.resumeSync()) UI.toast('还没恢复云同步：' + (C().err || '请稍后再试'), 3600);
            } else if (a === 'undo') {
              if (!await UI.confirm({ title: '撤销本机恢复？', msg: '这台手机会回到恢复快照之前的样子，然后恢复云同步。', ok: '撤销', danger: true })) return;
              working = true; hh.update();
              if (await F.undoLocal()) UI.toast('已撤销本机恢复', 2400);
            }
          } catch (er) { UI.toast(er.message || '没成功', 4200); }
          finally { working = false; items = null; hh.update(); load(); }
        });
      }
    });
    load();
  };
})();

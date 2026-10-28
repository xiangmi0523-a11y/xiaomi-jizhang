/* 晓米记账 · 备份恢复（H3 修复，Phase 2B-3）
 *
 * 登录状态下导入备份 = 用备份「替换」这个账号的云端账本，然后让这台手机跟着云端走。
 * 服务端协议见 docs/restore-protocol.md / supabase/restore_epoch.sql：
 *   建任务 create → 分批暂存 stage（每批 ≤ 500 行）→ 封存 seal（服务器核对条数和摘要）→ 单事务应用 apply（版本号 +1）
 *
 * 设计要点
 * - 先校验，校验不过绝不调用服务器（必需模块、normalize 不丢任何一条、编号不重复、新格式备份的校验码）
 * - 任务编号和进度存在 localStorage（xm_restore_job_v1）：断网、响应丢失、App 被杀、重复点击后都继续「同一个任务」，
 *   每一步都先查服务器 / 重试同一个编号，绝不另起新任务；已封存的任务不会被当成「未开始」
 * - 应用成功之前，这台手机的账本一点都不动；任务存在期间也不做普通同步（避免把恢复前的云端数据拉回来）
 * - 应用成功后不在这里改本机，而是走 2B-2 已有的「与云端对齐」：快照 → 未同步修改进冲突箱 → 用云端（= 备份）覆盖本机
 *   所以恢复前没同步的修改、恢复途中新记的账都会进冲突箱，不会被静默丢掉
 * - 只依赖 App.cloud 的公开接口（sync / schedule / paint / kit）和 App.supabase.call；不包装任何全局函数
 */
(() => {
  'use strict';
  const App = window.App, U = App.U, UI = App.UI, A = App.A, esc = U.esc;
  const R = App.restore = {};
  const SB = () => App.supabase, C = () => App.cloud, K = () => App.cloud.kit;
  const JOB_KEY = 'xm_restore_job_v1', PAY_KEY = 'xm_restore_payload_v1';
  const BATCH = 500, MAX_ROWS = 20000;
  const MODS = ['budget', 'recurring', 'game', 'smart', 'saving', 'settings', 'created'];
  const REQ = ['xm_accounts', 'xm_categories', 'xm_records'];
  const clone = o => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const fail = (msg, code) => { const e = new Error(msg); e.code = code || 'xm_restore'; return e; };

  /* ---------- SHA-256（纯 JS：xiaomi:// 页面里 crypto.subtle 不一定能用） ---------- */
  const KK = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const utf8 = s => new TextEncoder().encode(s);
  const sha256 = str => {
    const msg = utf8(str), len = msg.length, n = ((len + 9 + 63) >> 6) << 6;
    const b = new Uint8Array(n); b.set(msg); b[len] = 0x80;
    const dv = new DataView(b.buffer);
    dv.setUint32(n - 8, Math.floor(len / 0x20000000)); dv.setUint32(n - 4, (len << 3) >>> 0);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rot = (x, r) => (x >>> r) | (x << (32 - r));
    for (let o = 0; o < n; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15], c = w[i - 2];
        w[i] = (w[i - 16] + (rot(a, 7) ^ rot(a, 18) ^ (a >>> 3)) + w[i - 7] + (rot(c, 17) ^ rot(c, 19) ^ (c >>> 10))) >>> 0;
      }
      let [a, bb, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + KK[i] + w[i]) >>> 0;
        const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += bb; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return Array.from(H, x => x.toString(16).padStart(8, '0')).join('');
  };
  R.sha256 = sha256;

  // 清单摘要：每行 "rkey<TAB>h"，按 rkey 的 UTF-8 字节序排序，用换行连接，再算 sha256（与 xm_restore_seal 一致）
  const byteCmp = (x, y) => { const m = Math.min(x.length, y.length); for (let i = 0; i < m; i++) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; };
  const digest = items => items.map(x => ({ x, b: utf8(x.k) })).sort((p, q) => byteCmp(p.b, q.b)).map(p => p.x.k + '\t' + p.x.h).join('\n');
  R.digest = items => sha256(digest(items));

  // 与键顺序无关的 JSON（备份校验码用）：对象的键排序后再拼接
  const stable = v => {
    if (Array.isArray(v)) return '[' + v.map(x => (x === undefined ? 'null' : stable(x))).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    const s = JSON.stringify(v); return s === undefined ? 'null' : s;
  };

  /* ---------- 导出：去掉只属于这台手机的同步记录和冲突箱，加上校验信息 ---------- */
  R.exportObject = () => {
    const o = clone(App.S); delete o.sync; delete o.conflicts; delete o._manifest;
    const counts = { records: o.records.length, accounts: o.accounts.length, categories: o.cats.expense.length + o.cats.income.length, cats: Object.keys((o.game && o.game.cats) || {}).length };
    o._manifest = { app: 'xiaomi-jizhang', v: 1, at: new Date().toISOString(), counts, sha256: sha256(stable(o)) };
    return o;
  };
  R.exportText = () => JSON.stringify(R.exportObject());

  // 在「备份的账本」上调用同步工具（这些工具读 App.S）：同步代码里临时换一下，立刻换回来，中间没有 await
  const onLedger = (L, fn) => { const keep = App.S; App.S = L; try { return fn(); } finally { App.S = keep; } };

  /* ---------- 校验备份，算出恢复范围、要上传的行、清单和整块设置补丁 ---------- */
  R.validate = raw => {
    const errors = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['这不是有效的晓米记账备份文件'] };
    const man = raw._manifest;
    if (man !== undefined) {
      if (!man || typeof man !== 'object' || typeof man.sha256 !== 'string') errors.push('备份文件里的校验信息损坏了');
      else { const o = Object.assign({}, raw); delete o._manifest; if (sha256(stable(o)) !== man.sha256) errors.push('备份文件不完整或被改动过（校验码对不上）'); }
    }
    if (!Array.isArray(raw.records)) errors.push('备份里缺少账单');
    if (!Array.isArray(raw.accounts) || !raw.accounts.length) errors.push('备份里缺少账户');
    if (!raw.cats || typeof raw.cats !== 'object' || !Array.isArray(raw.cats.expense) || !Array.isArray(raw.cats.income) || !raw.cats.expense.length || !raw.cats.income.length) errors.push('备份里缺少分类');
    const game = raw.game && typeof raw.game === 'object' && !Array.isArray(raw.game) ? raw.game : null;
    const hasCats = !!game && has(game, 'cats');
    if (hasCats && (!game.cats || typeof game.cats !== 'object' || Array.isArray(game.cats))) errors.push('备份里的猫咪数据格式不对');
    if (errors.length) return { ok: false, errors };

    const body = Object.assign({}, raw); delete body._manifest; delete body.sync; delete body.conflicts;
    const L = App.normalize(clone(body));
    // normalize 会丢掉格式不对的条目、给空列表补默认值：数量对不上就说明会丢数据，拒绝
    const lost = raw.records.length - L.records.length;
    if (lost) errors.push(`有 ${lost} 笔账单的日期、金额或类型无效。为了不丢账，这份备份不能直接恢复`);
    if (L.accounts.length !== raw.accounts.length) errors.push('有账户缺少编号或格式不对');
    if (L.cats.expense.length !== raw.cats.expense.length || L.cats.income.length !== raw.cats.income.length) errors.push('有分类缺少编号或格式不对');
    if (errors.length) return { ok: false, errors };

    const tables = REQ.concat(hasCats ? ['xm_cats'] : []).sort();
    const rows = {}, manifest = {};
    let total = 0;
    onLedger(L, () => K().TABLES.forEach(t => {
      if (!tables.includes(t.name)) return;
      const items = t.list().map(it => { const row = t.toRow(it); return { k: String(row[t.key]), h: K().rowHash(t, row), row }; });
      const seen = new Set(), dup = new Set();
      items.forEach(x => { if (seen.has(x.k)) dup.add(x.k); seen.add(x.k); });
      if (dup.size) errors.push(`备份里有重复的编号（${Array.from(dup).slice(0, 3).join('、')}${dup.size > 3 ? '…' : ''}），不能恢复`);
      rows[t.name] = items.map(x => ({ h: x.h, row: x.row }));
      manifest[t.name] = { count: items.length, digest: R.digest(items) };
      total += items.length;
    }));
    if (total > MAX_ROWS) errors.push(`备份太大了（${total} 行，超过 ${MAX_ROWS} 行的上限）`);
    if (errors.length) return { ok: false, errors };

    // 整块设置：只放备份里真实存在的模块（看原始 JSON 有没有这个键，不看 normalize 补出来的默认值）
    const mods = MODS.filter(m => has(raw, m)).sort();
    const out = onLedger(L, () => K().stateOut());
    const statePatch = {};
    mods.forEach(m => { statePatch[m] = out[m] === undefined ? null : clone(out[m]); });
    const dates = L.records.map(r => r.date).sort();
    return {
      ok: true, errors: [], legacy: !man, L, rows, manifest, statePatch,
      scope: { tables, state_modules: mods },
      info: {
        at: man && man.at, records: L.records.length, accounts: L.accounts.length, categories: L.cats.expense.length + L.cats.income.length,
        cats: hasCats ? Object.keys(L.game.cats).length : null, from: dates[0] || '', to: dates[dates.length - 1] || '',
        missing: MODS.filter(m => !mods.includes(m)).concat(hasCats ? [] : ['cats'])
      }
    };
  };

  /* ---------- 本机任务记录 ---------- */
  const load = () => { try { const j = JSON.parse(localStorage.getItem(JOB_KEY) || 'null'); return j && j.v === 1 && j.id ? j : null; } catch (e) { return null; } };
  let job = load(), mem = null, tries = 0, sheet = null;
  const save = strict => {
    try { localStorage.setItem(JOB_KEY, JSON.stringify(job)); }
    catch (e) { if (strict) throw fail('手机存储空间不足，没能保存恢复任务，已停止（云端和本机都没有改动）', 'xm_job_save'); }
  };
  const dropPayload = () => { mem = null; try { localStorage.removeItem(PAY_KEY); } catch (e) { /* ignore */ } };
  const clearLocal = () => { job = null; tries = 0; dropPayload(); try { localStorage.removeItem(JOB_KEY); } catch (e) { /* ignore */ } };
  const payload = () => {
    if (mem && mem.id === job.id) return mem;
    try { const p = JSON.parse(localStorage.getItem(PAY_KEY) || 'null'); return p && p.id === job.id ? (mem = p) : null; } catch (e) { return null; }
  };
  // hold：正在开始恢复（读版本号、建任务之前）。这段时间里别的同步一律跳过，免得把未同步的修改抢先传上去、
  // 随后又被备份删掉（应该进冲突箱）
  let hold = false;
  R.job = () => job;
  R.pending = () => !!job || hold;
  R.clear = () => { clearLocal(); paint(); };
  const paint = () => { if (sheet && !sheet.closed) sheet.update(); if (C() && C().paint) C().paint(); };

  const uuid = () => {
    const b = new Uint8Array(16);
    try { crypto.getRandomValues(b); } catch (e) { for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  const rpc = (fn, args) => SB().call('POST', '/rest/v1/rpc/' + fn, { body: args });

  /* ---------- 状态机 ---------- */
  // 任务没法继续（任务不存在 / 已取消）：清掉本机记录，什么都没改
  let notice = '';
  const gone = msg => { clearLocal(); notice = msg; UI.toast(msg, 4200); paint(); };
  // 备份本身有问题、服务器拒收：先尽量在云端取消（暂存区从没碰过正式表），再清掉本机记录，报错
  const abort = async (msg, cancel) => {
    if (cancel) { try { await rpc('xm_restore_cancel', { p_job: job.id }); } catch (e) { /* 取消失败也没关系：未封存的任务不会生效 */ } }
    clearLocal(); notice = msg; paint();
    throw fail(msg, 'xm_restore_aborted');
  };
  // 以服务器为准：查一下这个任务现在的状态，接着做
  const adopt = async () => {
    const rows = await SB().select('xm_restore_job', 'select=state,result&job_id=eq.' + job.id);
    const r = rows && rows[0];
    if (!r) return gone('找不到这个恢复任务了，恢复没有生效（云端和本机都没有改动）');
    if (r.state === 'applied') { job.phase = 'applied'; job.result = r.result; }
    else if (r.state === 'sealed') job.phase = 'sealed';
    else if (r.state === 'staging') { job.phase = 'staging'; job.staged = {}; }
    else return gone('这个恢复任务已经取消了（云端和本机都没有改动）');
    save();
  };
  const BAD = /^xm_(bad_|too_large|manifest)/;

  const doCreate = async () => {
    let r;
    try { r = await rpc('xm_restore_create', { p_job: job.id, p_scope: job.scope }); }
    catch (e) {
      if (e.hint === 'xm_too_many_jobs') return abort('云端有好几个没完成的恢复任务（可能是别的手机正在恢复），请稍后再试', false);
      if (e.hint && /^xm_/.test(e.hint)) return abort('服务器拒绝了这次恢复：' + e.message, false);
      throw e;
    }
    if (r.state === 'staging') job.phase = 'staging';
    else if (r.state === 'sealed') job.phase = 'sealed';
    else if (r.state === 'applied') return adopt();
    else return gone('这个恢复任务已经取消了（云端和本机都没有改动）');
    save(); paint();
  };

  const doStage = async () => {
    const pay = payload();
    if (!pay) return abort('恢复在上传途中被打断了，这台手机上没能留下备份副本。请重新导入备份文件（云端和本机都没有改动）', true);
    for (const t of job.scope.tables) {
      const list = pay.rows[t] || [], n = Math.ceil(list.length / BATCH);
      for (let i = job.staged[t] || 0; i < n; i++) {
        try { await rpc('xm_restore_stage', { p_job: job.id, p_table: t, p_rows: list.slice(i * BATCH, (i + 1) * BATCH) }); }
        catch (e) {
          if (e.hint === 'xm_bad_state') return adopt();
          if (e.hint === 'xm_not_found') return gone('找不到这个恢复任务了，恢复没有生效（云端和本机都没有改动）');
          if (e.hint && BAD.test(e.hint)) return abort('云端不接受备份里的数据：' + e.message + (e.details ? '（' + e.details + '）' : ''), true);
          throw e;
        }
        job.staged[t] = i + 1; save(); paint();
      }
    }
    job.phase = 'sealing'; save();
  };

  const doSeal = async () => {
    try { await rpc('xm_restore_seal', { p_job: job.id, p_manifest: job.manifest, p_state_patch: job.statePatch }); }
    catch (e) {
      if (e.hint === 'xm_manifest_mismatch' && !job.resent) {   // 有批次没传完整：整份重传一次（同键覆盖，不影响结果）
        job.resent = true; job.staged = {}; job.phase = 'staging'; save();
        await doStage();
        if (job && job.phase === 'sealing') return doSeal();
        return;
      }
      if (e.hint === 'xm_bad_state') return adopt();
      if (e.hint === 'xm_not_found') return gone('找不到这个恢复任务了，恢复没有生效（云端和本机都没有改动）');
      if (e.hint && /^xm_/.test(e.hint)) return abort('上传的数据和备份核对不上，恢复已停止：' + e.message, true);
      throw e;
    }
    job.phase = 'sealed'; save(); dropPayload(); paint();
  };

  const doApply = async () => {
    let r;
    try { r = await rpc('xm_restore_apply', { p_job: job.id, p_expected_epoch: job.expected }); }
    catch (e) {
      if (e.hint === 'xm_epoch_changed') {   // 确认之后另一台设备又恢复了一次：停下来问用户
        let ep = null;
        try { ep = JSON.parse(e.details).epoch; } catch (x) { ep = null; }
        if (!Number.isInteger(ep)) ep = (await SB().readMeta()).epoch;
        job.ask = { epoch: ep }; save(); paint();
        return;
      }
      if (e.hint === 'xm_bad_state') return adopt();
      if (e.hint === 'xm_not_found') return gone('找不到这个恢复任务了，恢复没有生效（云端和本机都没有改动）');
      if (e.hint === 'xm_verify_failed') { job.failed = '云端核对没有通过，这次恢复已经整体撤回（云端没有任何改动）。可以重试，或者取消恢复。'; save(); paint(); return; }
      // 数据库语句超时（Supabase 默认 8 秒）：整个事务已回滚、云端没改。自动重试多半还是超时，停下来让用户决定
      if (e.code === '57014') { job.failed = '备份太大，云端没能在规定时间内处理完，这次恢复已经整体撤回（云端没有任何改动）。可以稍后重试，或者取消恢复。'; save(); paint(); return; }
      throw e;   // 网络断了、响应丢了：任务保持「已封存」，下次重试同一个任务（服务器端幂等）
    }
    job.phase = 'applied'; job.result = r; save(); paint();
  };

  // 网络问题：过一会儿自动再试（同一个任务）；有改动、回到前台、手动同步也会继续
  const retryLater = () => { tries++; if (tries <= 6) C().schedule(Math.min(60000, 2500 * Math.pow(2, tries - 1))); };

  // 由 App.cloud.sync 在同步开始时调用。返回 true：恢复已应用（或没有任务），可以接着对齐 / 普通同步；false：恢复还没完成，这次不做普通同步
  R.step = async () => {
    if (!job) return !hold;
    const u = SB().user();
    if (!u || u.id !== job.uid) { clearLocal(); paint(); return true; }   // 不是当前账号的任务
    if (job.ask || job.failed) return false;                                // 等用户决定
    try {
      if (job.phase === 'new') await doCreate();
      if (job && job.phase === 'staging') await doStage();
      if (job && job.phase === 'sealing') await doSeal();
      if (job && job.phase === 'sealed') await doApply();
      if (job) { delete job.err; save(); }
      tries = 0;
    } catch (e) {
      if (job) { job.err = e.message || String(e); save(); retryLater(); }
      paint();
      throw job ? fail('备份恢复还没完成：' + (e.message || e) + '（稍后会自动接着恢复）', e.code) : e;
    }
    paint();
    return !job || job.phase === 'applied';
  };

  // 应用成功之后的那次对齐：告诉 cloud.js 冲突项来自「导入备份」、快照叫什么、提示怎么写
  R.rebaseInfo = () => (job && job.phase === 'applied' ? {
    src: 'import', label: '恢复前备份',
    toast: n => (n ? `备份已恢复，这台手机也已更新；有 ${n} 条本机修改放进了冲突箱，等你处理` : '备份已恢复，云端和这台手机都已更新')
  } : null);
  // 一次同步成功之后调用：恢复已应用、本机也对齐到了新版本号 → 任务完成
  R.synced = () => {
    if (!job || job.phase !== 'applied') return;
    const m = App.S.sync, ep = job.result && job.result.epoch;
    if (m && Number.isInteger(ep) && m.epoch >= ep) { clearLocal(); notice = ''; paint(); }
  };

  /* ---------- 用户操作 ---------- */
  const idle = async () => { for (let i = 0; i < 300 && C().busy; i++) await new Promise(r => setTimeout(r, 100)); };
  let starting = false;
  R.start = async v => {
    if (starting) return false;
    if (job) throw fail('上一次的恢复还没完成，请先在「云端同步 → 恢复备份」里处理它');
    if (!SB().user()) throw fail('请先登录');
    starting = true;
    try {
      const c = C(), u = SB().user();
      const net = e => fail('恢复前要先确认云端账本的版本，但没成功：' + (e.message || e) + '。请联网后再试（云端和本机都没有改动）');
      await idle();
      hold = true;
      let r = await SB().readMeta().catch(e => { throw net(e); });
      if (!r.protocol) throw fail('云端还没升级到支持安全恢复的版本，暂时不能把备份恢复到云端账号（云端和本机都没有改动）');
      // 只确认版本号，不先上传：这台手机没同步的修改留在本机，恢复生效后按规则进冲突箱（而不是先传上去再被备份删掉）。
      // 本机落后（别的设备恢复过）或者还没在这台手机上同步过：先同步一次（落后时会先对齐，未同步修改进冲突箱）
      const fresh = () => { const m = App.S.sync; return m && m.uid === u.id && Number.isInteger(m.epoch) && m.epoch === r.epoch; };
      if (!fresh()) {
        hold = false;
        const ok = await c.sync(false);
        hold = true;
        if (!ok || c.err || c.halted) throw fail('恢复前要先和云端同步一次，但没成功' + (c.err ? '：' + c.err : '') + '。请联网后再试（云端和本机都没有改动）');
        r = await SB().readMeta().catch(e => { throw net(e); });
        if (!fresh()) throw fail('云端账本刚刚变过，请稍后再试（云端和本机都没有改动）');
      }
      if (job) throw fail('已经有一个恢复任务在进行了');   // 等待期间别处已经开始了一个（双保险）
      const m = App.S.sync;
      const counts = {}; Object.keys(v.rows).forEach(t => { counts[t] = v.rows[t].length; });
      job = { v: 1, id: uuid(), uid: u.id, email: u.email || '', phase: 'new', expected: m.epoch, scope: v.scope, manifest: v.manifest, statePatch: v.statePatch, staged: {}, counts, at: Date.now() };
      mem = { id: job.id, rows: v.rows };
      try { localStorage.setItem(PAY_KEY, JSON.stringify(mem)); } catch (e) { job.memOnly = true; }   // 太大存不下：只在内存里，中途被杀就要重新导入
      try { save(true); } catch (e) { job = null; dropPayload(); throw e; }
      notice = ''; tries = 0;
      paint();
      hold = false;
      c.sync(false);   // 推进任务（不等它结束，进度在恢复面板里看）
      return true;
    } finally { starting = false; hold = false; }
  };
  R.answer = go => {
    if (!job || !job.ask) return;
    if (go) { job.expected = job.ask.epoch; delete job.ask; save(); paint(); C().sync(false); }
    else R.cancel();
  };
  R.retry = () => { if (!job) return; delete job.failed; delete job.err; tries = 0; save(); paint(); C().sync(false); };
  R.cancel = async () => {
    if (!job) return true;
    if (job.phase === 'applied') { UI.toast('恢复已经生效，不能取消'); return false; }
    try { await rpc('xm_restore_cancel', { p_job: job.id }); }
    catch (e) {
      if (e.hint === 'xm_bad_state') {   // 其实已经生效了：按已生效处理
        await adopt().catch(() => {});
        if (job && job.phase === 'applied') { UI.toast('恢复已经生效，不能取消，正在更新这台手机…', 3000); C().sync(false); return false; }
      } else if (e.hint !== 'xm_not_found') { UI.toast('取消失败：' + (e.message || e) + '（请联网后再试）', 3600); return false; }
    }
    clearLocal(); notice = '';
    UI.toast('已取消恢复，云端和这台手机都没有改动', 2600);
    paint(); C().schedule(300);
    return true;
  };
  // 退出登录：没生效的任务尽量在云端取消，再清掉本机记录（已生效的不用管：重新登录会按版本号自动对齐）
  R.abandon = async () => {
    if (!job) return;
    if (job.phase !== 'applied') { try { await rpc('xm_restore_cancel', { p_job: job.id }); } catch (e) { /* 离线也照样退出 */ } }
    clearLocal(); paint();
  };

  R.status = () => {
    if (!job && hold) return { tone: 'run', short: '准备中', text: '正在准备恢复…' };
    if (!job) return notice ? { tone: 'err', text: notice, short: '' } : null;
    if (job.phase === 'applied' && C().err && !C().busy) return { tone: 'warn', short: '更新本机', phase: 'applied', done: 0, total: 0, text: '备份已经恢复到云端，但这台手机还没更新：' + C().err };
    if (job.ask) return { tone: 'ask', short: '等你确认', text: `你确认恢复之后，另一台设备也恢复了一次备份（云端账本已经是第 ${job.ask.epoch} 版）。要继续用你选的这份备份覆盖，还是取消这次恢复？` };
    if (job.failed) return { tone: 'err', short: '没成功', text: job.failed };
    let total = 0, done = 0;
    job.scope.tables.forEach(t => { const n = Math.ceil((job.counts[t] || 0) / BATCH); total += n; done += Math.min(n, job.staged[t] || 0); });
    const T = {
      new: ['准备中…', '准备中'], staging: [`正在上传备份（${done}/${total} 批）`, '上传中'], sealing: ['正在核对上传的数据…', '核对中'],
      sealed: ['正在把备份应用到云端…', '应用中'], applied: ['已经应用到云端，正在更新这台手机…', '更新本机']
    }[job.phase] || ['恢复中…', '恢复中'];
    return { tone: job.err ? 'warn' : 'run', short: T[1], text: T[0] + (job.err ? `（${job.err}；稍后会自动接着恢复）` : ''), done, total, phase: job.phase };
  };

  /* ---------- 界面 ---------- */
  const MOD = { budget: '预算', recurring: '周期记账', game: '金币、签到、客栈', smart: '智能预算', saving: '存钱计划', settings: '外观等设置', created: '账本创建时间', cats: '猫咪' };
  const ymdOf = iso => { const d = new Date(iso); return isNaN(d) ? '' : `${U.ymd(d)} ${U.pad(d.getHours())}:${U.pad(d.getMinutes())}`; };

  // 「数据与备份 → 导入备份」选了文件之后
  A.importBackup = raw => {
    const v = R.validate(raw);
    if (!v.ok) { UI.confirm({ title: '这份备份不能恢复', msg: v.errors.join('；'), ok: '知道了', cancel: '关闭' }); return; }
    if (SB().user()) { A.restoreConfirm(v); return; }
    // 没登录（只在本机调试时会出现）：只覆盖这台手机
    UI.confirm({ title: '用备份覆盖当前数据？', msg: `备份里有 ${v.info.records} 笔记录，当前的 ${App.S.records.length} 笔会被替换。`, ok: '覆盖导入', danger: true }).then(ok => {
      if (!ok) return;
      const body = Object.assign({}, raw); delete body._manifest; delete body.sync;
      body.conflicts = App.S.conflicts;
      App.replaceState(body); UI.closeAll(); UI.toast('导入成功');
    });
  };

  // 恢复确认页
  A.restoreConfirm = v => {
    const u = SB().user(), i = v.info, n = App.conflicts ? App.conflicts.pending().length : 0;
    const scope = ['账单', '账户', '分类'].concat(i.cats != null ? ['猫咪'] : []).concat(v.scope.state_modules.map(m => MOD[m]));
    UI.sheet({
      title: '恢复备份到云端', cls: 'tall',
      render: () => `<div class="form rs-form">
        <div class="rs-box"><div class="rs-row"><span>账号</span><b>${esc(u.email || '已登录')}</b></div>
          <div class="rs-row"><span>备份内容</span><b>${i.records} 笔账单 · ${i.accounts} 个账户 · ${i.categories} 个分类${i.cats != null ? ` · ${i.cats} 只猫咪` : ''}</b></div>
          ${i.from ? `<div class="rs-row"><span>账单日期</span><b>${esc(i.from)} ～ ${esc(i.to)}</b></div>` : ''}
          ${i.at ? `<div class="rs-row"><span>备份时间</span><b>${esc(ymdOf(i.at))}</b></div>` : ''}
          <div class="rs-row"><span>恢复范围</span><b>${esc(scope.join('、'))}</b></div>
          ${i.missing.length ? `<div class="rs-row"><span>备份里没有</span><b>${esc(i.missing.map(m => MOD[m]).join('、'))}（保留云端现有的，不会被清空）</b></div>` : ''}</div>
        <ul class="rs-warn">
          <li><b>云端账本会被这份备份替换。</b>云端有、备份里没有的账单会被标记为删除（云端会留一份存档，不会彻底删掉）。</li>
          <li><b>其他手机要先更新 App。</b>恢复成功后，没有更新到这个版本的晓米记账将无法再同步。</li>
          <li><b>这台手机还没同步的修改、恢复途中新记的账</b>，会放进「冲突箱」，由你决定要不要加回去，不会被悄悄丢掉。${n ? `（冲突箱里现在还有 ${n} 条没处理）` : ''}</li>
          ${v.legacy ? '<li><b>这是旧版 App 导出的备份，</b>没有校验信息，无法确认文件完整。请确认它是你自己导出的那份。</li>' : ''}
          <li>恢复期间请保持联网；中途断网或退出 App，下次打开会接着恢复同一个任务。生效之前云端和这台手机都不会被改动，随时可以取消。</li>
        </ul>
        <button class="btn danger wide" data-rs="go">开始恢复</button>
        <button class="btn wide" data-rs="no">取消</button>
      </div>`,
      onMount: h => {
        h.body.addEventListener('click', async e => {
          const b = e.target.closest('[data-rs]'); if (!b) return;
          if (b.dataset.rs === 'no') { h.close(); return; }
          if (starting || b.disabled) return;
          b.disabled = true; b.textContent = '正在准备…';
          try {
            if (await R.start(v)) { UI.closeAll(); A.openRestore(); }
          } catch (er) {
            UI.toast(er.message || '没能开始恢复', 4200);
            if (!h.closed) { b.disabled = false; b.textContent = '开始恢复'; }
          }
        });
      }
    });
  };

  // 恢复进度（也从「云端同步」面板进入）
  A.openRestore = () => {
    let tick = null;
    sheet = UI.sheet({
      title: '恢复备份', cls: 'compact',
      render: () => {
        const s = R.status();
        if (!s) return '<div class="form"><p class="hint">没有正在进行的恢复。</p></div>';
        const busy = C().busy, pct = s.total ? Math.round(s.done / s.total * 100) : 0;
        const steps = ['new', 'staging', 'sealing', 'sealed', 'applied'], at = steps.indexOf(s.phase);
        return `<div class="form rs-form">
          <p class="rs-msg ${s.tone}">${esc(s.text)}</p>
          ${s.phase ? `<div class="rs-bar"><i style="width:${s.phase === 'staging' ? pct : at >= 2 ? 100 : 4}%"></i></div>` : ''}
          ${s.tone === 'ask' ? '<button class="btn danger wide" data-rs="cont">继续用这份备份覆盖</button><button class="btn wide" data-rs="cancel">取消恢复</button>' : ''}
          ${s.tone === 'err' && job ? '<button class="btn primary wide" data-rs="retry">重试</button><button class="btn wide" data-rs="cancel">取消恢复</button>' : ''}
          ${(s.tone === 'run' || s.tone === 'warn') ? `${s.tone === 'warn' ? `<button class="btn primary wide" data-rs="retry" ${busy ? 'disabled' : ''}>现在重试</button>` : ''}${s.phase !== 'applied' ? '<button class="btn wide" data-rs="cancel">取消恢复</button>' : ''}` : ''}
          <p class="hint">恢复生效之前，云端和这台手机的账本都不会被改动；取消也不会留下任何改动。</p>
        </div>`;
      },
      onMount: h => {
        tick = setInterval(() => { if (!h.closed) h.update(); }, 700);
        h.body.addEventListener('click', async e => {
          const b = e.target.closest('[data-rs]'); if (!b || b.disabled) return;
          b.disabled = true;
          const a = b.dataset.rs;
          if (a === 'cont') R.answer(true);
          else if (a === 'retry') R.retry();
          else if (a === 'cancel') {
            if (await UI.confirm({ title: '取消这次恢复？', msg: '云端和这台手机的账本都会保持原样。', ok: '取消恢复', cancel: '继续恢复', danger: true })) await R.cancel();
          }
          h.update();
        });
      },
      onClose: () => { clearInterval(tick); sheet = null; }
    });
  };
})();

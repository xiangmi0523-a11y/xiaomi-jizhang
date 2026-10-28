/* 晓米记账 · 安全持久化（方案 A，协议 v1；设计见 docs/snapshot-native-design.md）
 *
 * - 原生 App：通过 postMessage { type: 'durable', v: 1, op, id, ... } 请求原生层持久写入；
 *   只有原生层主动回执、编号匹配、ok === true、并且原生层「从磁盘读回」算出的字节数和 SHA-256 等于这里事先算好的值，才算成功。
 *   超时、失败回执、摘要或字节数不一致、编号不认识、迟到的回执、页面重载前发出的请求，一律算失败。
 * - 没有原生能力声明（网页版 / PWA / 协议版本不同）：降级到 localStorage，同样要求写入成功，否则安全停止。绝不伪造成功。
 * - 账本原子提交 commitLedger：原生 = 暂存 → 提交（原子改名）→ 回执成功后才切换内存；降级 = 一次 setItem 成功后才切换内存。
 */
(() => {
  'use strict';
  const App = window.App;
  const D = App.durable = {};
  const PROTO = 1;
  const LS_KEY = 'xiaomi_ledger_v1';   // 与 core.js 一致
  const SNAP_PREFIX = 'xm_snap:';      // 降级路径的快照键：xm_snap:<dir>:<name>
  const fail = (code, msg) => { const e = new Error(msg); e.code = code; return e; };
  D.fail = fail;

  /* ---------- SHA-256（纯 JS：xiaomi:// 页面里 crypto.subtle 不一定能用） ---------- */
  const KK = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const utf8 = s => new TextEncoder().encode(s);
  const shaBytes = msg => {
    const len = msg.length, n = ((len + 9 + 63) >> 6) << 6;
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
  D.sha256 = s => shaBytes(utf8(s));
  // 一次编码同时得到 UTF-8 字节数和 SHA-256（大账本只编码一次）
  D.measure = s => { const b = utf8(s); return { bytes: b.length, sha256: shaBytes(b) }; };

  /* ---------- 诊断日志（最多 50 条，同时输出到控制台） ---------- */
  D.log = [];
  D.diag = (kind, msg, extra) => {
    const e = Object.assign({ at: Date.now(), kind, msg }, extra || {});
    D.log.push(e); if (D.log.length > 50) D.log.shift();
    try { console.info('[xm-durable]', kind, msg, extra || ''); } catch (x) { /* ignore */ }
  };
  if (window.__NATIVE_RECOVERY__ && (window.__NATIVE_RECOVERY__.uncommitted || window.__NATIVE_RECOVERY__.tmpRemoved)) {
    D.diag('boot', '启动时发现上次未完成的提交或临时文件，已按「以正式账本为准」处理', window.__NATIVE_RECOVERY__);
  }
  // 原生普通保存失败（不再静默）：记日志，提示一次
  let warned = false;
  D.onSaveError = (what, msg) => {
    D.lastSaveError = { at: Date.now(), what, msg };
    D.diag('save-error', what + '保存失败：' + msg);
    if (!warned && App.UI) { warned = true; App.UI.toast(`手机存储空间可能不足，${what}没能保存到文件：${msg}`, 4200); }
  };

  /* ---------- 原生通道 ---------- */
  D.native = () => {
    const c = window.__NATIVE_CAPS__;
    return !!(c && c.durableWrite === PROTO && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native);
  };
  const page = Math.random().toString(36).slice(2, 10);   // 页面实例随机数：重载后旧请求的回执编号一定不认识
  let seq = 0;
  const wait = {};
  D.timeouts = { snapshotWrite: 20000, ledgerStage: 20000, ledgerCommit: 15000, ledgerDiscard: 15000, snapshotList: 20000, snapshotRead: 30000, snapshotDelete: 15000, perMB: 4000 };
  D.pending = () => Object.keys(wait).length;

  const call = (op, args, mb) => new Promise((resolve, reject) => {
    if (!D.native()) { reject(fail('no_native', '没有原生持久化能力')); return; }
    const id = 'd' + page + '_' + (++seq);
    const ms = (D.timeouts[op] || 15000) + Math.ceil(mb || 0) * D.timeouts.perMB;
    const t = setTimeout(() => {
      if (!wait[id]) return;
      delete wait[id];
      D.diag('timeout', op + ' 没有在 ' + ms + ' 毫秒内收到回执', { id });
      reject(fail('timeout', '没有收到手机存储的确认（超时）'));
    }, ms);
    wait[id] = { op, resolve, reject, t };
    try { window.webkit.messageHandlers.native.postMessage(Object.assign({ type: 'durable', v: PROTO, op, id }, args)); }
    catch (e) { clearTimeout(t); delete wait[id]; reject(fail('EIO', '没能把请求交给手机存储：' + (e.message || e))); }
  });

  // 原生层回执：编号不认识（迟到、重载前的、伪造的）一律丢弃，不执行任何回调
  D.done = (id, b64) => {
    const w = wait[id];
    if (!w) { D.diag('stale-receipt', '收到不认识的回执，已忽略', { id }); return; }
    delete wait[id]; clearTimeout(w.t);
    let r = null;
    try { const bin = atob(b64 || ''); r = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)))); } catch (e) { r = null; }
    if (!r || r.v !== PROTO || r.id !== id || r.op !== w.op) { w.reject(fail('bad_receipt', '手机存储的确认格式不对')); return; }
    if (r.ok !== true) { w.reject(fail(r.code || 'EIO', r.message || '手机存储写入失败')); return; }
    w.resolve(r);
  };

  // 写类回执：原生层从磁盘读回的字节数和 SHA-256 必须等于事先算好的值
  const verify = (r, m, what) => {
    if (r.bytes !== m.bytes || String(r.sha256 || '').toLowerCase() !== m.sha256) {
      D.diag('mismatch', what + '的确认与写入内容不一致', { expect: m, got: { bytes: r.bytes, sha256: r.sha256 } });
      throw fail('mismatch', '手机存储的确认与写入内容不一致');
    }
    return r;
  };

  /* ---------- 快照 ---------- */
  const isQuota = e => e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014 || /quota/i.test(e.message || ''));

  // 写快照：{ dir, name, content, meta } → { store, dir, name, bytes, sha256 }；失败抛错（带 code）
  D.writeSnapshot = async ({ dir, name, content, meta }) => {
    const m = D.measure(content);
    const fullMeta = Object.assign({ v: 1 }, meta, { bytes: m.bytes, sha256: m.sha256 });
    if (D.native()) {
      const r = await call('snapshotWrite', { dir, name, content, bytes: m.bytes, sha256: m.sha256, meta: fullMeta }, m.bytes / 1048576);
      verify(r, m, '快照');
      return { store: 'native', dir, name, bytes: m.bytes, sha256: m.sha256 };
    }
    try { localStorage.setItem(SNAP_PREFIX + dir + ':' + name, JSON.stringify({ meta: fullMeta, data: content })); }
    catch (e) { throw fail(isQuota(e) ? 'quota' : 'EIO', isQuota(e) ? '浏览器的存储空间不够' : '浏览器存储写入失败：' + (e.message || e)); }
    return { store: 'local', dir, name, bytes: m.bytes, sha256: m.sha256 };
  };

  // 列出快照：[{ store, dir, name, bytes, sha256, verified, meta, error }]
  D.listSnapshots = async () => {
    if (D.native()) { const r = await call('snapshotList', {}); return (r.items || []).map(x => Object.assign({ store: 'native' }, x)); }
    const out = [];
    let keys = [];
    try { keys = Object.keys(localStorage); } catch (e) { keys = []; }
    keys.forEach(k => {
      if (k === 'xm_snap_rebase') {   // 2B-2 开发期间的旧格式：批次未知，只列出、永不自动删除
        try { const o = JSON.parse(localStorage.getItem(k)); out.push({ store: 'local', legacy: true, dir: '', name: k, bytes: utf8(o.data).length, sha256: D.sha256(o.data), verified: false, meta: { at: o.at, label: '旧版对齐前备份', uid: (JSON.parse(o.data).sync || {}).uid || '' }, error: '旧格式，没有校验信息' }); } catch (e) { /* ignore */ }
        return;
      }
      if (!k.startsWith(SNAP_PREFIX)) return;
      const rest = k.slice(SNAP_PREFIX.length), i = rest.indexOf(':');
      const e = { store: 'local', dir: rest.slice(0, i), name: rest.slice(i + 1) };
      try {
        const o = JSON.parse(localStorage.getItem(k));
        const m = D.measure(o.data);
        Object.assign(e, { bytes: m.bytes, sha256: m.sha256, meta: o.meta, verified: !!o.meta && o.meta.bytes === m.bytes && o.meta.sha256 === m.sha256 });
      } catch (x) { Object.assign(e, { verified: false, error: '快照无法读取' }); }
      out.push(e);
    });
    return out.sort((a, b) => (a.dir + a.name).localeCompare(b.dir + b.name));
  };

  // 读快照：校验原生层读回的 SHA-256，并在这里再算一遍
  D.readSnapshot = async (dir, name) => {
    let r;
    if (D.native()) r = await call('snapshotRead', { dir, name }, 8);
    else {
      let o = null;
      try { o = JSON.parse(localStorage.getItem(dir ? SNAP_PREFIX + dir + ':' + name : name) || 'null'); } catch (e) { o = null; }
      if (!o) throw fail('ENOENT', '找不到这份快照');
      r = { content: o.data, meta: o.meta || null };
    }
    const m = D.measure(r.content || '');
    if (D.native() && (r.bytes !== m.bytes || r.sha256 !== m.sha256)) throw fail('mismatch', '快照在传输中被改动了');
    const verified = !!r.meta && r.meta.bytes === m.bytes && r.meta.sha256 === m.sha256;
    return { content: r.content, meta: r.meta, bytes: m.bytes, sha256: m.sha256, verified };
  };

  // 删除批次目录：[{ dir, ok, code }]；失败不抛错，逐个回报
  D.deleteSnapshots = async dirs => {
    if (!dirs.length) return [];
    if (D.native()) { const r = await call('snapshotDelete', { dirs }); return r.items || []; }
    return dirs.map(dir => {
      try {
        const ks = Object.keys(localStorage).filter(k => k.startsWith(SNAP_PREFIX + dir + ':'));
        ks.forEach(k => localStorage.removeItem(k));
        return { dir, ok: true, code: ks.length ? 'deleted' : 'absent' };
      } catch (e) { return { dir, ok: false, code: 'EIO', message: String(e.message || e) }; }
    });
  };

  /* ---------- 账本原子提交 ---------- */
  // after：覆盖后完整账本的 JSON；same()：内存账本还是计算 after 时的那份；apply()：同步切换内存（只在确认持久化后调用）
  // 抛错：code 'xm_retry'（期间账本被改了，调用方重新计算）或存储错误（本机账本保持原样）
  D.commitLedger = async (after, same, apply) => {
    const retry = () => fail('xm_retry', '对齐时账本刚好有改动，马上重新对齐');
    if (!D.native()) {
      if (!same()) throw retry();
      try { localStorage.setItem(LS_KEY, after); }
      catch (e) { throw fail(isQuota(e) ? 'quota' : 'EIO', isQuota(e) ? '浏览器的存储空间不够' : '浏览器存储写入失败：' + (e.message || e)); }
      apply();   // 同一段同步代码里，中间没有 await
      return { store: 'local' };
    }
    const m = D.measure(after), mb = m.bytes / 1048576;
    verify(await call('ledgerStage', { content: after, bytes: m.bytes, sha256: m.sha256 }, mb), m, '暂存的账本');
    if (!same()) {
      call('ledgerDiscard', {}).catch(e => D.diag('discard', '删除暂存账本失败（启动时会清理）：' + e.message));
      throw retry();
    }
    try { verify(await call('ledgerCommit', { bytes: m.bytes, sha256: m.sha256 }, mb), m, '提交的账本'); }
    catch (e) {
      // 提交没有被确认：内存不切换。正式文件可能是旧的、也可能已经是新的（回执丢了），立刻把当前内存写回，两者一致
      if (App.flush) App.flush();
      throw e;
    }
    if (!same()) {   // 等提交回执期间账本被改了：保留这次改动，写回正式文件，重新对齐
      if (App.flush) App.flush();
      throw retry();
    }
    apply();
    return { store: 'native' };
  };
})();

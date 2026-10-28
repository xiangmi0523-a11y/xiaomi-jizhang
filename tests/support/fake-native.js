// 测试用的「假原生层」：在 Node 进程里模拟 ios/Sources/DurableStore.swift 的协议 v1（docs/snapshot-native-design.md）
//   - 文件存在 Node 的内存里（页面重载后还在），SHA-256 用 Node crypto 独立计算（不依赖页面里的实现）
//   - 普通保存 save 和 durable 操作按收到的顺序执行（与原生的串行 IO 队列一致）
//   - 可以注入回执故障：失败、永不回执、延迟、编号错、字节数错、SHA-256 错、迟到、执行了但回执丢失、扣住回执由测试放行
//   - boot()：模拟原生启动时的恢复（暂存文件还在 → 移走，以正式账本为准），返回要注入的正式账本
'use strict';
const crypto = require('crypto');

const MAIN = 'Documents/xiaomi-data.json', NEXT = 'Documents/.xiaomi-data.next.json', SNAP = 'Documents/安全快照/';
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const DIR_RE = /^[A-Za-z0-9_-]{1,120}$/;
const validName = n => typeof n === 'string' && n.length > 0 && n.length <= 150 && !n.startsWith('.') && n.endsWith('.json') && !n.endsWith('.meta.json') && !n.includes('/');

class FakeNative {
  constructor() {
    this.files = new Map();     // 路径 → Buffer
    this.faults = [];           // { op, mode, code, ms, times }
    this.calls = [];            // 收到的请求（不含大内容）
    this.held = [];             // 扣住的回执：{ id, b64 }
    this.diag = [];             // 启动时移走的未完成提交
    this.saves = 0;
  }
  main() { const b = this.files.get(MAIN); return b ? b.toString('utf8') : null; }
  mainJSON() { const m = this.main(); return m ? JSON.parse(m) : null; }
  hasNext() { return this.files.has(NEXT); }
  snapshots() {
    return Array.from(this.files.keys()).filter(k => k.startsWith(SNAP) && k.endsWith('.json') && !k.endsWith('.meta.json'))
      .map(k => { const [dir, name] = k.slice(SNAP.length).split('/'); return { dir, name, path: k, meta: this.meta(dir, name), data: this.files.get(k).toString('utf8') }; });
  }
  meta(dir, name) { const b = this.files.get(SNAP + dir + '/' + name.replace(/\.json$/, '.meta.json')); return b ? JSON.parse(b.toString('utf8')) : null; }
  fault(f) { this.faults.push(Object.assign({ times: 1 }, f)); return this; }
  takeFault(op) {
    const i = this.faults.findIndex(f => f.op === op || f.op === '*');
    if (i < 0) return null;
    const f = this.faults[i];
    if (--f.times <= 0) this.faults.splice(i, 1);
    return f;
  }

  // 原生启动：残留的暂存文件说明上次提交没完成 → 移走；返回正式账本（base64）和恢复信息
  boot() {
    const info = { tmpRemoved: 0, errors: [] };
    if (this.files.has(NEXT)) { this.diag.push(this.files.get(NEXT)); this.files.delete(NEXT); info.uncommitted = 'uncommitted-test.json'; }
    const m = this.files.get(MAIN);
    return { b64: m ? m.toString('base64') : null, info };
  }

  // 执行一个请求，返回 { id, b64, delay, deliver }（deliver: false 表示不回执）
  handle(msg) {
    if (msg.type === 'save') { this.files.set(MAIN, Buffer.from(msg.data, 'utf8')); this.saves++; return null; }
    if (msg.type !== 'durable') return null;
    const { op, id } = msg;
    this.calls.push({ op, id, at: Date.now(), dir: msg.dir, dirs: msg.dirs, bytes: msg.bytes });
    const f = this.takeFault(op);
    let r = { v: 1, id, op };
    const err = (code, message) => { const e = new Error(message); e.code = code; throw e; };
    const doIt = () => {
      if (msg.v !== 1) err('unsupported_version', '不支持的协议版本');
      const transport = () => {
        const b = Buffer.from(msg.content, 'utf8');
        if (b.length !== msg.bytes || sha(b) !== msg.sha256) err('transport', '收到的内容与请求声明的不一致');
        return b;
      };
      switch (op) {
        case 'snapshotWrite': {
          if (!DIR_RE.test(msg.dir || '') || !validName(msg.name)) err('bad_request', '名字不合法');
          const b = transport(), base = SNAP + msg.dir + '/';
          this.files.set(base + msg.name, b);
          this.files.set(base + msg.name.replace(/\.json$/, '.meta.json'), Buffer.from(JSON.stringify(msg.meta), 'utf8'));
          return { dir: msg.dir, name: msg.name, bytes: b.length, sha256: sha(b) };
        }
        case 'ledgerStage': { const b = transport(); this.files.set(NEXT, b); return { bytes: b.length, sha256: sha(b) }; }
        case 'ledgerCommit': {
          const b = this.files.get(NEXT);
          if (!b) err('stage_missing', '找不到暂存的账本');
          if (b.length !== msg.bytes || sha(b) !== msg.sha256) err('stage_mismatch', '暂存的账本与要提交的不一致');
          if (f && f.mode === 'commitFail') err(f.code || 'EACCES', '注入：替换正式账本失败');
          this.files.set(MAIN, b); this.files.delete(NEXT);
          return { bytes: b.length, sha256: sha(b) };
        }
        case 'ledgerDiscard': this.files.delete(NEXT); return {};
        case 'snapshotList': {
          const items = this.snapshots().map(s => {
            const b = this.files.get(s.path), h = sha(b);
            return { dir: s.dir, name: s.name, bytes: b.length, sha256: h, meta: s.meta, verified: !!s.meta && s.meta.bytes === b.length && s.meta.sha256 === h, mtime: 0 };
          });
          return { items };
        }
        case 'snapshotRead': {
          const b = this.files.get(SNAP + msg.dir + '/' + msg.name);
          if (!b) err('ENOENT', '快照不存在');
          const m = this.meta(msg.dir, msg.name), h = sha(b);
          return { dir: msg.dir, name: msg.name, content: b.toString('utf8'), bytes: b.length, sha256: h, meta: m, verified: !!m && m.bytes === b.length && m.sha256 === h };
        }
        case 'snapshotDelete': {
          return { items: (msg.dirs || []).map(dir => {
            if (!DIR_RE.test(dir)) return { dir, ok: false, code: 'bad_request' };
            if (f && f.mode === 'deleteFail') return { dir, ok: false, code: 'EIO', message: '注入：删除失败' };
            const ks = Array.from(this.files.keys()).filter(k => k.startsWith(SNAP + dir + '/'));
            ks.forEach(k => this.files.delete(k));
            return { dir, ok: true, code: ks.length ? 'deleted' : 'absent' };
          }) };
        }
        default: err('bad_request', '未知操作');
      }
    };
    let performed = true;
    try {
      if (f && f.mode === 'fail') err(f.code || 'EIO', '注入：' + (f.code || 'EIO'));
      if (f && f.mode === 'never') { performed = false; return { id, deliver: false }; }   // 没执行，也不回执
      Object.assign(r, doIt(), { ok: true });
    } catch (e) { r = Object.assign(r, { ok: false, code: e.code || 'EIO', message: e.message }); }
    if (f && f.mode === 'badBytes' && r.ok) r.bytes = (r.bytes || 0) + 1;
    if (f && f.mode === 'badSha' && r.ok) r.sha256 = '0'.repeat(64);
    let rid = id;
    if (f && f.mode === 'wrongId') rid = id + 'x';
    if (f && f.mode === 'wrongId') r.id = rid;
    const b64 = Buffer.from(JSON.stringify(r), 'utf8').toString('base64');
    if (f && f.mode === 'lose') return { id, deliver: false, performed };                   // 执行了，回执丢了
    if (f && f.mode === 'hold') { this.held.push({ id: rid, b64 }); return { id, deliver: false, performed }; }
    return { id: rid, b64, delay: f && (f.mode === 'delay' || f.mode === 'late') ? f.ms : 0, deliver: true };
  }
}

module.exports = { FakeNative, MAIN, NEXT, SNAP, sha };

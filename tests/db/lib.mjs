// 数据库协议测试的公共工具（由 run.mjs 启动环境后，通过 XM_DB_ENV 传入连接信息）
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

import { rec, acc, cat, kitty, KEYS, fp, digest, planFor } from './protocol.mjs';
export { rec, acc, cat, kitty, KEYS, fp, digest, planFor };
export const ENV = JSON.parse(fs.readFileSync(process.env.XM_DB_ENV, 'utf8'));
export const BASE = 'xm_base', PROT = 'xm_prot';

export const dbUrl = (db, user = null) => { const u = new URL(ENV.superUrl); u.pathname = '/' + db; if (user) { u.username = user; u.password = ''; } return u.toString(); };

// 以超级用户执行 SQL，返回结果（-A -t：无表头、竖线分隔）
export function sql(db, text, { user = null } = {}) {
  const r = spawnSync('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', dbUrl(db, user)], { input: text, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('SQL 失败：' + r.stderr + '\n' + text.slice(0, 300));
  return r.stdout.trim();
}
export const sqlFile = (db, file, { user = null } = {}) => {
  const r = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', dbUrl(db, user), '-f', file], { encoding: 'utf8' });
  return { ok: r.status === 0, out: r.stdout, err: r.stderr };
};

// 新建一个隔离的库（回滚测试、变异测试用）
export function freshDb(name, { migrate = true } = {}) {
  sql('postgres', `drop database if exists ${name} with (force); create database ${name} owner xm_owner;`);
  must(sqlFile(name, ENV.emulation));
  must(sqlFile(name, ENV.schema, { user: 'xm_owner' }));
  if (migrate) must(sqlFile(name, ENV.migration, { user: 'xm_owner' }));
  return name;
}
const must = r => { if (!r.ok) throw new Error(r.err); return r; };

// ---------- 用户与 JWT ----------
const b64u = b => Buffer.from(b).toString('base64url');
export function jwtFor(uid, role = 'authenticated') {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ sub: uid, role, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }));
  const sig = crypto.createHmac('sha256', ENV.jwtSecret).update(head + '.' + body).digest('base64url');
  return `${head}.${body}.${sig}`;
}
export function newUser(...dbs) {
  const id = crypto.randomUUID();
  for (const db of dbs) sql(db, `insert into auth.users (id, email) values ('${id}', '${id.slice(0, 8)}@example.test')`);
  return { id, jwt: jwtFor(id) };
}

// ---------- 通过真实的 PostgREST 发请求 ----------
export async function api(db, user, method, path, { body, headers = {}, prefer } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (user) h.Authorization = 'Bearer ' + user.jwt;
  if (prefer) h.Prefer = prefer;
  const r = await fetch(ENV.rest[db] + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: r.status, json, text };
}
export const rpc = (db, user, fn, args, opts = {}) => api(db, user, 'POST', '/rpc/' + fn, { body: args, ...opts });
export const select = (db, user, table, q = 'select=*') => api(db, user, 'GET', `/${table}?${q}`);

// 和现在 cloud.js 一样的写法（旧版客户端）：upsert 不带版本号请求头
export const legacyUpsert = (db, user, table, rows, key = 'id') =>
  api(db, user, 'POST', `/${table}?on_conflict=user_id,${key}`, { body: rows.map(r => ({ user_id: user.id, ...r, deleted: false })), prefer: 'resolution=merge-duplicates,return=representation' });   // 与 cloud.js 一样总是带 deleted: false
// 新版客户端：带 x-xm-epoch
export const epochUpsert = (db, user, table, rows, epoch, key = 'id') =>
  api(db, user, 'POST', `/${table}?on_conflict=user_id,${key}`, { body: rows.map(r => ({ user_id: user.id, ...r, deleted: false })), prefer: 'resolution=merge-duplicates,return=representation', headers: { 'x-xm-epoch': String(epoch) } });
export const legacyMarkDeleted = (db, user, table, keys, key = 'id', headers = {}) =>
  api(db, user, 'PATCH', `/${table}?${key}=in.(${encodeURIComponent(keys.map(k => `"${k}"`).join(','))})`, { body: { deleted: true }, prefer: 'return=representation', headers });

// 给某个用户塞一份「云端现状」（以内部身份写，不受版本号检查影响）
export function seed(db, uid, { records = [], accounts = [], categories = [], cats = [], state = null } = {}) {
  const ins = (t, rows) => rows.length && sql(db, `insert into public.${t} select * from jsonb_populate_recordset(null::public.${t}, '${JSON.stringify(rows.map(r => ({ user_id: uid, deleted: false, ...r }))).replace(/'/g, "''")}'::jsonb)`, { user: 'xm_owner' });
  ins('xm_records', records); ins('xm_accounts', accounts); ins('xm_categories', categories); ins('xm_cats', cats);
  if (state) sql(db, `insert into public.xm_state (user_id, data) values ('${uid}', '${JSON.stringify(state).replace(/'/g, "''")}'::jsonb)`, { user: 'xm_owner' });
}
// 以超级用户读出某用户某张表（绕过 RLS）
export const rows = (db, table, uid, where = 'true') => JSON.parse(sql(db, `select coalesce(json_agg(t order by 1), '[]') from (select * from public.${table} t where user_id = '${uid}' and ${where}) t`) || '[]');
export const epochOf = (db, uid) => Number(sql(db, `select coalesce((select epoch from public.xm_meta where user_id = '${uid}'), -1)`));

export async function stageAll(db, user, job, plan, { chunk = 500, skip = () => false } = {}) {
  for (const t of plan.scope.tables) {
    for (let i = 0; i < plan.items[t].length; i += chunk) {
      if (skip(t, i)) continue;
      const part = plan.items[t].slice(i, i + chunk).map(x => ({ h: x.h, row: x.row }));
      const r = await rpc(db, user, 'xm_restore_stage', { p_job: job, p_table: t, p_rows: part });
      if (r.status !== 200) throw new Error(`stage ${t}@${i}: ${r.status} ${r.text}`);
    }
  }
}
export async function fullRestore(db, user, backup, { job = crypto.randomUUID(), expected } = {}) {
  const plan = planFor(backup);
  const c = await rpc(db, user, 'xm_restore_create', { p_job: job, p_scope: plan.scope });
  if (c.status !== 200) throw new Error('create: ' + c.text);
  await stageAll(db, user, job, plan);
  const s = await rpc(db, user, 'xm_restore_seal', { p_job: job, p_manifest: plan.manifest, p_state_patch: plan.state });
  if (s.status !== 200) throw new Error('seal: ' + s.text);
  const a = await rpc(db, user, 'xm_restore_apply', { p_job: job, p_expected_epoch: expected ?? c.json.created_epoch });
  return { job, plan, create: c, seal: s, apply: a };
}

// 「只改客户端」的朴素恢复（基线：用来复现问题）：先 upsert 备份里的行，再分批把多余的行标记删除
export async function naiveRestore(db, user, backup, { stopAfterDeleteChunks = Infinity, chunk = 2 } = {}) {
  for (const t of Object.keys(backup.tables)) {
    const key = KEYS[t];
    const r = await legacyUpsert(db, user, t, backup.tables[t], key);
    if (r.status >= 300) throw new Error('naive upsert ' + r.text);
  }
  let n = 0;
  for (const t of Object.keys(backup.tables)) {
    const key = KEYS[t], keep = new Set(backup.tables[t].map(r => r[key]));
    const cur = await select(db, user, t, `select=${key}&deleted=eq.false`);
    const gone = cur.json.map(r => r[key]).filter(k => !keep.has(k)).sort();
    for (let i = 0; i < gone.length; i += chunk) {
      if (n >= stopAfterDeleteChunks) return { interrupted: true };
      await legacyMarkDeleted(db, user, t, gone.slice(i, i + chunk), key);
      n++;
    }
  }
  if (backup.state) await api(db, user, 'POST', '/xm_state?on_conflict=user_id', { body: [{ user_id: user.id, data: backup.state }], prefer: 'resolution=merge-duplicates' });
  return { interrupted: false };
}

// ---------- 交互式 psql 会话：精确控制两个事务的先后（并发测试用） ----------
export class Session {
  constructor(db, user = null) {
    this.p = spawn('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=0', '-d', dbUrl(db, user)], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.out = ''; this.err = ''; this.n = 0; this.waiters = [];
    this.p.stdout.on('data', d => { this.out += d; this.flush(); });
    this.p.stderr.on('data', d => { this.err += d; });
  }
  flush() {
    for (const w of this.waiters.slice()) {
      const i = this.out.indexOf(w.mark);
      if (i >= 0) { const res = this.out.slice(0, i); this.out = this.out.slice(i + w.mark.length + 1); const err = this.err; this.err = ''; this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve({ out: res.trim(), err: err.trim() }); }
    }
  }
  // 发送一段 SQL，返回 Promise（被锁住时会一直等待，直到语句结束）
  run(text) {
    const mark = `__XM_END_${++this.n}__`;
    return new Promise(resolve => { this.waiters.push({ mark, resolve }); this.p.stdin.write(text + `\n\\echo ${mark}\n`); });
  }
  // 以 PostgREST 的方式扮演某个登录用户（事务内有效）：角色、JWT 声明、请求头
  async begin(user, headers = {}) {
    const claims = JSON.stringify({ sub: user.id, role: 'authenticated' });
    return this.run(`begin; set local role authenticated; select set_config('request.jwt.claims', '${claims}', true), set_config('request.headers', '${JSON.stringify(headers)}', true);`);
  }
  async pid() { if (!this._pid) this._pid = Number((await this.run('select pg_backend_pid();')).out.split('\n').pop()); return this._pid; }
  close() { try { this.p.stdin.end('\\q\n'); } catch (e) { /* ignore */ } }
}
// 某个后端是否正在等锁
export const isWaitingOnLock = (db, pid) => sql(db, `select coalesce((select wait_event_type from pg_stat_activity where pid = ${pid}), '')`) === 'Lock';
export async function waitUntil(fn, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; }

// 在任意库里以某个登录用户的身份执行 SQL（模拟 PostgREST 设置的角色、JWT 声明、请求头），返回最后一行
export function asUser(db, user, body, headers = {}) {
  const claims = JSON.stringify({ sub: user.id, role: 'authenticated' });
  const out = sql(db, `begin; set local role authenticated; select set_config('request.jwt.claims', '${claims}', true), set_config('request.headers', '${JSON.stringify(headers)}', true) \\g /dev/null\n${body}\ncommit;`);
  return out.split('\n').pop();
}
export function tryAsUser(db, user, body, headers = {}) {
  try { return { ok: true, out: asUser(db, user, body, headers) }; } catch (e) { return { ok: false, err: e.message }; }
}
// 不经过 PostgREST，直接用 SQL 走一遍恢复协议（给没有 PostgREST 的临时库用）
export function sqlRestore(db, user, backup, job = crypto.randomUUID()) {
  const plan = planFor(backup);
  const q = v => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  const c = JSON.parse(asUser(db, user, `select public.xm_restore_create('${job}', ${q(plan.scope)});`));
  for (const t of plan.scope.tables) asUser(db, user, `select public.xm_restore_stage('${job}', '${t}', ${q(plan.items[t].map(x => ({ h: x.h, row: x.row })))});`);
  asUser(db, user, `select public.xm_restore_seal('${job}', ${q(plan.manifest)}, ${q(plan.state)});`);
  return JSON.parse(asUser(db, user, `select public.xm_restore_apply('${job}', ${c.created_epoch});`));
}
// 准备一个已封存（但未应用）的任务
export async function sealedJob(db, user, backup, job = crypto.randomUUID()) {
  const plan = planFor(backup);
  const c = await rpc(db, user, 'xm_restore_create', { p_job: job, p_scope: plan.scope });
  if (c.status !== 200) throw new Error('create: ' + c.text);
  await stageAll(db, user, job, plan);
  const s = await rpc(db, user, 'xm_restore_seal', { p_job: job, p_manifest: plan.manifest, p_state_patch: plan.state });
  if (s.status !== 200) throw new Error('seal: ' + s.text);
  return { job, plan, epoch: c.json.created_epoch };
}
// 某用户五张表 + 整块设置的完整快照（用来断言「一点都没变」）
export const snapshot = (db, uid) => sql(db, `select json_build_object(
  'r', (select coalesce(json_agg(t order by t.id), '[]') from public.xm_records t where user_id = '${uid}'),
  'a', (select coalesce(json_agg(t order by t.id), '[]') from public.xm_accounts t where user_id = '${uid}'),
  'c', (select coalesce(json_agg(t order by t.id), '[]') from public.xm_categories t where user_id = '${uid}'),
  'k', (select coalesce(json_agg(t order by t.cat_id), '[]') from public.xm_cats t where user_id = '${uid}'),
  's', (select coalesce(json_agg(t), '[]') from public.xm_state t where user_id = '${uid}'))`);
export const live = (db, table, uid) => rows(db, table, uid, 'not deleted').map(r => r[KEYS[table] || 'id']).sort();
// 一份标准的云端现状 + 一份备份
export const STD = () => ({
  cloud: { records: [rec('r1', 100, '早餐'), rec('r2', 200, '午饭'), rec('r_after', 999, '导出后新增'), rec('r4', 400, '晚饭')], accounts: [acc('a_cash')], categories: [cat('e_food')] },
  backup: { tables: { xm_records: [rec('r1', 100, '早餐'), rec('r2', 250, '午饭（备份里的金额）'), rec('r4', 400, '晚饭')], xm_accounts: [acc('a_cash')], xm_categories: [cat('e_food')] } }
});

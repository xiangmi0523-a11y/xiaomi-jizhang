// 在真实的 Supabase 本地服务栈上验证恢复协议（只在 CI 里运行：supabase start 起的一次性环境）
// 经过真实的 Kong 网关、GoTrue 认证、PostgREST、Supabase 的 postgres 角色，检查：
//   - 自定义请求头 x-xm-epoch 能穿过网关到达数据库；浏览器的 CORS 预检放行它
//   - 用 GoTrue 签发的真实令牌：恢复前旧版写入照常，恢复后被拒，新版带请求头可写
//   - RLS / RPC 隔离、未登录拒绝、并发应用只有一个成功
// 需要的环境变量（来自 `supabase status -o env`）：API_URL、ANON_KEY
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { rec, acc, cat, planFor } from './protocol.mjs';

const API = process.env.API_URL, ANON = process.env.ANON_KEY;
if (!API || !ANON) throw new Error('缺少 API_URL / ANON_KEY');

async function call(method, path, { user, body, headers = {} } = {}) {
  const h = { apikey: ANON, 'Content-Type': 'application/json', ...headers };
  if (user) h.Authorization = 'Bearer ' + user.token;
  const r = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: r.status, json, text, headers: r.headers };
}
async function signUp() {
  const email = `xm-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const r = await call('POST', '/auth/v1/signup', { body: { email, password: 'test-password-123' } });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.access_token, '本地服务栈应当关闭了邮箱确认：' + r.text);
  return { id: r.json.user.id, token: r.json.access_token };
}
const rpc = (user, fn, args) => call('POST', '/rest/v1/rpc/' + fn, { user, body: args });
const upsert = (user, rows, headers = {}) => call('POST', '/rest/v1/xm_records?on_conflict=user_id,id', { user, body: rows.map(r => ({ user_id: user.id, ...r, deleted: false })), headers: { Prefer: 'resolution=merge-duplicates,return=representation', ...headers } });
async function restore(user, backup, expected = 0) {
  const plan = planFor(backup), job = crypto.randomUUID();
  assert.equal((await rpc(user, 'xm_restore_create', { p_job: job, p_scope: plan.scope })).status, 200);
  for (const t of plan.scope.tables) {
    const r = await rpc(user, 'xm_restore_stage', { p_job: job, p_table: t, p_rows: plan.items[t].map(x => ({ h: x.h, row: x.row })) });
    assert.equal(r.status, 200, r.text);
  }
  const s = await rpc(user, 'xm_restore_seal', { p_job: job, p_manifest: plan.manifest, p_state_patch: plan.state });
  assert.equal(s.status, 200, s.text);
  return { job, apply: () => rpc(user, 'xm_restore_apply', { p_job: job, p_expected_epoch: expected }) };
}
const BK = ids => ({ tables: { xm_records: ids.map(i => rec(i)), xm_accounts: [acc('a_cash')], xm_categories: [cat('e_food')] } });

test('网关：浏览器 CORS 预检放行 x-xm-epoch 请求头', async () => {
  const r = await fetch(API + '/rest/v1/xm_records', { method: 'OPTIONS', headers: { Origin: 'https://xiaomi-jizhang.vercel.app', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'apikey,authorization,content-type,prefer,x-xm-epoch' } });
  const allow = (r.headers.get('access-control-allow-headers') || '').toLowerCase();
  assert.ok(r.status < 300, 'status ' + r.status);
  assert.ok(allow === '*' || allow.includes('x-xm-epoch'), 'allow-headers = ' + allow);
});

test('真实服务栈：恢复前旧版写入照常；恢复后旧版写入 409；带请求头的新版写入成功且记为新版本', async () => {
  const u = await signUp();
  const pre = await upsert(u, [rec('r1'), rec('r_after', 999, '导出后新增')]);
  assert.ok(pre.status < 300, pre.text);
  const job = await restore(u, BK(['r1']));
  const a = await job.apply();
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json.epoch, 1);
  const stale = await upsert(u, [rec('r_after', 999, '导出后新增')]);
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json.hint, 'xm_stale_epoch');
  const fresh = await upsert(u, [rec('n1', 300, '恢复后新记')], { 'x-xm-epoch': '1' });
  assert.ok(fresh.status < 300, '请求头没有穿过网关？' + fresh.text);
  assert.equal(fresh.json[0].epoch, 1);
  const liveRows = await call('GET', '/rest/v1/xm_records?select=id&deleted=eq.false&order=id', { user: u });
  assert.deepEqual(liveRows.json.map(r => r.id), ['n1', 'r1']);
});

test('真实服务栈：别人看不到、动不了我的恢复任务；未登录调用被拒', async () => {
  const a = await signUp(), b = await signUp();
  const job = await restore(a, BK(['x1']));
  assert.deepEqual((await call('GET', '/rest/v1/xm_restore_job?select=job_id', { user: b })).json, []);
  const steal = await rpc(b, 'xm_restore_apply', { p_job: job.job, p_expected_epoch: 0 });
  assert.equal(steal.status, 404, steal.text);
  const anon = await call('POST', '/rest/v1/rpc/xm_restore_apply', { body: { p_job: job.job, p_expected_epoch: 0 } });
  assert.notEqual(anon.status, 200, anon.text);
  assert.ok([401, 403].includes((await call('GET', '/rest/v1/xm_restore_stage', { user: a })).status));
});

test('真实服务栈：两个任务并发应用 —— 恰好一个成功', async () => {
  const u = await signUp();
  const j1 = await restore(u, BK(['x1'])), j2 = await restore(u, BK(['y1']));
  const [r1, r2] = await Promise.all([j1.apply(), j2.apply()]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409], r1.text + ' / ' + r2.text);
});

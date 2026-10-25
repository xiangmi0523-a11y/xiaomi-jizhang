// 审核清单 8：RLS 和 RPC 不允许用户读取或修改他人的恢复任务；权限最小化；SECURITY DEFINER 固定 search_path
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PROT, sql, newUser, seed, rows, api, rpc, select, epochUpsert, sealedJob, planFor, stageAll, rec, STD } from './lib.mjs';

const RPCS = ['xm_restore_create', 'xm_restore_stage', 'xm_restore_seal', 'xm_restore_apply', 'xm_restore_cancel'];

test('对照：在 Supabase 的默认权限下，public 里新建的函数和表默认对 anon 开放 —— 所以迁移必须显式收回', () => {
  sql(PROT, 'create function public.xm_probe() returns int language sql as $$ select 1 $$; create table public.xm_probe_t (x int);', { user: 'xm_owner' });
  try {
    assert.equal(sql(PROT, "select has_function_privilege('anon', 'public.xm_probe()', 'execute')"), 't');
    assert.equal(sql(PROT, "select has_table_privilege('anon', 'public.xm_probe_t', 'insert')"), 't');
  } finally { sql(PROT, 'drop function public.xm_probe(); drop table public.xm_probe_t;', { user: 'xm_owner' }); }
});

test('协议：未登录（anon）调用任何恢复 RPC 都被拒绝', async () => {
  for (const fn of RPCS) {
    const r = await rpc(PROT, null, fn, {});
    assert.ok([401, 403, 404].includes(r.status), `${fn}: ${r.status} ${r.text}`);
  }
  assert.equal(sql(PROT, `select bool_or(has_function_privilege('anon', p.oid, 'execute')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'xm_guard') and p.proname like any (array['xm_restore_%', 'epoch_lock', 'guard_write', 'key_col', 'data_cols', 'fail', 'me', 'my_job'])`), 'f');
});

test('协议：用户看不到别人的版本号和任务；看不到任何人的暂存区和存档', async () => {
  const a = newUser(PROT), b = newUser(PROT), { cloud, backup } = STD();
  seed(PROT, a.id, cloud);
  const J = await sealedJob(PROT, a, backup);
  assert.deepEqual((await select(PROT, b, 'xm_restore_job')).json, []);
  assert.deepEqual((await select(PROT, b, 'xm_meta')).json.filter(m => m.user_id === a.id), []);
  assert.deepEqual((await select(PROT, a, 'xm_restore_job', 'select=job_id')).json.map(j => j.job_id), [J.job], '自己能看到自己的');
  for (const t of ['xm_restore_stage', 'xm_restore_archive']) {
    for (const who of [a, b]) {
      const r = await select(PROT, who, t);
      assert.ok([401, 403].includes(r.status), `${t}: ${r.status} ${r.text}`);
    }
  }
});

test('协议：用别人的任务编号上传、封存、应用、取消、重建，一律当作不存在（404），对方的任务不受影响', async () => {
  const a = newUser(PROT), b = newUser(PROT), { cloud, backup } = STD();
  seed(PROT, a.id, cloud);
  const J = await sealedJob(PROT, a, backup);
  const tries = {
    stage: await rpc(PROT, b, 'xm_restore_stage', { p_job: J.job, p_table: 'xm_records', p_rows: [{ h: 'x', row: rec('evil') }] }),
    seal: await rpc(PROT, b, 'xm_restore_seal', { p_job: J.job, p_manifest: J.plan.manifest, p_state_patch: {} }),
    apply: await rpc(PROT, b, 'xm_restore_apply', { p_job: J.job, p_expected_epoch: 0 }),
    cancel: await rpc(PROT, b, 'xm_restore_cancel', { p_job: J.job }),
    create: await rpc(PROT, b, 'xm_restore_create', { p_job: J.job, p_scope: J.plan.scope })
  };
  for (const [k, r] of Object.entries(tries)) { assert.equal(r.status, 404, `${k}: ${r.text}`); assert.equal(r.json.hint, 'xm_not_found'); }
  assert.equal(sql(PROT, `select state from public.xm_restore_job where job_id = '${J.job}'`), 'sealed');
  assert.equal(Number(sql(PROT, `select count(*) from public.xm_meta where user_id = '${b.id}' and epoch > 0`)), 0);
});

test('协议：用户不能直接改写 xm_meta、任务表、暂存区、存档', async () => {
  const a = newUser(PROT);
  await epochUpsert(PROT, a, 'xm_records', [rec('x')], 0);   // 让 a 有一行 xm_meta
  const attempts = [
    api(PROT, a, 'PATCH', `/xm_meta?user_id=eq.${a.id}`, { body: { epoch: 0 } }),
    api(PROT, a, 'POST', '/xm_meta', { body: { user_id: a.id, epoch: 5 } }),
    api(PROT, a, 'DELETE', `/xm_meta?user_id=eq.${a.id}`),
    api(PROT, a, 'POST', '/xm_restore_job', { body: { job_id: crypto.randomUUID(), user_id: a.id, state: 'sealed', scope: {}, created_epoch: 0 } }),
    api(PROT, a, 'PATCH', '/xm_restore_job?state=eq.sealed', { body: { state: 'applied' } }),
    api(PROT, a, 'POST', '/xm_restore_stage', { body: { job_id: crypto.randomUUID(), tbl: 'xm_records', rkey: 'k', h: 'h', row: {} } }),
    api(PROT, a, 'POST', '/xm_restore_archive', { body: { job_id: crypto.randomUUID(), tbl: 'xm_records', rkey: 'k', row: {} } })
  ];
  for (const r of await Promise.all(attempts)) assert.ok([401, 403].includes(r.status), `${r.status} ${r.text}`);
  assert.equal(sql(PROT, `select epoch from public.xm_meta where user_id = '${a.id}'`), '0');
});

test('协议：写别人的 user_id 被 RLS 拒绝，且不会顺带为对方创建版本号记录', async () => {
  const a = newUser(PROT), victim = newUser(PROT);
  const r = await api(PROT, a, 'POST', '/xm_records', { body: [{ user_id: victim.id, ...rec('evil') }], headers: { 'x-xm-epoch': '0' } });
  assert.ok([401, 403].includes(r.status), r.text);
  assert.equal(Number(sql(PROT, `select count(*) from public.xm_meta where user_id = '${victim.id}'`)), 0);
  assert.equal(rows(PROT, 'xm_records', victim.id).length, 0);
});

test('协议：所有 SECURITY DEFINER 函数都固定了空 search_path；内部 schema 不通过 PostgREST 暴露', async () => {
  const bad = sql(PROT, `select coalesce(string_agg(n.nspname || '.' || p.proname, ','), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'xm_guard') and p.prosecdef and not coalesce(p.proconfig @> array['search_path=""'], false)`);
  assert.equal(bad, '', '没有固定 search_path 的 definer 函数：' + bad);
  const definers = sql(PROT, `select string_agg(n.nspname || '.' || p.proname, ',' order by n.nspname || '.' || p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'xm_guard') and p.prosecdef`);
  assert.equal(definers, 'public.xm_restore_apply,public.xm_restore_cancel,public.xm_restore_create,public.xm_restore_seal,public.xm_restore_stage,xm_guard.epoch_lock');
  const u = newUser(PROT);
  const r = await rpc(PROT, u, 'epoch_lock', { p_uid: u.id });
  assert.equal(r.status, 404, r.text);
  assert.equal(sql(PROT, "select has_function_privilege('authenticated', 'xm_guard.my_job(uuid, uuid)', 'execute')"), 'f');
});

test('协议：管理员（service_role）不能借 RPC 绕过身份校验', async () => {
  const svc = { id: crypto.randomUUID(), jwt: (await import('./lib.mjs')).jwtFor(crypto.randomUUID(), 'service_role') };
  const r = await rpc(PROT, svc, 'xm_restore_apply', { p_job: crypto.randomUUID(), p_expected_epoch: 0 });
  assert.ok([401, 403, 404].includes(r.status) && r.status !== 200, r.text);
});

test('协议：输入校验 —— 范围、表名、批次大小、未知列、缺列、类型、非空、任务数量上限', async () => {
  const u = newUser(PROT), { backup } = STD();
  const plan = planFor(backup), job = crypto.randomUUID();
  const bad = async (fn, args, hint) => { const r = await rpc(PROT, u, fn, args); assert.ok(r.status >= 400 && r.status < 500, `${fn} ${JSON.stringify(args).slice(0, 80)} → ${r.status} ${r.text}`); if (hint) assert.equal(r.json.hint, hint); };
  await bad('xm_restore_create', { p_job: job, p_scope: { tables: ['xm_records'], state_modules: [] } }, 'xm_bad_scope');
  await bad('xm_restore_create', { p_job: job, p_scope: { tables: ['xm_records', 'xm_accounts', 'xm_categories', 'pg_authid'], state_modules: [] } }, 'xm_bad_scope');
  await bad('xm_restore_create', { p_job: job, p_scope: { tables: ['xm_records', 'xm_accounts', 'xm_categories'], state_modules: ['pin'] } }, 'xm_bad_scope');
  assert.equal((await rpc(PROT, u, 'xm_restore_create', { p_job: job, p_scope: plan.scope })).status, 200);
  const one = row => [{ h: 'h1', row }];
  await bad('xm_restore_stage', { p_job: job, p_table: 'xm_cats', p_rows: one({ cat_id: 'n1' }) }, 'xm_bad_table');
  await bad('xm_restore_stage', { p_job: job, p_table: 'xm_records', p_rows: Array.from({ length: 501 }, (_, i) => ({ h: 'h', row: rec('k' + i) })) }, 'xm_bad_input');
  await bad('xm_restore_stage', { p_job: job, p_table: 'xm_records', p_rows: one({ ...rec('k1'), hacked: 1 }) }, 'xm_bad_row');
  const { note, ...noNote } = rec('k2');
  await bad('xm_restore_stage', { p_job: job, p_table: 'xm_records', p_rows: one(noNote) }, 'xm_bad_row');
  await bad('xm_restore_stage', { p_job: job, p_table: 'xm_records', p_rows: one(rec('k3', 'abc')) }, 'xm_bad_row');
  await bad('xm_restore_stage', { p_job: job, p_table: 'xm_records', p_rows: one({ ...rec('k4'), note: null }) }, 'xm_bad_row');
  await bad('xm_restore_stage', { p_job: job, p_table: 'xm_records', p_rows: one({ ...rec('k5'), date: '2026-13-45' }) }, 'xm_bad_row');
  await bad('xm_restore_stage', { p_job: job, p_table: 'xm_records', p_rows: [{ row: rec('k6') }] }, 'xm_bad_row');
  assert.equal(Number(sql(PROT, `select count(*) from public.xm_restore_stage where job_id = '${job}'`)), 0, '坏批次一行都没进暂存区');
  await stageAll(PROT, u, job, plan);
  const tampered = JSON.parse(JSON.stringify(plan.manifest)); tampered.xm_records.digest = '0'.repeat(64);
  await bad('xm_restore_seal', { p_job: job, p_manifest: tampered, p_state_patch: {} }, 'xm_manifest_mismatch');
  for (let i = 0; i < 2; i++) await rpc(PROT, u, 'xm_restore_create', { p_job: crypto.randomUUID(), p_scope: plan.scope });
  await bad('xm_restore_create', { p_job: crypto.randomUUID(), p_scope: plan.scope }, 'xm_too_many_jobs');
});

test('协议：封存清单缺字段或类型不对时必须拒绝（修复前会因 NULL 比较被跳过，导致不核对就封存）', async () => {
  const u = newUser(PROT), { backup } = STD();
  const plan = planFor(backup);
  const slipped = [];
  for (const broken of [{ count: 0 }, { digest: plan.manifest.xm_records.digest }, { count: '0', digest: plan.manifest.xm_records.digest }, {}]) {
    const job = crypto.randomUUID();
    assert.equal((await rpc(PROT, u, 'xm_restore_create', { p_job: job, p_scope: plan.scope })).status, 200);
    await stageAll(PROT, u, job, plan, { skip: (t, i) => t === 'xm_records' });   // 账单一行都没传
    const r = await rpc(PROT, u, 'xm_restore_seal', { p_job: job, p_manifest: { ...plan.manifest, xm_records: broken }, p_state_patch: {} });
    const state = sql(PROT, `select state from public.xm_restore_job where job_id = '${job}'`);
    if (r.status !== 400 || state !== 'staging') slipped.push(`${JSON.stringify(broken)} → ${r.status} / ${state}`);
    await rpc(PROT, u, 'xm_restore_cancel', { p_job: job });
  }
  assert.deepEqual(slipped, [], '这些坏清单没有被拒绝');
});

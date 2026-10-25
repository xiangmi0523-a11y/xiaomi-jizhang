// 审核清单 4、5：重复提交、重复上传、响应丢失、网络中断；部分软删除后中断、超时、接管 —— 不得留下半成品账本
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { BASE, PROT, sql, newUser, jwtFor, seed, rows, live, epochOf, legacyUpsert, rpc, select, naiveRestore, planFor, stageAll, sealedJob, snapshot, rec, acc, cat, STD, waitUntil } from './lib.mjs';

const ok2xx = r => assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${r.text}`);
// 测试专用触发器：只对某个用户生效，结束时删除
const testTrigger = (db, name, uid, body) => {
  sql(db, `create or replace function public.${name}() returns trigger language plpgsql as $$ begin if new.user_id = '${uid}' then ${body} end if; return new; end $$;
           create trigger ${name} before insert or update on public.xm_records for each row execute function public.${name}();`);
  return () => sql(db, `drop trigger if exists ${name} on public.xm_records; drop function if exists public.${name}();`);
};
const many = n => Array.from({ length: n }, (_, i) => rec('m' + String(i).padStart(3, '0'), 100 + i, '云端' + i));

test('协议：同一批重复上传、同一清单重复封存，都不会重复或报错', async () => {
  const u = newUser(PROT), { cloud, backup } = STD();
  seed(PROT, u.id, cloud);
  const job = crypto.randomUUID(), plan = planFor(backup);
  ok2xx(await rpc(PROT, u, 'xm_restore_create', { p_job: job, p_scope: plan.scope }));
  ok2xx(await rpc(PROT, u, 'xm_restore_create', { p_job: job, p_scope: plan.scope }));   // 重复建任务
  await stageAll(PROT, u, job, plan);
  await stageAll(PROT, u, job, plan);   // 重复上传
  assert.equal(Number(sql(PROT, `select count(*) from public.xm_restore_stage where job_id = '${job}'`)), 5);
  const args = { p_job: job, p_manifest: plan.manifest, p_state_patch: plan.state };
  ok2xx(await rpc(PROT, u, 'xm_restore_seal', args));
  ok2xx(await rpc(PROT, u, 'xm_restore_seal', args));   // 重复封存
  ok2xx(await rpc(PROT, u, 'xm_restore_apply', { p_job: job, p_expected_epoch: 0 }));
  assert.deepEqual(live(PROT, 'xm_records', u.id), ['r1', 'r2', 'r4']);
});

test('协议：上传中途断网（漏了一批）—— 封存时被发现并拒绝；补传后封存、应用成功', async () => {
  const u = newUser(PROT);
  seed(PROT, u.id, { records: many(5), accounts: [acc('a_cash')], categories: [cat('e_food')] });
  const backup = { tables: { xm_records: many(30).slice(0, 25), xm_accounts: [acc('a_cash')], xm_categories: [cat('e_food')] } };
  const job = crypto.randomUUID(), plan = planFor(backup);
  ok2xx(await rpc(PROT, u, 'xm_restore_create', { p_job: job, p_scope: plan.scope }));
  await stageAll(PROT, u, job, plan, { chunk: 10, skip: (t, i) => t === 'xm_records' && i === 10 });   // 第二批「丢了」
  const bad = await rpc(PROT, u, 'xm_restore_seal', { p_job: job, p_manifest: plan.manifest, p_state_patch: plan.state });
  assert.equal(bad.status, 409, bad.text);
  assert.equal(bad.json.hint, 'xm_manifest_mismatch');
  await stageAll(PROT, u, job, plan, { chunk: 10 });   // 从头补传（同键覆盖）
  ok2xx(await rpc(PROT, u, 'xm_restore_seal', { p_job: job, p_manifest: plan.manifest, p_state_patch: plan.state }));
  ok2xx(await rpc(PROT, u, 'xm_restore_apply', { p_job: job, p_expected_epoch: 0 }));
  assert.equal(live(PROT, 'xm_records', u.id).length, 25);
});

test('协议：应用成功但响应丢失 —— 重试返回同一结果，版本号只加 1，存档只有一份', async () => {
  const u = newUser(PROT), { cloud, backup } = STD();
  seed(PROT, u.id, cloud);
  const J = await sealedJob(PROT, u, backup);
  const first = await rpc(PROT, u, 'xm_restore_apply', { p_job: J.job, p_expected_epoch: 0 });   // 假装客户端没收到
  ok2xx(first);
  const again = await rpc(PROT, u, 'xm_restore_apply', { p_job: J.job, p_expected_epoch: 0 });
  ok2xx(again);
  assert.deepEqual(again.json, first.json);
  assert.equal(epochOf(PROT, u.id), 1);
  assert.equal(Number(sql(PROT, `select count(*) from public.xm_restore_archive where job_id = '${J.job}'`)), 6);
});

test('协议：应用进行到一半连接被切断（断网 / 服务器中止）—— 整个事务回滚，正式表、版本号、任务状态都不变，可以重试', async () => {
  const u = newUser(PROT);
  seed(PROT, u.id, { records: many(6), accounts: [acc('a_cash')], categories: [cat('e_food')] });
  const backup = { tables: { xm_records: [rec('b1'), rec('slow', 1, 'slow')], xm_accounts: [acc('a_cash')], xm_categories: [cat('e_food')] } };
  const J = await sealedJob(PROT, u, backup);
  const before = snapshot(PROT, u.id);
  const drop = testTrigger(PROT, 'xm_test_slow', u.id, "if new.id = 'slow' then perform pg_sleep(5); end if;");
  try {
    const p = rpc(PROT, u, 'xm_restore_apply', { p_job: J.job, p_expected_epoch: 0 });
    let pid = 0;
    assert.ok(await waitUntil(() => { pid = Number(sql(PROT, "select coalesce((select pid from pg_stat_activity where query ilike '%xm_restore_apply%' and wait_event = 'PgSleep' limit 1), 0)")); return pid > 0; }), '应用应当卡在中途');
    sql(PROT, `select pg_terminate_backend(${pid})`);
    const r = await p;
    assert.notEqual(r.status, 200, '被切断的请求不能报成功');
  } finally { drop(); }
  assert.equal(snapshot(PROT, u.id), before, '正式表一点都没变');
  assert.equal(epochOf(PROT, u.id), 0);
  assert.equal(sql(PROT, `select state from public.xm_restore_job where job_id = '${J.job}'`), 'sealed');
  assert.equal(Number(sql(PROT, `select count(*) from public.xm_restore_archive where job_id = '${J.job}'`)), 0);
  ok2xx(await rpc(PROT, u, 'xm_restore_apply', { p_job: J.job, p_expected_epoch: 0 }));   // 重试
  assert.deepEqual(live(PROT, 'xm_records', u.id), ['b1', 'slow']);
});

test('基线（现状）：朴素恢复的软删除做到一半中断 —— 云端留下半成品账本', async () => {
  const u = newUser(BASE);
  seed(BASE, u.id, { records: many(8), accounts: [acc('a_cash')], categories: [cat('e_food')] });
  const backup = { tables: { xm_records: [rec('b1')], xm_accounts: [acc('a_cash')], xm_categories: [cat('e_food')] } };
  const r = await naiveRestore(BASE, u, backup, { stopAfterDeleteChunks: 2, chunk: 2 });
  assert.equal(r.interrupted, true);
  const got = live(BASE, 'xm_records', u.id);
  assert.ok(got.includes('b1') && got.length > 1 && got.length < 9, '问题复现：备份的行已写入，多余的行只删了一部分：' + got.join(','));
});

test('协议：软删除做到第 3 行时崩溃 —— 正式表一行都没变，没有半成品', async () => {
  const u = newUser(PROT);
  seed(PROT, u.id, { records: many(8), accounts: [acc('a_cash')], categories: [cat('e_food')] });
  const backup = { tables: { xm_records: [rec('b1')], xm_accounts: [acc('a_cash')], xm_categories: [cat('e_food')] } };
  const J = await sealedJob(PROT, u, backup);
  const before = snapshot(PROT, u.id);
  sql(PROT, 'drop sequence if exists xm_test_crash_seq; create sequence xm_test_crash_seq;');
  const drop = testTrigger(PROT, 'xm_test_crash', u.id, "if tg_op = 'UPDATE' and new.deleted and not old.deleted and nextval('public.xm_test_crash_seq') = 3 then raise exception '模拟崩溃'; end if;");
  try {
    const r = await rpc(PROT, u, 'xm_restore_apply', { p_job: J.job, p_expected_epoch: 0 });
    assert.notEqual(r.status, 200, r.text);
  } finally { drop(); sql(PROT, 'drop sequence if exists xm_test_crash_seq;'); }
  assert.equal(snapshot(PROT, u.id), before);
  assert.equal(epochOf(PROT, u.id), 0);
  assert.equal(sql(PROT, `select state from public.xm_restore_job where job_id = '${J.job}'`), 'sealed');
});

test('协议：客户端等不及超时放弃 —— 服务器端要么全做完要么全没做，旁观者从不看到半成品；重试拿到结果', async () => {
  const u = newUser(PROT);
  seed(PROT, u.id, { records: many(6), accounts: [acc('a_cash')], categories: [cat('e_food')] });
  const backup = { tables: { xm_records: [rec('b1'), rec('slow', 1, 'slow')], xm_accounts: [acc('a_cash')], xm_categories: [cat('e_food')] } };
  const J = await sealedJob(PROT, u, backup);
  const drop = testTrigger(PROT, 'xm_test_slow2', u.id, "if new.id = 'slow' then perform pg_sleep(1.5); end if;");
  const seen = new Set();
  try {
    const ctl = new AbortController();
    const p = fetch(`${(await import('./lib.mjs')).ENV.rest[PROT]}/rpc/xm_restore_apply`, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + u.jwt }, body: JSON.stringify({ p_job: J.job, p_expected_epoch: 0 }) }).catch(e => e);
    setTimeout(() => ctl.abort(), 200);   // 客户端 0.2 秒就放弃
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {     // 另一台设备一直在读
      seen.add(live(PROT, 'xm_records', u.id).join(','));
      await new Promise(r => setTimeout(r, 50));
    }
    await p;
  } finally { drop(); }
  const old = many(6).map(r => r.id).join(','), neu = 'b1,slow';
  assert.deepEqual([...seen].filter(x => x !== old && x !== neu), [], '旁观者只能看到「完全没改」或「完全改好」');
  const r = await rpc(PROT, u, 'xm_restore_apply', { p_job: J.job, p_expected_epoch: 0 });
  ok2xx(r);
  assert.equal(r.json.epoch, 1);
  assert.deepEqual(live(PROT, 'xm_records', u.id), ['b1', 'slow']);
});

test('协议：另一台设备接管已封存的任务并完成', async () => {
  const u = newUser(PROT), { cloud, backup } = STD();
  seed(PROT, u.id, cloud);
  const J = await sealedJob(PROT, u, backup);           // 设备 A 封存后就被杀掉了
  const deviceB = { id: u.id, jwt: jwtFor(u.id) };     // 同一账号、另一台设备
  const jobs = await select(PROT, deviceB, 'xm_restore_job', 'select=job_id,state,created_epoch&state=eq.sealed');
  assert.deepEqual(jobs.json.map(j => j.job_id), [J.job]);
  const r = await rpc(PROT, deviceB, 'xm_restore_apply', { p_job: J.job, p_expected_epoch: jobs.json[0].created_epoch });
  ok2xx(r);
  assert.deepEqual(live(PROT, 'xm_records', u.id), ['r1', 'r2', 'r4']);
});

test('协议：暂存中的任务不能被应用，只能取消；它从未影响正式表和其他设备的写入', async () => {
  const u = newUser(PROT), { cloud, backup } = STD();
  seed(PROT, u.id, cloud);
  const before = snapshot(PROT, u.id);
  const job = crypto.randomUUID(), plan = planFor(backup);
  ok2xx(await rpc(PROT, u, 'xm_restore_create', { p_job: job, p_scope: plan.scope }));
  await stageAll(PROT, u, job, plan, { chunk: 1, skip: (t, i) => i > 0 });   // 只传了一部分，A 就被杀了
  assert.equal(snapshot(PROT, u.id), before, '暂存不碰正式表');
  ok2xx(await legacyUpsert(PROT, u, 'xm_records', [rec('other_device', 1)]));  // 其他设备照常写（版本号仍是 0）
  const ap = await rpc(PROT, u, 'xm_restore_apply', { p_job: job, p_expected_epoch: 0 });
  assert.equal(ap.status, 409); assert.equal(ap.json.hint, 'xm_bad_state');
  ok2xx(await rpc(PROT, u, 'xm_restore_cancel', { p_job: job }));
  ok2xx(await rpc(PROT, u, 'xm_restore_cancel', { p_job: job }));   // 重复取消
  const st = await rpc(PROT, u, 'xm_restore_stage', { p_job: job, p_table: 'xm_records', p_rows: [{ h: 'x', row: rec('late') }] });
  assert.equal(st.status, 409);
  assert.equal(epochOf(PROT, u.id), 0, '取消不改变版本号');
  ok2xx(await legacyUpsert(PROT, u, 'xm_records', [rec('still_ok', 1)]));   // 旧版客户端仍可用
});

test('协议：失败的应用（版本号已变、核对失败）和取消都不改变版本号；已应用的任务不能取消', async () => {
  const u = newUser(PROT), { cloud, backup } = STD();
  seed(PROT, u.id, cloud);
  const J = await sealedJob(PROT, u, backup);
  const wrong = await rpc(PROT, u, 'xm_restore_apply', { p_job: J.job, p_expected_epoch: 7 });
  assert.equal(wrong.status, 409); assert.equal(wrong.json.hint, 'xm_epoch_changed');
  assert.equal(epochOf(PROT, u.id), 0);
  ok2xx(await rpc(PROT, u, 'xm_restore_apply', { p_job: J.job, p_expected_epoch: 0 }));
  const c = await rpc(PROT, u, 'xm_restore_cancel', { p_job: J.job });
  assert.equal(c.status, 409);
});

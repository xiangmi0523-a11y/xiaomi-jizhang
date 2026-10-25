// 审核清单 2、3：两个连接同时开始恢复只有一个成功；普通写入与恢复并发时，过期版本穿不过写入保护
import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE, PROT, sql, newUser, seed, rows, live, epochOf, epochUpsert, legacyUpsert, legacyMarkDeleted, select, rpc, sealedJob, Session, isWaitingOnLock, waitUntil, rec, acc, cat, STD } from './lib.mjs';

const bk = ids => ({ tables: { xm_records: ids.map(i => rec(i, 100, '备份' + i)), xm_accounts: [acc('a_cash')], xm_categories: [cat('e_food')] } });
const applyPid = db => Number(sql(db, "select coalesce((select pid from pg_stat_activity where query ilike '%xm_restore_apply%' and pid <> pg_backend_pid() and state = 'active' limit 1), 0)"));

test('基线（现状）：两台手机各自用不同的备份做朴素恢复，交错执行后互相把对方的账单删光', async () => {
  const u = newUser(BASE);
  seed(BASE, u.id, { records: [rec('old1'), rec('old2')], accounts: [acc('a_cash')], categories: [cat('e_food')] });
  const X = bk(['x1', 'x2']), Y = bk(['y1', 'y2']);
  // 明确的交错顺序：A 上传 X → B 上传 Y → A 按自己算出的多余行做软删除 → B 再按自己算出的做软删除
  const keysNow = async () => (await select(BASE, u, 'xm_records', 'select=id&deleted=eq.false')).json.map(r => r.id);
  await legacyUpsert(BASE, u, 'xm_records', X.tables.xm_records);
  await legacyUpsert(BASE, u, 'xm_records', Y.tables.xm_records);
  const goneA = (await keysNow()).filter(k => !['x1', 'x2'].includes(k));
  const goneB = (await keysNow()).filter(k => !['y1', 'y2'].includes(k));
  await legacyMarkDeleted(BASE, u, 'xm_records', goneA);
  await legacyMarkDeleted(BASE, u, 'xm_records', goneB);
  const got = live(BASE, 'xm_records', u.id);
  assert.deepEqual(got, [], '问题复现：两边互相把对方的行删掉，账单全空了');
  assert.notDeepEqual(got, ['x1', 'x2'], '问题复现：结果既不是备份 X');
  assert.notDeepEqual(got, ['y1', 'y2'], '也不是备份 Y');
});

test('协议：两个连接同时应用两个不同的任务 —— 只有一个成功，版本号只加 1，另一个得到 epoch_changed', async () => {
  const u = newUser(PROT);
  seed(PROT, u.id, { records: [rec('old1')], accounts: [acc('a_cash')], categories: [cat('e_food')] });
  const J1 = await sealedJob(PROT, u, bk(['x1', 'x2'])), J2 = await sealedJob(PROT, u, bk(['y1', 'y2']));
  const s1 = new Session(PROT), s2 = new Session(PROT);
  try {
    await s1.begin(u);
    const r1 = await s1.run(`select public.xm_restore_apply('${J1.job}', 0);`);   // 拿到锁，暂不提交
    assert.equal(r1.err, '');
    await s2.begin(u);
    const pid2 = await s2.pid();
    const p2 = s2.run(`select public.xm_restore_apply('${J2.job}', 0);`);
    assert.ok(await waitUntil(() => isWaitingOnLock(PROT, pid2)), '第二个连接应当在等锁');
    await s1.run('commit;');
    const r2 = await p2;
    assert.match(r2.err, /另一台设备恢复过|epoch_changed|PT409/, '第二个任务被拒：' + JSON.stringify(r2));
    await s2.run('rollback;');
  } finally { s1.close(); s2.close(); }
  assert.equal(epochOf(PROT, u.id), 1);
  assert.deepEqual(live(PROT, 'xm_records', u.id), ['x1', 'x2']);
  assert.equal(sql(PROT, `select state from public.xm_restore_job where job_id = '${J2.job}'`), 'sealed', '失败的任务保持封存，等用户决定');
});

test('协议：通过 PostgREST 真正并发地应用两个任务 —— 恰好一个 200、一个 409', async () => {
  const u = newUser(PROT);
  seed(PROT, u.id, { records: [rec('old1')], accounts: [acc('a_cash')], categories: [cat('e_food')] });
  const J1 = await sealedJob(PROT, u, bk(['x1'])), J2 = await sealedJob(PROT, u, bk(['y1']));
  const [a, b] = await Promise.all([
    rpc(PROT, u, 'xm_restore_apply', { p_job: J1.job, p_expected_epoch: 0 }),
    rpc(PROT, u, 'xm_restore_apply', { p_job: J2.job, p_expected_epoch: 0 })
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], a.text + ' / ' + b.text);
  const winner = a.status === 200 ? ['x1'] : ['y1'];
  assert.deepEqual(live(PROT, 'xm_records', u.id), winner);
  assert.equal(epochOf(PROT, u.id), 1);
});

test('协议：同一个任务在两个标签页同时应用 —— 两边都拿到同一结果，只生效一次', async () => {
  const u = newUser(PROT), { cloud, backup } = STD();
  seed(PROT, u.id, cloud);
  const J = await sealedJob(PROT, u, backup);
  const [a, b] = await Promise.all([
    rpc(PROT, u, 'xm_restore_apply', { p_job: J.job, p_expected_epoch: 0 }),
    rpc(PROT, u, 'xm_restore_apply', { p_job: J.job, p_expected_epoch: 0 })
  ]);
  assert.equal(a.status, 200, a.text); assert.equal(b.status, 200, b.text);
  assert.deepEqual(a.json, b.json);
  assert.equal(epochOf(PROT, u.id), 1);
  assert.equal(Number(sql(PROT, `select count(*) from public.xm_restore_archive where job_id = '${J.job}' and tbl = 'xm_records'`)), 4, '只存档了一次');
});

test('协议：普通写入先拿到共享锁、恢复在等 —— 写入先提交（算作恢复前的云端，随后被软删除），之后再用旧版本号写被拒', async () => {
  const u = newUser(PROT);
  seed(PROT, u.id, { records: [rec('old1')], accounts: [acc('a_cash')], categories: [cat('e_food')] });
  const J = await sealedJob(PROT, u, bk(['x1']));
  const w = new Session(PROT);
  try {
    await w.begin(u, { 'x-xm-epoch': '0' });
    const ins = await w.run(`insert into public.xm_records (user_id, id, type, amount, date, note) values ('${u.id}', 'w1', 'expense', 50, '2026-10-21', '写入中');`);
    assert.equal(ins.err, '', ins.err);
    const pApply = rpc(PROT, u, 'xm_restore_apply', { p_job: J.job, p_expected_epoch: 0 });
    assert.ok(await waitUntil(() => { const p = applyPid(PROT); return p && isWaitingOnLock(PROT, p); }), '恢复应当在等普通写入提交');
    await w.run('commit;');
    const a = await pApply;
    assert.equal(a.status, 200, a.text);
  } finally { w.close(); }
  const w1 = rows(PROT, 'xm_records', u.id, "id = 'w1'")[0];
  assert.equal(w1.deleted, true, '恢复前提交的写入属于「恢复前的云端」，不在备份里 → 软删除');
  assert.deepEqual(live(PROT, 'xm_records', u.id), ['x1']);
  const late = await epochUpsert(PROT, u, 'xm_records', [rec('w2')], 0);
  assert.equal(late.status, 409, late.text);
});

test('协议：恢复先拿到排他锁、普通写入在等 —— 恢复提交后，写入读到新版本号而被拒，不会穿过保护', async () => {
  const u = newUser(PROT);
  seed(PROT, u.id, { records: [rec('old1')], accounts: [acc('a_cash')], categories: [cat('e_food')] });
  const J = await sealedJob(PROT, u, bk(['x1']));
  const s = new Session(PROT);
  try {
    await s.begin(u);
    const r = await s.run(`select public.xm_restore_apply('${J.job}', 0);`);
    assert.equal(r.err, '');
    const pWrite = epochUpsert(PROT, u, 'xm_records', [rec('stale', 1, '过期版本的写入')], 0);
    const writerPid = () => Number(sql(PROT, "select coalesce((select pid from pg_stat_activity where query ilike '%xm_records%' and query ilike '%insert%' and pid <> pg_backend_pid() and state = 'active' limit 1), 0)"));
    assert.ok(await waitUntil(() => { const p = writerPid(); return p && isWaitingOnLock(PROT, p); }), '普通写入应当在等恢复');
    await s.run('commit;');
    const wr = await pWrite;
    assert.equal(wr.status, 409, wr.text);
    assert.equal(wr.json.hint, 'xm_stale_epoch');
  } finally { s.close(); }
  assert.deepEqual(live(PROT, 'xm_records', u.id), ['x1']);
  assert.equal(rows(PROT, 'xm_records', u.id, "id = 'stale'").length, 0);
});

test('协议：两个恢复在「读版本号」和「写版本号」之间的窗口里交错 —— 仍然只有一个成功', async () => {
  const u = newUser(PROT);
  seed(PROT, u.id, { records: [rec('old1')], accounts: [acc('a_cash')], categories: [cat('e_food')] });
  const J1 = await sealedJob(PROT, u, bk(['x1'])), J2 = await sealedJob(PROT, u, bk(['y1']));
  // 测试专用：把「更新版本号」这一步拖慢 1 秒，人为拉大窗口
  sql(PROT, `create or replace function public.xm_test_meta_slow() returns trigger language plpgsql as $$ begin if new.user_id = '${u.id}' then perform pg_sleep(1); end if; return new; end $$;
             create trigger xm_test_meta_slow before update on public.xm_meta for each row execute function public.xm_test_meta_slow();`);
  let a, b;
  try {
    const pa = rpc(PROT, u, 'xm_restore_apply', { p_job: J1.job, p_expected_epoch: 0 });
    await new Promise(r => setTimeout(r, 200));
    const pb = rpc(PROT, u, 'xm_restore_apply', { p_job: J2.job, p_expected_epoch: 0 });
    [a, b] = await Promise.all([pa, pb]);
  } finally { sql(PROT, 'drop trigger if exists xm_test_meta_slow on public.xm_meta; drop function if exists public.xm_test_meta_slow();'); }
  assert.deepEqual([a.status, b.status].sort(), [200, 409], a.text + ' / ' + b.text);
  assert.equal(epochOf(PROT, u.id), 1);
  assert.equal(Number(sql(PROT, `select count(*) from public.xm_restore_job where user_id = '${u.id}' and state = 'applied'`)), 1);
});

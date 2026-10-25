// 审核清单 9：已有账号使用 epoch 后，回滚操作不会重新放开旧版写入；协议未被使用时可以完整回滚
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ENV, sql, sqlFile, freshDb, newUser, seed, asUser, tryAsUser, sqlRestore, rec, STD } from './lib.mjs';

const ROLLBACK = path.join(ENV.root, 'supabase', 'restore_epoch_rollback.sql');
// 「旧版客户端」的写入：以 authenticated 身份 upsert，不带 x-xm-epoch
const legacyWrite = (db, u, id) => tryAsUser(db, u, `insert into public.xm_records (user_id, id, type, amount, date, note, deleted) values ('${u.id}', '${id}', 'expense', 1, '2026-10-21', '旧版写入', false) on conflict (user_id, id) do update set note = excluded.note, deleted = false;`);
// 结构指纹：表和列、触发器、函数、策略、schema、相关表的权限
const shape = db => sql(db, `select json_build_object(
  'cols', (select json_agg(table_schema || '.' || table_name || '.' || column_name || ':' || data_type order by 1) from information_schema.columns where table_schema in ('public', 'xm_guard')),
  'trg', (select json_agg(tgrelid::regclass::text || '.' || tgname order by 1) from pg_trigger where not tgisinternal),
  'fn', (select json_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' order by 1) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'xm_guard')),
  'pol', (select json_agg(tablename || '.' || policyname order by 1) from pg_policies where schemaname = 'public'),
  'nsp', (select json_agg(nspname order by 1) from pg_namespace where nspname in ('xm_guard', 'public', 'auth')),
  'acl', (select json_agg(table_name || ':' || grantee || ':' || privilege_type order by 1) from information_schema.role_table_grants where table_schema = 'public'))`);

test('对照：在已经恢复过的账本上直接删掉写入保护触发器（不做判断的回滚）—— 旧版客户端重新能写入旧数据', () => {
  const db = freshDb('xm_rb_naive');
  const u = newUser(db), { cloud, backup } = STD();
  seed(db, u.id, cloud);
  sqlRestore(db, u, backup);
  assert.equal(legacyWrite(db, u, 'r_after').ok, false, '前置：恢复后旧版写入被拒');
  sql(db, ['xm_records', 'xm_accounts', 'xm_categories', 'xm_cats', 'xm_state'].map(t => `drop trigger ${t}_guard on public.${t};`).join(' '), { user: 'xm_owner' });
  assert.equal(legacyWrite(db, u, 'r_after').ok, true, '问题复现：旧版客户端又把恢复前的旧账单写回去了');
});

test('回滚：已有账本恢复过 → 拒绝完整回滚，只停用新的恢复；写入保护、版本号、存档都保留，旧版写入仍被拒', () => {
  const db = freshDb('xm_rb_used');
  const u = newUser(db), { cloud, backup } = STD();
  seed(db, u.id, cloud);
  sqlRestore(db, u, backup);
  const r = sqlFile(db, ROLLBACK, { user: 'xm_owner' });
  assert.ok(r.ok, r.err);
  assert.match(r.err, /已有账本应用过恢复/);
  assert.equal(sql(db, "select count(*) from pg_trigger where tgname like 'xm_%_guard'"), '5');
  assert.equal(sql(db, `select epoch from public.xm_meta where user_id = '${u.id}'`), '1');
  assert.ok(Number(sql(db, 'select count(*) from public.xm_restore_archive')) > 0, '存档还在');
  assert.equal(legacyWrite(db, u, 'r_after').ok, false, '旧版写入仍被拒');
  assert.equal(tryAsUser(db, u, `insert into public.xm_records (user_id, id, type, amount, date, note) values ('${u.id}', 'n1', 'expense', 1, '2026-10-21', '新版');`, { 'x-xm-epoch': '1' }).ok, true, '新版客户端照常写');
  for (const fn of ['xm_restore_create(uuid, jsonb)', 'xm_restore_stage(uuid, text, jsonb)', 'xm_restore_seal(uuid, jsonb, jsonb)', 'xm_restore_apply(uuid, integer)', 'xm_restore_cancel(uuid)']) {
    assert.equal(sql(db, `select has_function_privilege('authenticated', 'public.${fn}', 'execute')`), 'f', fn + ' 应当已停用');
  }
  const again = sqlFile(db, ROLLBACK, { user: 'xm_owner' });   // 再执行一次也安全
  assert.ok(again.ok, again.err);
  assert.equal(legacyWrite(db, u, 'r_after2').ok, false);
});

test('回滚：协议从未被使用 → 完整删除，结构与迁移前逐项一致，旧版写入正常', () => {
  const before = freshDb('xm_rb_ref', { migrate: false });
  const db = freshDb('xm_rb_unused');
  const u = newUser(db);
  // 用过普通同步（epoch 0 的写入），也建过但取消了任务 —— 都不算「使用过恢复」
  assert.equal(legacyWrite(db, u, 'x1').ok, true);
  asUser(db, u, `select public.xm_restore_create('11111111-1111-4111-8111-111111111111', '{"tables":["xm_records","xm_accounts","xm_categories"],"state_modules":[]}'::jsonb);`);
  asUser(db, u, `select public.xm_restore_cancel('11111111-1111-4111-8111-111111111111');`);
  const r = sqlFile(db, ROLLBACK, { user: 'xm_owner' });
  assert.ok(r.ok, r.err);
  assert.match(r.err, /从未被使用/);
  assert.deepEqual(JSON.parse(shape(db)), JSON.parse(shape(before)), '结构回到迁移前');
  assert.equal(legacyWrite(db, u, 'x2').ok, true);
  assert.equal(sql(db, `select count(*) from public.xm_records where user_id = '${u.id}'`), '2', '业务数据不受影响');
});

test('回滚：判断和删除在同一个事务里，并锁住 xm_meta —— 回滚期间完成的恢复会让回滚走「保留保护」分支', async () => {
  const db = freshDb('xm_rb_race');
  const u = newUser(db), { cloud, backup } = STD();
  seed(db, u.id, cloud);
  const { Session, isWaitingOnLock, waitUntil, planFor } = await import('./lib.mjs');
  // 先准备好一个已封存的任务
  const plan = planFor(backup), job = '22222222-2222-4222-8222-222222222222';
  const q = v => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  asUser(db, u, `select public.xm_restore_create('${job}', ${q(plan.scope)});`);
  for (const t of plan.scope.tables) asUser(db, u, `select public.xm_restore_stage('${job}', '${t}', ${q(plan.items[t].map(x => ({ h: x.h, row: x.row })))});`);
  asUser(db, u, `select public.xm_restore_seal('${job}', ${q(plan.manifest)}, ${q(plan.state)});`);
  // 恢复先拿到锁、未提交；回滚脚本开始执行（会在 lock table 处等待）
  const s = new Session(db);
  const rb = new Session(db, 'xm_owner');
  try {
    await s.begin(u);
    assert.equal((await s.run(`select public.xm_restore_apply('${job}', 0);`)).err, '');
    const pid = await rb.pid();
    const pr = rb.run(`\\i ${ROLLBACK}`);
    assert.ok(await waitUntil(() => isWaitingOnLock(db, pid)), '回滚应当在等待');
    await s.run('commit;');
    const out = await pr;
    assert.match(out.err, /已有账本应用过恢复/, out.err);
  } finally { s.close(); rb.close(); }
  assert.equal(sql(db, "select count(*) from pg_trigger where tgname like 'xm_%_guard'"), '5');
  assert.equal(legacyWrite(db, u, 'r_after').ok, false);
});

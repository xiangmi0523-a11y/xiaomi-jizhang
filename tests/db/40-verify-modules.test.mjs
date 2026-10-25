// 审核清单 6、7：最终核对能识别「条数相同但 ID 或内容不同」；旧备份缺可选模块时不清空 xm_state 里应保留的模块
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { BASE, PROT, sql, newUser, seed, rows, live, epochOf, rpc, naiveRestore, sealedJob, fullRestore, snapshot, rec, acc, cat, kitty, STD } from './lib.mjs';

const testTrigger = (db, table, name, uid, body) => {
  sql(db, `create or replace function public.${name}() returns trigger language plpgsql as $$ begin if new.user_id = '${uid}' then ${body} end if; return new; end $$;
           create trigger ${name} before insert or update on public.${table} for each row execute function public.${name}();`);
  return () => sql(db, `drop trigger if exists ${name} on public.${table}; drop function if exists public.${name}();`);
};
const countOnly = (db, uid, n) => Number(sql(db, `select count(*) from public.xm_records where user_id = '${uid}' and not deleted`)) === n;

test('基线（对照）：只核对条数时，「条数相同但内容不同」会被当成成功', async () => {
  const u = newUser(BASE), { cloud, backup } = STD();
  seed(BASE, u.id, cloud);
  const drop = testTrigger(BASE, 'xm_records', 'xm_test_swap', u.id, "if new.id = 'r2' then new.id := 'r2_wrong'; end if; if new.id = 'r4' then new.amount := 1; end if;");
  try { await naiveRestore(BASE, u, backup); } finally { drop(); }
  assert.ok(countOnly(BASE, u.id, 3), '条数是 3，和备份一样 —— 只看条数会判为成功');
  const got = rows(BASE, 'xm_records', u.id, 'not deleted').map(r => [r.id, r.amount]).sort();
  const want = backup.tables.xm_records.map(r => [r.id, r.amount]).sort();
  assert.notDeepEqual(got, want, '问题复现：实际内容和备份不一致：' + JSON.stringify(got));
});

for (const [name, body, table] of [
  ['一行的金额被改了（条数不变）', "if new.id = 'r2' then new.amount := new.amount + 1; end if;", 'xm_records'],
  ['一行被换成了别的 ID（条数不变）', "if new.id = 'r2' then new.id := 'r2_wrong'; end if;", 'xm_records'],
  ['一行的备注被改了（条数不变）', "if new.id = 'r1' then new.note := '被改过'; end if;", 'xm_records'],
  ['整块设置被改了', "new.data := new.data || '{\"budget\": {\"total\": 1}}'::jsonb;", 'xm_state']
]) {
  test(`协议：应用过程中${name} —— 核对失败，整个事务回滚，云端和版本号都不变`, async () => {
    const u = newUser(PROT), { cloud, backup } = STD();
    seed(PROT, u.id, { ...cloud, state: { budget: { total: 5000 } } });
    backup.state = { budget: { total: 3000 } };
    const J = await sealedJob(PROT, u, backup);
    const before = snapshot(PROT, u.id);
    const drop = testTrigger(PROT, table, 'xm_test_tamper', u.id, body);
    let r;
    try { r = await rpc(PROT, u, 'xm_restore_apply', { p_job: J.job, p_expected_epoch: 0 }); } finally { drop(); }
    assert.equal(r.status, 500, r.text);
    assert.equal(r.json.hint, 'xm_verify_failed');
    assert.equal(snapshot(PROT, u.id), before);
    assert.equal(epochOf(PROT, u.id), 0);
    assert.equal(sql(PROT, `select state from public.xm_restore_job where job_id = '${J.job}'`), 'sealed');
  });
}

const CLOUD_STATE = {
  budget: { total: 500000, cats: {} },
  smart: { on: true, income: 800000, fixed: 300000, saving: 100000 },
  saving: { plans: [{ id: 'sv1', name: '旅行基金', target: 500000 }] },
  game: { coins: 777, signed: ['2026-10-20'], inn: { slots: {}, owned: ['lamp'] } },
  settings: { theme: 'mint', mode: 'dark' },
  recurring: [{ id: 'p1', amount: 1500, freq: 'daily' }],
  created: 1760000000000
};
const OLD_FORMAT_BACKUP = () => ({   // 很早以前的备份：只有账单、账户、分类、预算
  tables: { xm_records: [rec('r1')], xm_accounts: [acc('a_cash')], xm_categories: [cat('e_food')] },
  state: { budget: { total: 100000, cats: {} } }
});

test('基线（现状）：旧格式备份按 normalize 后的默认值整块写回 —— 云端的智能预算、存钱计划、金币、客栈被清空', async () => {
  const u = newUser(BASE);
  seed(BASE, u.id, { records: [rec('r1')], accounts: [acc('a_cash')], categories: [cat('e_food')], state: CLOUD_STATE });
  const b = OLD_FORMAT_BACKUP();
  // 现在的 App 导入旧备份后，normalize 会补上默认值，再整块上传 xm_state
  b.state = { budget: b.state.budget, smart: { on: false, income: 0, fixed: 0, saving: 0 }, saving: { plans: [] }, game: { coins: 100, signed: [], inn: { slots: {}, owned: [] } }, settings: { theme: 'millet', mode: 'auto' }, recurring: [], created: Date.now() };
  await naiveRestore(BASE, u, b);
  const data = rows(BASE, 'xm_state', u.id)[0].data;
  assert.equal(data.smart.on, false, '问题复现：智能预算被关掉了');
  assert.deepEqual(data.saving.plans, [], '存钱计划没了');
  assert.equal(data.game.coins, 100, '金币被重置');
});

test('协议：旧格式备份只有 budget —— 只覆盖 budget，其余模块原样保留，一个键都不少', async () => {
  const u = newUser(PROT);
  seed(PROT, u.id, { records: [rec('r1')], accounts: [acc('a_cash')], categories: [cat('e_food')], state: CLOUD_STATE });
  const r = await fullRestore(PROT, u, OLD_FORMAT_BACKUP());
  assert.equal(r.apply.status, 200, r.apply.text);
  const data = rows(PROT, 'xm_state', u.id)[0].data;
  assert.deepEqual(data, { ...CLOUD_STATE, budget: { total: 100000, cats: {} } });
});

test('协议：备份没有 game.cats —— xm_cats 不在恢复范围，云端的猫一只都不动', async () => {
  const u = newUser(PROT);
  seed(PROT, u.id, { records: [rec('r1')], accounts: [acc('a_cash')], categories: [cat('e_food')], cats: [kitty('n1'), kitty('r1', { n: 3 })] });
  const before = rows(PROT, 'xm_cats', u.id);
  const r = await fullRestore(PROT, u, OLD_FORMAT_BACKUP());
  assert.equal(r.apply.status, 200, r.apply.text);
  assert.deepEqual(rows(PROT, 'xm_cats', u.id), before);
});

test('协议：备份带 game.cats —— 猫在恢复范围内，备份里没有的猫被软删除', async () => {
  const u = newUser(PROT);
  seed(PROT, u.id, { records: [rec('r1')], accounts: [acc('a_cash')], categories: [cat('e_food')], cats: [kitty('n1'), kitty('r1')] });
  const b = OLD_FORMAT_BACKUP(); b.tables.xm_cats = [kitty('n1', { n: 9 })];
  assert.equal((await fullRestore(PROT, u, b)).apply.status, 200);
  assert.deepEqual(rows(PROT, 'xm_cats', u.id).map(k => [k.cat_id, k.n, k.deleted]), [['n1', 9, false], ['r1', 1, true]]);
});

test('协议：范围声明了模块、补丁却缺了它（或多了别的） —— 封存被拒', async () => {
  const u = newUser(PROT);
  const b = OLD_FORMAT_BACKUP();
  const { planFor } = await import('./lib.mjs');
  const plan = planFor(b), job = crypto.randomUUID();
  await rpc(PROT, u, 'xm_restore_create', { p_job: job, p_scope: plan.scope });
  const { stageAll } = await import('./lib.mjs');
  await stageAll(PROT, u, job, plan);
  const miss = await rpc(PROT, u, 'xm_restore_seal', { p_job: job, p_manifest: plan.manifest, p_state_patch: {} });
  assert.equal(miss.status, 400); assert.equal(miss.json.hint, 'xm_bad_manifest');
  const extra = await rpc(PROT, u, 'xm_restore_seal', { p_job: job, p_manifest: plan.manifest, p_state_patch: { budget: {}, smart: { on: false } } });
  assert.equal(extra.status, 400);
});

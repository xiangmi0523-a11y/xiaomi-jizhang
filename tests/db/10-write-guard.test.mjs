// 审核清单 1：旧版客户端、旧 epoch、缺少版本号的 upsert 被正确拒绝（经真实 PostgREST）
import test from 'node:test';
import assert from 'node:assert/strict';
const ok2xx = (r, m) => assert.ok(r.status >= 200 && r.status < 300, `${m || ''} ${r.status} ${r.text}`);
import { BASE, PROT, newUser, seed, rows, live, epochOf, legacyUpsert, epochUpsert, legacyMarkDeleted, api, fullRestore, naiveRestore, snapshot, rec, STD } from './lib.mjs';

test('基线（现状）：朴素恢复之后，另一台旧版手机把备份之外的旧账单重新传回云端 —— H3 可复现', async () => {
  const u = newUser(BASE), { cloud, backup } = STD();
  seed(BASE, u.id, cloud);
  await naiveRestore(BASE, u, backup);
  assert.deepEqual(live(BASE, 'xm_records', u.id), ['r1', 'r2', 'r4'], '前置：朴素恢复看起来成功了');
  const r = await legacyUpsert(BASE, u, 'xm_records', [rec('r_after', 999, '导出后新增')]);   // 另一台手机上还留着这笔
  ok2xx(r);
  assert.deepEqual(live(BASE, 'xm_records', u.id), ['r1', 'r2', 'r4', 'r_after'], '问题复现：旧账单又回到了云端');
});

test('协议：账号从未恢复过时，旧版客户端照常 upsert、软删除（向下兼容），epoch 记为 0', async () => {
  const u = newUser(PROT);
  ok2xx(await legacyUpsert(PROT, u, 'xm_records', [rec('x1'), rec('x2')]));
  ok2xx(await legacyUpsert(PROT, u, 'xm_records', [rec('x1', 555)]));
  ok2xx(await legacyMarkDeleted(PROT, u, 'xm_records', ['x2']));
  const all = rows(PROT, 'xm_records', u.id);
  assert.deepEqual(all.map(r => [r.id, r.amount, r.deleted, r.epoch]), [['x1', 555, false, 0], ['x2', 100, true, 0]]);
});

test('协议：恢复生效后，旧版客户端的各种写法全部被拒（HTTP 409），云端一行不变', async () => {
  const u = newUser(PROT), { cloud, backup } = STD();
  seed(PROT, u.id, cloud);
  const res = await fullRestore(PROT, u, backup);
  assert.equal(res.apply.status, 200, res.apply.text);
  assert.equal(epochOf(PROT, u.id), 1);
  const before = snapshot(PROT, u.id);

  const attempts = {
    '新增行、不带版本号': await legacyUpsert(PROT, u, 'xm_records', [rec('r_after', 999, '导出后新增')]),
    'upsert 已有行、不带版本号（走更新路径）': await legacyUpsert(PROT, u, 'xm_records', [rec('r1', 1)]),
    '带旧版本号 0': await epochUpsert(PROT, u, 'xm_records', [rec('r_after', 999)], 0),
    '带非法版本号': await api(PROT, u, 'POST', '/xm_records?on_conflict=user_id,id', { body: [{ user_id: u.id, ...rec('zz') }], prefer: 'resolution=merge-duplicates', headers: { 'x-xm-epoch': '1 or 1=1' } }),
    '软删除、不带版本号': await legacyMarkDeleted(PROT, u, 'xm_records', ['r1']),
    '软删除、带旧版本号': await legacyMarkDeleted(PROT, u, 'xm_records', ['r1'], 'id', { 'x-xm-epoch': '0' }),
    '硬删除、带正确版本号': await api(PROT, u, 'DELETE', '/xm_records?id=eq.r1', { headers: { 'x-xm-epoch': '1' } }),
    '整块设置、不带版本号': await api(PROT, u, 'POST', '/xm_state?on_conflict=user_id', { body: [{ user_id: u.id, data: { budget: { total: 1 } } }], prefer: 'resolution=merge-duplicates' }),
    '账户表、不带版本号': await legacyUpsert(PROT, u, 'xm_accounts', [{ id: 'a_old', name: '旧账户', type: 'cash', init: 0, hidden: false, sort: 0, extra: {} }])
  };
  for (const [name, r] of Object.entries(attempts)) {
    assert.equal(r.status, 409, `${name} 应被拒绝：${r.status} ${r.text}`);
    assert.equal(r.json.hint, 'xm_stale_epoch', name);
  }
  assert.match(attempts['新增行、不带版本号'].json.message, /请把晓米记账更新到最新版/, '旧版 App 会原样显示这句');
  assert.equal(snapshot(PROT, u.id), before, '云端一行都没变');
});

test('协议：带正确版本号的新版客户端可以继续写；客户端自己填的 epoch 列会被服务器覆盖', async () => {
  const u = newUser(PROT), { cloud, backup } = STD();
  seed(PROT, u.id, cloud);
  assert.equal((await fullRestore(PROT, u, backup)).apply.status, 200);
  const r = await epochUpsert(PROT, u, 'xm_records', [{ ...rec('n1', 300, '恢复后新记'), epoch: 999 }], 1);
  ok2xx(r);
  const row = rows(PROT, 'xm_records', u.id, "id = 'n1'")[0];
  assert.equal(row.epoch, 1);
  assert.equal((await legacyMarkDeleted(PROT, u, 'xm_records', ['n1'], 'id', { 'x-xm-epoch': '1' })).status, 200);
});

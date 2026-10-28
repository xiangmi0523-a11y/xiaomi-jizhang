// Phase 2B-2：发现账本被恢复（epoch 变化）→ 本机快照 → 冲突箱保存未同步修改 → 与云端对齐（真实 PostgreSQL + PostgREST）
'use strict';
const { test, expect, js, serverRestore, login, newEmail, uidOf } = require('./fixtures');
const { rec, acc, cat } = require('./protocol-cjs');

const T = '2026-10-21T20:00:00+08:00';
const addRec = (page, note, amount = 100) => js(page, `App.addRecord({ type: 'expense', amount: ${amount}, cat: 'e_food', acc: 'a_cash', to: '', date: '2026-10-21', note: ${JSON.stringify(note)} }).id`);
const syncNow = async page => { await page.evaluate(() => { window.App.cloud.sync(false); }); await page.waitForFunction(() => !window.App.cloud.busy); return page.evaluate(() => window.App.cloud.err || ''); };
const manualOff = page => js(page, '(App.S.settings.cloudAuto = false, App.flush(), 0)');   // 关掉自动同步，测试里显式触发
const pending = page => js(page, 'App.conflicts.pending().map(c => ({ table: c.table, key: c.key, kind: c.kind, local: c.local })).sort((a, b) => (a.table + a.key).localeCompare(b.table + b.key))');
const notes = page => js(page, 'App.S.records.map(r => r.note).sort()');

// 准备：一个账号，B 设备登录并同步了三笔账，然后关掉自动同步
async function setup(openApp, gw) {
  const email = newEmail();
  const B = await openApp({ name: 'B', time: T, cloudUrl: gw.url });
  const ids = { r1: await addRec(B, '早餐', 100), r2: await addRec(B, '午饭', 200), r3: await addRec(B, '晚饭', 300) };
  await login(B, email, 'secret123', { signup: true });
  await manualOff(B);
  expect(await syncNow(B)).toBe('');
  const uid = uidOf(gw, email);
  expect(gw.db.live(uid)).toHaveLength(3);
  return { email, B, ids, uid };
}
// 另一台设备恢复的备份：r1 原样、r2 金额不同、没有 r3、多一笔 x9
const backupOf = ids => ({
  tables: {
    xm_records: [rec(ids.r1, 100, '早餐'), rec(ids.r2, 250, '午饭（备份）'), rec('x9', 900, '备份里才有')],
    xm_accounts: [acc('a_cash'), acc('a_wx', '微信', { type: 'ewallet', sort: 1 })],
    xm_categories: [cat('e_food')]
  }
});

test('第二台设备有未同步的新增、编辑、删除和设置修改 —— 全部原样进冲突箱，本机对齐成恢复后的账本，云端不被改', async ({ openApp, gw }) => {
  const { email, B, ids, uid } = await setup(openApp, gw);
  // B 离线期间的修改（都没同步）
  const nid = await addRec(B, '离线新记的', 777);
  await js(B, `(() => { const r = App.S.records.find(x => x.id === ${JSON.stringify(ids.r1)}); r.amount = 111; r.note = '早餐（离线改过）'; App.changed(); return 0; })()`);
  await js(B, `(App.deleteRecord(${JSON.stringify(ids.r2)}), 0)`);
  await js(B, '(App.S.budget.total = 123400, App.changed(), 0)');
  await serverRestore(gw, email, backupOf(ids));
  const cloudBefore = gw.db.sql(`select json_agg(t order by id) from (select id, amount, note, deleted from public.xm_records where user_id = '${uid}') t`);

  expect(await syncNow(B)).toBe('');
  const box = await pending(B);
  expect(box.map(c => [c.table, c.key, c.kind])).toEqual([
    ['xm_records', ids.r1, 'edit'], ['xm_records', ids.r2, 'delete'], ['xm_records', nid, 'add'], ['xm_state', 'budget', 'state']
  ].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1])));
  const byKey = Object.fromEntries(box.map(c => [c.key, c]));
  expect(byKey[nid].local).toMatchObject({ id: nid, amount: 777, note: '离线新记的', date: '2026-10-21', cat: 'e_food', acc: 'a_cash' });
  expect(byKey[ids.r1].local).toMatchObject({ amount: 111, note: '早餐（离线改过）' });
  expect(byKey.budget.local.total).toBe(123400);

  // 本机 = 恢复后的云端；版本号更新；快照里有对齐前的账本
  expect(await notes(B)).toEqual(['午饭（备份）', '备份里才有', '早餐']);
  expect(await js(B, 'App.S.sync.epoch')).toBe(1);
  const snap = await js(B, "(() => { const os = Object.keys(localStorage).filter(k => k.startsWith('xm_snap:')).map(k => JSON.parse(localStorage.getItem(k))).sort((a, b) => b.meta.at - a.meta.at); return JSON.parse(os[0].data).records.map(r => r.note).sort(); })()");
  expect(snap).toEqual(['早餐（离线改过）', '晚饭', '离线新记的']);
  // B 没有往云端写任何东西
  expect(gw.db.sql(`select json_agg(t order by id) from (select id, amount, note, deleted from public.xm_records where user_id = '${uid}') t`)).toBe(cloudBefore);
  // 冲突箱跟着账本一起落盘：重开 App 还在
  await B.reload(); await B.waitForFunction(() => window.App && window.App.S);
  expect((await pending(B)).length).toBe(4);
});

test('本机快照没写成功 —— 不覆盖本机账本、不写冲突箱、不更新版本号，提示明确', async ({ openApp, gw }) => {
  const { email, B, ids } = await setup(openApp, gw);
  await addRec(B, '离线新记的', 777);
  await serverRestore(gw, email, backupOf(ids));
  const before = await js(B, 'JSON.stringify(App.S.records)');
  await js(B, `(() => { const raw = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('xm_snap:')) throw new DOMException('QuotaExceededError', 'QuotaExceededError'); return raw.call(this, k, v); }; return 0; })()`);
  const err = await syncNow(B);
  expect(err).toContain('没能先保存本机账本');
  expect(await js(B, 'JSON.stringify(App.S.records)')).toBe(before);
  expect(await js(B, '[App.S.sync.epoch, App.conflicts.all().length]')).toEqual([0, 0]);
});

test('冲突箱写不进去 —— 同样不覆盖本机账本，内存里的冲突箱也回滚', async ({ openApp, gw }) => {
  const { email, B, ids } = await setup(openApp, gw);
  await addRec(B, '离线新记的', 777);
  await serverRestore(gw, email, backupOf(ids));
  const before = await js(B, 'JSON.stringify(App.S.records)');
  await js(B, `(() => { const raw = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'xiaomi_ledger_v1' && String(v).includes('"conflicts"')) throw new DOMException('QuotaExceededError', 'QuotaExceededError'); return raw.call(this, k, v); }; return 0; })()`);
  const err = await syncNow(B);
  expect(err).toContain('没能保存冲突箱');
  expect(await js(B, 'JSON.stringify(App.S.records)')).toBe(before);
  expect(await js(B, '[App.S.sync.epoch, App.conflicts.all().length]')).toEqual([0, 0]);
});

test('两台设备并发：B 写入时撞上恢复（409）→ 自动对齐；对齐拉取期间 B 又记的一笔也进冲突箱；之后新记的正常上云', async ({ openApp, gw }) => {
  const { email, B, ids, uid } = await setup(openApp, gw);
  await js(B, '(App.S.settings.cloudAuto = true, App.flush(), 0)');
  let restored = false, held = false;
  gw.before = async e => {
    if (e.uid !== uid) return;
    // B 的第一笔写入到达时，另一台设备抢先完成恢复 → 这笔写入会收到 409
    if (!restored && e.method !== 'GET' && e.path.startsWith('/rest/v1/xm_')) { restored = true; await serverRestore(gw, email, backupOf(ids)); }
    // 对齐时的全量拉取：拖慢 1.5 秒，期间 B 又记了一笔
    if (restored && !held && e.method === 'GET' && e.path === '/rest/v1/xm_records' && !/updated_at=gt/.test(e.query)) { held = true; await new Promise(r => setTimeout(r, 1500)); }
  };
  const first = await addRec(B, '撞上恢复的那笔', 500);
  await expect.poll(() => held, { timeout: 15000 }).toBe(true);
  const during = await addRec(B, '对齐期间记的', 600);
  await B.waitForFunction(() => window.App.S.sync.epoch === 1 && !window.App.cloud.busy, null, { timeout: 20000 });
  const keys = (await pending(B)).map(c => c.key);
  expect(keys).toContain(first);
  expect(keys).toContain(during);
  expect(gw.db.live(uid)).toEqual([ids.r1, ids.r2, 'x9'].sort());          // 冲突箱里的还没上云
  const after = await addRec(B, '对齐之后新记的', 700);
  await expect.poll(() => gw.db.live(uid), { timeout: 15000 }).toContain(after);
  expect(gw.db.rows('xm_records', uid, `id = '${after}'`)[0].epoch).toBe(1);
});

test('冲突箱重复处理（连点、重复调用、重启后再点）—— 不重复生成记录、不重复发金币或盲盒进度、不退金币', async ({ openApp, gw }) => {
  const { email, B, ids, uid } = await setup(openApp, gw);
  const nid = await addRec(B, '离线新记的', 777);
  await js(B, `(App.deleteRecord(${JSON.stringify(ids.r1)}), 0)`);
  await serverRestore(gw, email, backupOf(ids));
  expect(await syncNow(B)).toBe('');
  const reward = () => js(B, '[App.S.game.coins, App.S.game.progress, App.S.game.signed.length, JSON.stringify(App.S.game.cats)]');
  const r0 = await reward();
  const idOf = key => js(B, `App.conflicts.pending().find(c => c.key === ${JSON.stringify(key)}).id`);
  const addId = await idOf(nid), delId = await idOf(ids.r1);

  // 界面上快速连点两下「加回去」
  await js(B, '(App.A.openConflicts(), 0)');
  const btn = B.locator(`.cf-item[data-id="${addId}"] [data-cf="apply"]`);
  await btn.evaluate(el => { el.click(); el.click(); });
  expect(await js(B, `[App.conflicts.resolve(${JSON.stringify(addId)}, 'apply'), App.conflicts.resolve(${JSON.stringify(addId)}, 'discard')]`)).toEqual([false, false]);
  expect(await js(B, `App.S.records.filter(r => r.id === ${JSON.stringify(nid)}).length`)).toBe(1);
  // 删除项：也删掉（不退金币）
  expect(await js(B, `App.conflicts.resolve(${JSON.stringify(delId)}, 'apply')`)).toBe(true);
  expect(await js(B, `App.S.records.some(r => r.id === ${JSON.stringify(ids.r1)})`)).toBe(false);
  expect(await reward()).toEqual(r0);

  // 重启后再处理一次：仍然只有一笔
  await B.reload(); await B.waitForFunction(() => window.App && window.App.S);
  expect(await js(B, `App.conflicts.resolve(${JSON.stringify(addId)}, 'apply')`)).toBe(false);
  expect(await js(B, `App.S.records.filter(r => r.id === ${JSON.stringify(nid)}).length`)).toBe(1);
  expect(await reward()).toEqual(r0);

  // 同步两次：云端也只有一笔，删除也传上去了
  await manualOff(B);
  expect(await syncNow(B)).toBe('');
  expect(await syncNow(B)).toBe('');
  expect(gw.db.rows('xm_records', uid, `id = '${nid}'`)).toHaveLength(1);
  expect(gw.db.live(uid)).toEqual([ids.r2, nid, 'x9'].sort());
});

test('整块设置：本机改过的模块进冲突箱；选「用这台手机的」只改这个模块，其余保持云端的', async ({ openApp, gw }) => {
  const { email, B, ids, uid } = await setup(openApp, gw);
  await js(B, "(App.S.smart.on = true, App.S.smart.income = 800000, App.S.saving.plans.push({ id: 'sv1', type: 'free', name: '旅行', created: '2026-10-21', done: {}, log: [], target: 1000 }), App.changed(), 0)");
  expect(await syncNow(B)).toBe('');
  await js(B, '(App.S.budget.total = 99900, App.changed(), 0)');          // 只改了预算
  const b = backupOf(ids); b.state = { budget: { total: 50000, cats: {} } };
  await serverRestore(gw, email, b);
  expect(await syncNow(B)).toBe('');
  const box = await pending(B);
  expect(box.map(c => c.key)).toEqual(['budget']);                       // 智能预算、存钱计划没改过，不进冲突箱
  expect(await js(B, '[App.S.budget.total, App.S.smart.on, App.S.saving.plans.length]')).toEqual([50000, true, 1]);
  await js(B, `(App.conflicts.resolve(App.conflicts.pending()[0].id, 'apply'), 0)`);
  expect(await js(B, '[App.S.budget.total, App.S.smart.on, App.S.saving.plans.length]')).toEqual([99900, true, 1]);
  expect(await syncNow(B)).toBe('');
  expect(gw.db.state(uid).budget.total).toBe(99900);
  expect(gw.db.state(uid).smart.on).toBe(true);
});

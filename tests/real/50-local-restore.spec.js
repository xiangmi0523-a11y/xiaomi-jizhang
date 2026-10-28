// D5：「从快照恢复本机」—— 只改这台手机，不发任何网络请求；保护点、暂停同步、恢复云同步、撤销；失败回滚、重启、重复操作
'use strict';
const { test, expect, js, serverRestore, login, newEmail, uidOf } = require('./fixtures');
const { rec, acc, cat } = require('./protocol-cjs');
const { SNAP, sha } = require('../support/fake-native');

const T = '2026-10-21T20:00:00+08:00';
const addRec = (page, note, amount = 100) => js(page, `App.addRecord({ type: 'expense', amount: ${amount}, cat: 'e_food', acc: 'a_cash', to: '', date: '2026-10-21', note: ${JSON.stringify(note)} }).id`);
const syncNow = async page => { await page.evaluate(() => { window.App.cloud.sync(false); }); await page.waitForFunction(() => !window.App.cloud.busy, null, { timeout: 60000 }); return page.evaluate(() => window.App.cloud.err || ''); };
const manualOff = page => js(page, '(App.S.settings.cloudAuto = false, App.flush(), 0)');
const notes = page => js(page, 'App.S.records.map(r => r.note).sort()');
const backupOf = ids => ({ tables: { xm_records: [rec(ids.r1, 100, '早餐'), rec(ids.r2, 250, '午饭（备份）'), rec('x9', 900, '备份里才有')], xm_accounts: [acc('a_cash')], xm_categories: [cat('e_food')] } });
const restoreAlign = page => js(page, "App.safety.list().then(xs => App.safety.restoreLocal(xs.find(x => x.meta && x.meta.kind === 'align')))");
const netFrom = (gw, uid, t0) => gw.log.filter(l => l.uid === uid && l.t >= t0).map(l => l.method + ' ' + l.path);
const dataOf = page => js(page, '({ records: App.S.records, budget: App.S.budget, game: App.S.game, saving: App.S.saving, epoch: App.S.sync.epoch, conflicts: App.conflicts.all().map(c => [c.id, c.status]).sort() })');

// B 离线改过账（新增、修改、删除、预算）→ 另一台设备恢复 → B 对齐（快照保存了对齐前的账本，4 项进冲突箱）
async function setup(openApp, gw, durable = {}) {
  const email = newEmail();
  const B = await openApp({ name: 'B', time: T, cloudUrl: gw.url, durable });
  const ids = { r1: await addRec(B, '早餐', 100), r2: await addRec(B, '午饭', 200), r3: await addRec(B, '晚饭', 300) };
  await login(B, email, 'secret123', { signup: true });
  await manualOff(B);
  expect(await syncNow(B)).toBe('');
  const uid = uidOf(gw, email);
  ids.n = await addRec(B, '离线新记的', 777);
  await js(B, `(() => { const r = App.S.records.find(x => x.id === ${JSON.stringify(ids.r1)}); r.amount = 111; r.note = '早餐（离线改过）'; App.changed(); return 0; })()`);
  await js(B, `(App.deleteRecord(${JSON.stringify(ids.r2)}), 0)`);
  await js(B, '(App.S.budget.total = 123400, App.changed(), 0)');
  await serverRestore(gw, email, backupOf(ids));
  expect(await syncNow(B)).toBe('');
  expect(await js(B, '[App.S.sync.epoch, App.conflicts.pending().length]')).toEqual([1, 4]);
  return { email, B, ids, uid };
}

test('D1 通过界面恢复到本机：没有任何网络请求（无恢复 RPC、无账单写入）；数据回到快照；epoch 保持当前；冲突箱保留并补上未同步修改；暂停同步并在重启后保持', async ({ openApp, gw }) => {
  const { B, uid } = await setup(openApp, gw);
  const pend = await addRec(B, '对齐后没同步的', 333);
  const conf0 = await js(B, 'App.conflicts.pending().map(c => c.id).sort()');
  const cloud0 = gw.db.live(uid);
  const t0 = Date.now();
  await js(B, '(App.UI.closeAll(), App.A.openSnapshots(), 0)');
  await expect(B.locator('.sf-item').first()).toContainText('已校验');
  await B.click('[data-sf="restore"]');
  await expect(B.locator('.dlg p')).toContainText('不会恢复、也不会改动云端');
  await B.click('.dlg [data-r="1"]');
  await B.click('.dlg [data-r="1"]');
  await B.waitForFunction(() => window.App.safety.held(), null, { timeout: 20000 });
  expect(netFrom(gw, uid, t0)).toEqual([]);
  expect(await notes(B)).toEqual(['早餐（离线改过）', '晚饭', '离线新记的']);
  expect(await js(B, '[App.S.budget.total, App.S.sync.epoch]')).toEqual([123400, 1]);   // 当前 epoch，不是快照里的 0
  const box = await js(B, 'App.conflicts.pending().map(c => [c.id, c.src, c.key, c.table])');
  expect(box.map(b => b[0])).toEqual(expect.arrayContaining(conf0));                    // 原来的冲突项都在
  // 恢复前没同步的修改进了冲突箱（这份测试备份只有一个账户、一个分类，所以这台手机上云端没有的默认账户 / 分类也算未同步，一并保护）
  expect(box.filter(b => b[1] === 'local' && b[3] === 'xm_records').map(b => b[2])).toEqual([pend]);
  const prot = B.native.snapshots().find(s => s.meta.kind === 'protect');
  expect(JSON.parse(prot.data).records.some(r => r.id === pend)).toBe(true);           // 保护点 = 恢复前的完整账本
  expect(prot.meta.sha256).toBe(sha(Buffer.from(prot.data)));
  expect(B.native.mainJSON().sync.hold.kind).toBe('local-restore');                     // 已原子提交
  // 暂停同步：手动 / 自动同步都不发请求
  expect(await syncNow(B)).toContain('云端同步已暂停');
  await B.reloadNative();
  expect(await js(B, 'App.safety.held()')).toBe(true);
  expect(await syncNow(B)).toContain('云端同步已暂停');
  await expect(js(B, "App.restore.start(App.restore.validate(JSON.parse(App.restore.exportText())))")).rejects.toThrow(/恢复云同步/);   // 暂停期间不能开始云端恢复
  expect(netFrom(gw, uid, t0)).toEqual([]);
  expect(gw.db.live(uid)).toEqual(cloud0);
  expect(gw.db.epochOf(uid)).toBe(1);
});

test('D2 恢复云同步：强制对齐一次，本机恢复的内容和云端不同的地方进冲突箱（与已有项相同的不重复），不自动上传；之后正常同步', async ({ openApp, gw }) => {
  const { B, ids, uid } = await setup(openApp, gw);
  expect(await restoreAlign(B)).toBe(true);
  const t0 = Date.now();
  expect(await js(B, 'App.safety.resumeSync()')).toBe(true);
  expect(await js(B, '[App.safety.held(), App.S.sync.epoch]')).toEqual([false, 1]);
  expect(await notes(B)).toEqual(['午饭（备份）', '备份里才有', '早餐']);                // 本机 = 云端
  expect(gw.writes(uid, t0)).toEqual([]);                                               // 没有自动上传
  expect(netFrom(gw, uid, t0).filter(p => p.includes('/rpc/'))).toEqual([]);
  const box = await js(B, 'App.conflicts.pending().map(c => [c.src, c.key, c.kind, c.table])');
  expect(box.filter(b => b[1] === ids.n)).toHaveLength(1);                              // 跨批次去重
  // 账单里新的差异：快照里有「晚饭」（云端没有）、云端有「备份里才有」（快照里没有）；其余与已有冲突项相同，不重复
  expect(box.filter(b => b[0] === 'snapshot' && b[3] === 'xm_records').map(b => [b[1], b[2]]).sort()).toEqual([[ids.r3, 'add'], ['x9', 'delete']].sort());
  expect(box.filter(b => b[3] === 'xm_records')).toHaveLength(5);
  // 用户把「晚饭」加回去 → 正常同步上云（用户明确操作）
  await js(B, `(App.conflicts.pending().filter(c => c.key === ${JSON.stringify(ids.r3)}).forEach(c => App.conflicts.resolve(c.id, 'apply')), 0)`);
  expect(await syncNow(B)).toBe('');
  expect(gw.db.live(uid)).toEqual([ids.r1, ids.r2, ids.r3, 'x9'].sort());
});

test('D3 撤销本机恢复：回到恢复前的完整状态；恢复后改过数据就不能撤销（只能恢复云同步，不会丢）', async ({ openApp, gw }) => {
  const { B, uid } = await setup(openApp, gw);
  const before = await dataOf(B);
  const t0 = Date.now();
  expect(await restoreAlign(B)).toBe(true);
  expect(await js(B, 'App.safety.undoLocal()')).toBe(true);
  expect(await js(B, 'App.safety.held()')).toBe(false);
  expect(await dataOf(B)).toEqual(before);
  expect(netFrom(gw, uid, t0)).toEqual([]);
  expect(await syncNow(B)).toBe('');                                                    // 恢复同步
  // 恢复后改过数据：不能撤销
  expect(await restoreAlign(B)).toBe(true);
  await addRec(B, '恢复后记的', 50);
  await expect(js(B, 'App.safety.undoLocal()')).rejects.toThrow(/改过数据/);
  expect(await js(B, 'App.safety.held()')).toBe(true);
  expect(await js(B, 'App.safety.resumeSync()')).toBe(true);
  expect(await js(B, "App.conflicts.pending().some(c => c.local && c.local.note === '恢复后记的')")).toBe(true);   // 这笔进了冲突箱
});

test('D4 失败回滚和中断：保护点写不进去 / 提交失败 → 本机完全不变；提交途中被杀 → 重开后是恢复前的状态；之后重试成功', async ({ openApp, gw }) => {
  const { B } = await setup(openApp, gw);
  const before = await js(B, 'JSON.stringify(App.S)');
  B.native.fault({ op: 'snapshotWrite', mode: 'fail', code: 'ENOSPC' });                  // 保护点
  await expect(restoreAlign(B)).rejects.toThrow(/没能先保存本机账本/);
  expect(await js(B, 'JSON.stringify(App.S)')).toBe(before);
  B.native.fault({ op: 'ledgerStage', mode: 'fail', code: 'ENOSPC' });
  await expect(restoreAlign(B)).rejects.toThrow(/没能保存冲突箱和更新后的账本/);
  expect(await js(B, 'JSON.stringify(App.S)')).toBe(before);
  expect(await js(B, 'App.safety.held()')).toBe(false);
  B.native.fault({ op: 'ledgerCommit', mode: 'never' });                                 // 暂存完成后被杀（提交没执行，也没有回执）
  const t1 = Date.now();
  await B.evaluate(() => { window.App.safety.list().then(xs => window.App.safety.restoreLocal(xs.find(x => x.meta && x.meta.kind === 'align'))).catch(() => {}); });
  await expect.poll(() => B.native.calls.some(c => c.at >= t1 && c.op === 'ledgerCommit'), { timeout: 15000 }).toBe(true);
  expect(B.native.faults).toEqual([]);
  await B.reloadNative();
  expect(await js(B, 'App.safety.held()')).toBe(false);
  expect(await js(B, '[App.S.sync.epoch, App.conflicts.pending().length]')).toEqual([1, 4]);
  expect(await notes(B)).toEqual(['午饭（备份）', '备份里才有', '早餐']);
  expect(await restoreAlign(B)).toBe(true);                                             // 重试成功
  expect(await notes(B)).toEqual(['早餐（离线改过）', '晚饭', '离线新记的']);
});

test('D5 校验：快照被改坏、结构不对、属于别的账号 → 不能恢复，本机不变', async ({ openApp, gw }) => {
  const { B, uid } = await setup(openApp, gw);
  const before = await js(B, 'JSON.stringify(App.S)');
  const s = B.native.snapshots()[0];
  const put = (dir, data, meta) => { B.native.files.set(SNAP + dir + '/晓米记账-对齐前备份.json', Buffer.from(data)); B.native.files.set(SNAP + dir + '/晓米记账-对齐前备份.meta.json', Buffer.from(JSON.stringify(meta))); };
  const good = s.data, bad = good.replace('早餐（离线改过）', '早餐（被改过）');
  put('e70-x', bad, Object.assign({}, s.meta, { batch: uid + ':70' }));                   // 内容被改：SHA-256 对不上
  const noAcc = JSON.stringify(Object.assign(JSON.parse(good), { accounts: undefined }));
  put('e71-x', noAcc, Object.assign({}, s.meta, { batch: uid + ':71', bytes: Buffer.byteLength(noAcc), sha256: sha(Buffer.from(noAcc)) }));
  put('e72-x', good, Object.assign({}, s.meta, { uid: 'someone-else', batch: 'someone-else:72' }));
  const list = await js(B, 'App.safety.list().then(xs => xs.map(x => [x.dir, x.restorable]))');
  expect(list).toEqual(expect.arrayContaining([['e70-x', false], ['e71-x', true]]));
  expect(list.some(x => x[0] === 'e72-x')).toBe(false);                                 // 别的账号的快照不列出
  await expect(js(B, "App.safety.restoreLocal({ dir: 'e70-x', name: '晓米记账-对齐前备份.json' })")).rejects.toThrow(/校验没通过/);
  await expect(js(B, "App.safety.restoreLocal({ dir: 'e71-x', name: '晓米记账-对齐前备份.json' })")).rejects.toThrow(/缺少账单、账户或分类/);
  await expect(js(B, "App.safety.restoreLocal({ dir: 'e72-x', name: '晓米记账-对齐前备份.json' })")).rejects.toThrow(/不属于当前账号/);
  expect(await js(B, 'JSON.stringify(App.S)')).toBe(before);
});

test('D6 重复操作：同时点两次只生效一次、只有一个保护点；暂停期间不能再恢复；重启后状态不变', async ({ openApp, gw }) => {
  const { B } = await setup(openApp, gw);
  const r = await js(B, "App.safety.list().then(xs => { const x = xs.find(y => y.meta && y.meta.kind === 'align'); return Promise.allSettled([App.safety.restoreLocal(x), App.safety.restoreLocal(x)]); }).then(a => a.map(v => v.status === 'fulfilled' ? v.value : 'err'))");
  expect(r.filter(v => v === true)).toHaveLength(1);
  expect(B.native.snapshots().filter(s => s.meta.kind === 'protect')).toHaveLength(1);
  await expect(restoreAlign(B)).rejects.toThrow(/已经从快照恢复过本机/);
  const data = await dataOf(B);
  await B.reloadNative();
  expect(await dataOf(B)).toEqual(data);
  expect(await js(B, 'App.safety.held()')).toBe(true);
});

test('D7 网页版（没有原生能力）：快照在浏览器存储里，同样可以恢复到本机，不发任何网络请求', async ({ openApp, gw }) => {
  const { B, uid } = await setup(openApp, gw, { caps: null });
  expect(await js(B, "Object.keys(localStorage).filter(k => k.startsWith('xm_snap:')).length")).toBe(1);
  const t0 = Date.now();
  expect(await restoreAlign(B)).toBe(true);
  expect(netFrom(gw, uid, t0)).toEqual([]);
  expect(await notes(B)).toEqual(['早餐（离线改过）', '晚饭', '离线新记的']);
  expect(await js(B, '[App.safety.held(), App.S.sync.epoch]')).toEqual([true, 1]);
  expect(await js(B, 'App.safety.resumeSync()')).toBe(true);
  expect(gw.writes(uid, t0)).toEqual([]);
});

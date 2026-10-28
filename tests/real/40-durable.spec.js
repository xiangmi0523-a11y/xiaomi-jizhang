// 方案 A：原生持久化回执 + 账本原子提交 + 批次快照 + 清理（真实 PostgreSQL + PostgREST；原生层用 Node 端的假原生层模拟，
// SHA-256 由 Node crypto 独立计算；真机行为不在这里验证）
'use strict';
const { test, expect, js, serverRestore, login, newEmail, uidOf } = require('./fixtures');
const { rec, acc, cat } = require('./protocol-cjs');

const T = '2026-10-21T20:00:00+08:00';
const addRec = (page, note, amount = 100) => js(page, `App.addRecord({ type: 'expense', amount: ${amount}, cat: 'e_food', acc: 'a_cash', to: '', date: '2026-10-21', note: ${JSON.stringify(note)} }).id`);
const syncNow = async page => { await page.evaluate(() => { window.App.cloud.sync(false); }); await page.waitForFunction(() => !window.App.cloud.busy, null, { timeout: 60000 }); return page.evaluate(() => window.App.cloud.err || ''); };
const manualOff = page => js(page, '(App.S.settings.cloudAuto = false, App.flush(), 0)');
const notes = page => js(page, 'App.S.records.map(r => r.note).sort()');
const ledger = page => js(page, 'JSON.stringify({ r: App.S.records, b: App.S.budget, g: App.S.game, e: App.S.sync.epoch, c: App.conflicts.all().length })');
// 持久化写类请求的顺序（清理在同步成功后异步执行，会列出 / 删除快照，这里不计）
const ops = (page, since = 0) => page.native.calls.filter(c => c.at >= since && c.op !== 'snapshotList' && c.op !== 'snapshotDelete').map(c => c.op);
const backupOf = ids => ({ tables: { xm_records: [rec(ids.r1, 100, '早餐'), rec(ids.r2, 250, '午饭（备份）'), rec('x9', 900, '备份里才有')], xm_accounts: [acc('a_cash')], xm_categories: [cat('e_food')] } });

// B：原生 App（假原生层），三笔账已同步；然后离线新增、修改、删除、改预算（都没同步）；另一台设备恢复了备份
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
  await js(B, 'new Promise(r => setTimeout(r, 400))');   // 等防抖保存落到「原生」正式文件
  await serverRestore(gw, email, backupOf(ids));
  return { email, B, ids, uid };
}
const shortTimeouts = page => js(page, '(Object.assign(App.durable.timeouts, { snapshotWrite: 1500, ledgerStage: 1500, ledgerCommit: 1500, perMB: 0 }), 0)');
// 「没覆盖」：内存账本、epoch、冲突箱都和同步前一样；原生正式文件里也还是旧 epoch
async function expectUntouched(B, before) {
  expect(await ledger(B)).toBe(before);
  const main = B.native.mainJSON();
  expect(main && main.sync && main.sync.epoch).not.toBe(1);
}

/* ---------- A. 原生回执 ---------- */

test('A1 正常回执：快照 → 暂存 → 提交，全部拿到严格确认后才覆盖；原生正式文件、快照、冲突箱、批次记录一致；奖励不变', async ({ openApp, gw }) => {
  const { B, ids, uid } = await setup(openApp, gw);
  const game0 = await js(B, 'App.S.game');
  const pre = await js(B, 'JSON.stringify(App.S)');
  const t0 = Date.now();
  expect(await syncNow(B)).toBe('');
  expect(ops(B, t0)).toEqual(['snapshotWrite', 'ledgerStage', 'ledgerCommit']);
  // 本机
  expect(await notes(B)).toEqual(['午饭（备份）', '备份里才有', '早餐']);
  expect(await js(B, '[App.S.sync.epoch, App.conflicts.pending().length]')).toEqual([1, 4]);
  expect(await js(B, 'App.S.game')).toEqual(game0);                                    // 金币、签到、盲盒、猫咪都没变（逐字段比较；云端 jsonb 会重排键的顺序）
  // 原生正式文件 = 内存（含冲突箱、新 epoch、批次记录）
  const main = B.native.mainJSON();
  expect(main.sync.epoch).toBe(1);
  expect(main.conflicts.filter(c => c.status === 'pending').map(c => c.key).sort()).toEqual([ids.r1, ids.r2, ids.n, 'budget'].sort());
  expect(main.safety.batches[uid + ':1']).toMatchObject({ kind: 'align', items: 4, doneAt: null });
  // 快照 = 覆盖前的账本，SHA-256 与说明一致（Node crypto 独立计算）
  const snaps = B.native.snapshots();
  expect(snaps).toHaveLength(1);
  expect(snaps[0].data).toBe(pre);
  expect(snaps[0].meta).toMatchObject({ kind: 'align', batch: uid + ':1', uid, to: 1, from: 0 });
  expect(snaps[0].meta.sha256).toBe(require('crypto').createHash('sha256').update(pre).digest('hex'));
  expect(B.native.hasNext()).toBe(false);
  expect(await js(B, "Object.keys(localStorage).filter(k => k.startsWith('xm_snap:')).length")).toBe(0);   // 原生路径不占 localStorage
});

for (const [name, fault, expectMsg] of [
  ['A2 失败回执（空间不足）', { op: 'snapshotWrite', mode: 'fail', code: 'ENOSPC' }, '手机存储空间不足'],
  ['A3 永不回执（超时）', { op: 'snapshotWrite', mode: 'never' }, '超时'],
  ['A5 回执编号错误', { op: 'snapshotWrite', mode: 'wrongId' }, '超时'],
  ['A6 字节数错误', { op: 'snapshotWrite', mode: 'badBytes' }, '不一致'],
  ['A7 SHA-256 错误', { op: 'snapshotWrite', mode: 'badSha' }, '不一致']
]) {
  test(`${name}：快照没确认 → 不暂存、不提交、不覆盖本机、不改 epoch，提示具体原因`, async ({ openApp, gw }) => {
    const { B } = await setup(openApp, gw);
    await shortTimeouts(B);
    const before = await ledger(B);
    B.native.fault(fault);
    const t0 = Date.now();
    const err = await syncNow(B);
    expect(err).toContain('没能先保存本机账本');
    expect(err).toContain(expectMsg);
    expect(ops(B, t0)).toEqual(['snapshotWrite']);
    await expectUntouched(B, before);
    if (fault.mode === 'wrongId') expect(await js(B, "App.durable.log.some(l => l.kind === 'stale-receipt')")).toBe(true);
    expect(await syncNow(B)).toBe('');                                                  // 故障消失后重试：正常完成
    expect(await js(B, '[App.S.sync.epoch, App.conflicts.pending().length]')).toEqual([1, 4]);
  });
}

test('A4 延迟回执（在超时之内）：照常完成', async ({ openApp, gw }) => {
  const { B } = await setup(openApp, gw);
  await js(B, '(App.durable.timeouts.snapshotWrite = 3000, App.durable.timeouts.perMB = 0, 0)');
  B.native.fault({ op: 'snapshotWrite', mode: 'delay', ms: 1200 });
  expect(await syncNow(B)).toBe('');
  expect(await js(B, '[App.S.sync.epoch, App.conflicts.pending().length]')).toEqual([1, 4]);
});

test('A8 超时之后才到的迟到回执：被丢弃，不会触发覆盖；之后重试正常完成，冲突项不重复', async ({ openApp, gw }) => {
  const { B } = await setup(openApp, gw);
  await shortTimeouts(B);
  const before = await ledger(B);
  B.native.fault({ op: 'snapshotWrite', mode: 'late', ms: 3000 });
  expect(await syncNow(B)).toContain('超时');
  await B.waitForTimeout(2500);                                                         // 迟到的回执到了
  expect(await js(B, "App.durable.log.some(l => l.kind === 'stale-receipt')")).toBe(true);
  await expectUntouched(B, before);
  expect(await syncNow(B)).toBe('');
  expect(await js(B, '[App.S.sync.epoch, App.conflicts.pending().length]')).toEqual([1, 4]);
});

test('A9 等回执时页面重载（App 被杀后重开）：旧回执到达新页面被丢弃；新页面按正式文件里的旧账本重新对齐', async ({ openApp, gw }) => {
  const { B } = await setup(openApp, gw);
  const before = await ledger(B);
  B.native.fault({ op: 'snapshotWrite', mode: 'hold' });
  await B.evaluate(() => { window.App.cloud.sync(false); });
  await expect.poll(() => B.native.held.length, { timeout: 15000 }).toBe(1);
  await B.reloadNative();
  expect(await B.releaseReceipts()).toBe(1);
  expect(await js(B, "App.durable.log.some(l => l.kind === 'stale-receipt')")).toBe(true);
  expect(await ledger(B)).toBe(before);                                                 // 重开后是旧账本（正式文件），没有被覆盖
  await manualOff(B);
  expect(await syncNow(B)).toBe('');
  expect(await js(B, '[App.S.sync.epoch, App.conflicts.pending().length]')).toEqual([1, 4]);
});

test('A10 没有原生能力声明 / 协议版本不同：走 localStorage 降级路径（同样要求写成功）', async ({ openApp, gw }) => {
  for (const caps of [null, { durableWrite: 2 }]) {
    const { B } = await setup(openApp, gw, { caps });
    expect(await js(B, 'App.durable.native()')).toBe(false);
    expect(await syncNow(B)).toBe('');
    expect(B.native.calls.filter(c => c.op)).toEqual([]);                               // 没有发任何原生持久化请求
    expect(await js(B, "Object.keys(localStorage).filter(k => k.startsWith('xm_snap:')).length")).toBe(1);
    expect(await js(B, '[App.S.sync.epoch, App.conflicts.pending().length]')).toEqual([1, 4]);
    await B.context().close();
  }
});

test('D3 网页版 / PWA：浏览器存储写不下快照 → 安全停止（不覆盖、不改 epoch）、提示原因和建议；腾出空间后可以重试', async ({ openApp, gw }) => {
  const { B } = await setup(openApp, gw, { caps: null });
  const before = await ledger(B);
  await js(B, `(() => { const raw = Storage.prototype.setItem; window.__full = true; Storage.prototype.setItem = function (k, v) { if (window.__full && String(k).startsWith('xm_snap:')) throw new DOMException('QuotaExceededError', 'QuotaExceededError'); return raw.call(this, k, v); }; return 0; })()`);
  const err = await syncNow(B);
  expect(err).toContain('浏览器的存储空间不够');
  expect(err).toContain('App');
  expect(await ledger(B)).toBe(before);
  // 冲突箱 / 账本提交也写不下：同样停止
  await js(B, `(() => { window.__full = false; const raw = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (window.__full2 && k === 'xiaomi_ledger_v1') throw new DOMException('QuotaExceededError', 'QuotaExceededError'); return raw.call(this, k, v); }; window.__full2 = true; return 0; })()`);
  expect(await syncNow(B)).toContain('没能保存冲突箱');
  expect(await ledger(B)).toBe(before);
  await js(B, '(window.__full2 = false, 0)');
  expect(await syncNow(B)).toBe('');
  expect(await js(B, '[App.S.sync.epoch, App.conflicts.pending().length]')).toEqual([1, 4]);
});

/* ---------- C. 账本和冲突箱 ---------- */

test('C1 暂存失败 / 提交（替换正式文件）失败：不切换内存，正式文件保持旧账本；重开后暂存文件被移走', async ({ openApp, gw }) => {
  const { B } = await setup(openApp, gw);
  const before = await ledger(B);
  B.native.fault({ op: 'ledgerStage', mode: 'fail', code: 'ENOSPC' });
  let err = await syncNow(B);
  expect(err).toContain('没能保存冲突箱');
  await expectUntouched(B, before);
  B.native.fault({ op: 'ledgerCommit', mode: 'commitFail', code: 'EACCES' });
  err = await syncNow(B);
  expect(err).toContain('没能保存冲突箱');
  await expectUntouched(B, before);
  expect(B.native.hasNext()).toBe(true);
  await B.reloadNative();
  expect(B.native.hasNext()).toBe(false);
  expect(B.native.diag.length).toBeGreaterThanOrEqual(1);
  expect(await ledger(B)).toBe(before);
  await manualOff(B);
  expect(await syncNow(B)).toBe('');
  expect(await js(B, '[App.S.sync.epoch, App.conflicts.pending().length]')).toEqual([1, 4]);
});

test('C2 暂存成功后、提交之前被杀：重开后以正式文件（旧账本）为准，重新对齐，冲突项不重复', async ({ openApp, gw }) => {
  const { B } = await setup(openApp, gw);
  const before = await ledger(B);
  B.native.fault({ op: 'ledgerStage', mode: 'hold' });
  await B.evaluate(() => { window.App.cloud.sync(false); });
  await expect.poll(() => B.native.held.length, { timeout: 15000 }).toBe(1);
  await B.reloadNative();
  expect(await ledger(B)).toBe(before);
  expect(B.native.diag.length).toBe(1);                                                 // 未完成的提交被移到诊断目录
  await manualOff(B);
  expect(await syncNow(B)).toBe('');
  expect(await js(B, '[App.S.sync.epoch, App.conflicts.pending().length]')).toEqual([1, 4]);
});

test('C3 提交已经完成、但回执丢了：① 页面还在 → 超时后不切换，正式文件写回当前内存，重试后完成；② 重开 → 读到新账本，不再对齐', async ({ openApp, gw }) => {
  // ①
  let { B } = await setup(openApp, gw);
  await shortTimeouts(B);
  const before = await ledger(B);
  B.native.fault({ op: 'ledgerCommit', mode: 'lose' });
  expect(await syncNow(B)).toContain('超时');
  expect(await ledger(B)).toBe(before);
  await js(B, 'new Promise(r => setTimeout(r, 300))');
  expect(B.native.mainJSON().sync.epoch).toBe(0);                                       // 写回了当前内存（旧账本），两边一致
  expect(await syncNow(B)).toBe('');
  expect(await js(B, '[App.S.sync.epoch, App.conflicts.pending().length]')).toEqual([1, 4]);
  await B.context().close();
  // ②
  ({ B } = await setup(openApp, gw));
  B.native.fault({ op: 'ledgerCommit', mode: 'hold' });
  await B.evaluate(() => { window.App.cloud.sync(false); });
  await expect.poll(() => B.native.held.length, { timeout: 15000 }).toBe(1);
  expect(B.native.mainJSON().sync.epoch).toBe(1);                                       // 原子替换已经完成
  await B.reloadNative();
  await B.releaseReceipts();                                                            // 旧回执：丢弃
  expect(await js(B, '[App.S.sync.epoch, App.conflicts.pending().length]')).toEqual([1, 4]);
  expect(await notes(B)).toEqual(['午饭（备份）', '备份里才有', '早餐']);
  await manualOff(B);
  const t0 = Date.now();
  expect(await syncNow(B)).toBe('');
  expect(ops(B, t0)).toEqual([]);                                                       // 不再对齐（没有新的快照 / 提交）
  expect(await js(B, 'App.conflicts.pending().length')).toBe(4);
});

test('C4 等提交回执期间用户又记了一笔：不切换内存（这笔不会丢），重新对齐，这笔进冲突箱', async ({ openApp, gw }) => {
  const { B, uid } = await setup(openApp, gw);
  B.native.fault({ op: 'ledgerCommit', mode: 'delay', ms: 1500 });
  await B.evaluate(() => { window.App.cloud.sync(false); });
  await expect.poll(() => B.native.calls.some(c => c.op === 'ledgerCommit'), { timeout: 15000 }).toBe(true);
  const mid = await addRec(B, '等回执时记的', 555);
  await B.waitForFunction(() => !window.App.cloud.busy, null, { timeout: 30000 });
  if (await js(B, 'App.S.sync.epoch') !== 1) expect(await syncNow(B)).toBe('');
  expect(await js(B, `App.conflicts.pending().filter(c => c.key === ${JSON.stringify(mid)}).length`)).toBe(1);
  expect(await js(B, `App.S.records.some(r => r.id === ${JSON.stringify(mid)})`)).toBe(false);
  expect(gw.db.rows('xm_records', uid, `id = '${mid}'`)).toEqual([]);
  expect(await js(B, 'App.conflicts.pending().length')).toBe(5);
});

test('C7 等回执时退出登录（或密码锁重置）：这次对齐取消，不会把上一个账号的云端数据写进已经退出的本机', async ({ openApp, gw }) => {
  const { B } = await setup(openApp, gw);
  B.native.fault({ op: 'snapshotWrite', mode: 'hold' });
  await B.evaluate(() => { window.App.cloud.sync(false); });
  await expect.poll(() => B.native.held.length, { timeout: 15000 }).toBe(1);
  // 与「忘记密码 → 清空并重置」相同：立即退出登录并清空本机账本
  await js(B, '(App.supabase.signOutNow(), App.replaceState(null), 0)');
  await B.releaseReceipts();
  await B.waitForFunction(() => !window.App.cloud.busy, null, { timeout: 30000 });
  expect(await js(B, 'App.cloud.err')).toContain('已退出登录');
  expect(await js(B, '[App.S.records.length, App.conflicts.all().length, (App.S.sync && App.S.sync.uid) || ""]')).toEqual([0, 0, '']);
  await js(B, 'new Promise(r => setTimeout(r, 400))');
  const main = B.native.mainJSON();
  expect(main.records).toEqual([]);                                                     // 正式文件里也没有上一个账号的数据
  expect(B.native.calls.some(c => c.op === 'ledgerCommit')).toBe(false);
});

test('C5 多批次冲突和跨批次去重：同一本机修改不会在两个批次重复出现；protect 本身也去重', async ({ openApp, gw }) => {
  const { B, ids, uid } = await setup(openApp, gw);
  expect(await syncNow(B)).toBe('');                                                    // 批次 1：4 项
  const n = await js(B, `App.conflicts.protect(${JSON.stringify(uid + ':99')}, { src: 'rebase', from: 1, to: 99 }, App.conflicts.pending().map(c => ({ table: c.table, key: c.key, kind: c.kind, local: c.local })))`);
  expect(n).toBe(0);                                                                    // 内容完全相同：不在新批次重复生成
  expect(await js(B, 'App.conflicts.pending().length')).toBe(4);
  const n2 = await js(B, `App.conflicts.protect(${JSON.stringify(uid + ':99')}, { src: 'rebase', from: 1, to: 99 }, [{ table: 'xm_records', key: ${JSON.stringify(ids.n)}, kind: 'add', local: Object.assign({}, App.conflicts.pending().find(c => c.key === ${JSON.stringify(ids.n)}).local, { amount: 1 }) }])`);
  expect(n2).toBe(1);                                                                   // 内容不同：是另一次修改，保留
});

test('C6 大账本（4 万笔，超过 localStorage 上限）：原生快照和提交都能完成，localStorage 不再卡住对齐', async ({ openApp, gw }, info) => {
  test.setTimeout(300000);
  const email = newEmail();
  const B = await openApp({ name: 'B', time: T, cloudUrl: gw.url, durable: {} });
  await login(B, email, 'secret123', { signup: true });
  await manualOff(B);
  await js(B, "(() => { for (let i = 0; i < 40000; i++) App.S.records.push({ id: 'b' + i, type: 'expense', amount: 100 + i, cat: 'e_food', acc: 'a_cash', to: '', date: '2026-0' + (1 + i % 9) + '-1' + (i % 9), note: '批量账单第' + i + '笔', ts: 1700000000000 + i }); App.changed(); return 0; })()");
  expect(await syncNow(B)).toBe('');
  const size = await js(B, 'JSON.stringify(App.S).length');
  expect(size).toBeGreaterThan(5300000);                                                // 超过实测的 localStorage 单源上限（约 524 万字符）
  await serverRestore(gw, email, { tables: { xm_records: [rec('x1', 100, '恢复后的')], xm_accounts: [acc('a_cash')], xm_categories: [cat('e_food')] } });
  const t0 = Date.now();
  expect(await syncNow(B)).toBe('');
  const ms = Date.now() - t0;
  expect(await notes(B)).toEqual(['恢复后的']);
  expect(await js(B, 'App.S.sync.epoch')).toBe(1);
  const snap = B.native.snapshots()[0];
  expect(snap.data.length).toBe(size);
  expect(snap.meta.counts.records).toBe(40000);
  info.annotations.push({ type: 'timing', description: `4 万笔账本（${(size / 1e6).toFixed(1)}M 字符）对齐用时 ${ms}ms` });
  console.log(`[大账本] 4 万笔账本（${(size / 1e6).toFixed(1)}M 字符）对齐用时 ${ms}ms`);
});

/* ---------- 批次保留与清理（D4） ---------- */

test('H 清理规则：有待处理冲突 / 处理完不满 30 天 / 被恢复任务引用 / 校验失败 / 不是当前账号 一律保留；满 30 天才删；幂等；删除失败不影响使用', async ({ openApp, gw }) => {
  const { B, uid } = await setup(openApp, gw);
  expect(await syncNow(B)).toBe('');
  const batch = uid + ':1', dir = await js(B, `App.S.safety.batches[${JSON.stringify(batch)}].dir`);
  const gc = () => js(B, 'App.safety.housekeep(true)');
  let r = await gc();
  expect(r.deleted).toEqual([]);
  expect(r.kept.find(k => k.dir === dir).why).toContain('待处理');
  await js(B, "(App.conflicts.pending().forEach(c => App.conflicts.resolve(c.id, 'discard')), 0)");
  expect(await js(B, `typeof App.S.safety.batches[${JSON.stringify(batch)}].doneAt`)).toBe('number');
  r = await gc();
  expect(r.kept.find(k => k.dir === dir).why).toContain('30 天');
  // 状态不确定（批次没有完成时间，但冲突箱里也没有待处理项、也没被引用）：保留，不能把「冲突箱为空」当成可删
  const done = await js(B, `App.S.safety.batches[${JSON.stringify(batch)}].doneAt`);
  await js(B, `(App.S.safety.batches[${JSON.stringify(batch)}].doneAt = null, 0)`);
  r = await gc();
  expect(r.deleted).toEqual([]);
  expect(r.kept.find(k => k.dir === dir).why).toContain('状态不确定');
  await js(B, `(App.S.safety.batches[${JSON.stringify(batch)}].doneAt = ${done}, 0)`);
  await js(B, `(App.S.safety.batches[${JSON.stringify(batch)}].doneAt = Date.now() - 31 * 864e5, 0)`);
  // 被恢复任务引用：保留
  await js(B, `(window.__job = App.restore.job, App.restore.job = () => ({ phase: 'applied', uid: ${JSON.stringify(uid)}, result: { epoch: 1 } }), 0)`);
  r = await gc();
  expect(r.kept.find(k => k.dir === dir).why).toContain('恢复任务');
  await js(B, '(App.restore.job = window.__job, 0)');
  // 另放两份：校验失败的、别的账号的 → 保留
  const { SNAP, sha } = require('../support/fake-native');
  const put = (d, data, meta) => { B.native.files.set(SNAP + d + '/晓米记账-对齐前备份.json', Buffer.from(data)); B.native.files.set(SNAP + d + '/晓米记账-对齐前备份.meta.json', Buffer.from(JSON.stringify(meta))); };
  put('e7-bad', '{"x":1}', { uid, batch: uid + ':7', bytes: 7, sha256: '0'.repeat(64) });
  put('e8-other', '{"x":1}', { uid: 'someone-else', batch: 'someone-else:8', bytes: 7, sha256: sha(Buffer.from('{"x":1}')) });
  // 删除失败：报告失败、不抛错
  B.native.fault({ op: 'snapshotDelete', mode: 'deleteFail' });
  r = await gc();
  expect(r.failed.map(f => f.dir)).toEqual([dir]);
  expect(await js(B, "App.safety.log.some(l => l.kind === 'gc-failed')")).toBe(true);
  r = await gc();
  expect(r.deleted).toEqual([dir]);
  expect(r.kept.map(k => k.dir).sort()).toEqual(['e7-bad', 'e8-other']);
  expect(B.native.snapshots().map(s => s.dir).sort()).toEqual(['e7-bad', 'e8-other']);
  r = await gc();                                                                       // 幂等
  expect(r.deleted).toEqual([]);
  expect(r.failed).toEqual([]);
  expect(await addRec(B, '清理后照常记账')).toBeTruthy();
});

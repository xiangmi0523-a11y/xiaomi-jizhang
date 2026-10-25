// Phase 2B-1：cloud.js 接入账本版本号（真实 PostgreSQL + PostgREST）
'use strict';
const { test, expect, js, serverRestore, login, newEmail, uidOf, dismissCards } = require('./fixtures');
const { rec, acc, cat } = require('./protocol-cjs');

const T = '2026-10-21T20:00:00+08:00';
const add = (page, note, amount = 100) => js(page, `(App.addRecord({ type: 'expense', amount: ${amount}, cat: 'e_food', acc: 'a_cash', to: '', date: '2026-10-21', note: ${JSON.stringify(note)} }), 0)`);
const syncNow = async page => { await page.evaluate(() => { window.App.cloud.sync(false); }); await page.waitForFunction(() => !window.App.cloud.busy); return page.evaluate(() => window.App.cloud.err || ''); };
const BK = ids => ({ tables: { xm_records: ids.map(i => rec(i, 100, '备份' + i)), xm_accounts: [acc('a_cash')], xm_categories: [cat('e_food')] } });

test('未执行迁移的服务器：新版照常同步，不发 x-xm-epoch，读不到 xm_meta 也不报错', async ({ openApp, gwBase }) => {
  const page = await openApp({ time: T, cloudUrl: gwBase.url });
  const email = newEmail();
  await add(page, '迁移前');
  await login(page, email, 'secret123', { signup: true });
  expect(await js(page, '[App.cloud.err, App.cloud.proto]')).toEqual(['', false]);
  const uid = uidOf(gwBase, email);
  expect(gwBase.db.live(uid)).toHaveLength(1);
  const writes = gwBase.writes(uid);
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.filter(w => w.epoch !== undefined)).toEqual([]);
});

test('已迁移、从没恢复过（epoch 0）：所有写请求都带 x-xm-epoch: 0，数据正常上云', async ({ openApp, gw }) => {
  const page = await openApp({ time: T, cloudUrl: gw.url });
  const email = newEmail();
  await add(page, 'A1');
  await login(page, email, 'secret123', { signup: true });
  const uid = uidOf(gw, email);
  await add(page, 'A2');
  await js(page, `(App.deleteRecord(App.S.records.find(r => r.note === 'A1').id), 0)`);
  expect(await syncNow(page)).toBe('');
  const writes = gw.writes(uid);
  expect(writes.map(w => w.method).sort().filter((v, i, a) => a.indexOf(v) === i)).toEqual(['PATCH', 'POST']);   // 新增 / 更新 / 软删除都覆盖到
  expect(writes.filter(w => w.epoch !== '0')).toEqual([]);
  expect(gw.db.live(uid).length).toBe(1);
  expect(gw.db.rows('xm_records', uid).every(r => r.epoch === 0)).toBe(true);
});

test('写入时账本恰好被另一台设备恢复（409）：立即停止写入、重读版本号，不会无限重试', async ({ openApp, gw }) => {
  const page = await openApp({ time: T, cloudUrl: gw.url });
  const email = newEmail();
  await login(page, email, 'secret123', { signup: true });
  const uid = uidOf(gw, email);
  let fired = false, t0 = 0;
  gw.before = async e => {
    if (!fired && e.uid === uid && e.method !== 'GET' && e.path.startsWith('/rest/v1/xm_')) { fired = true; t0 = Date.now(); await serverRestore(gw, email, BK(['x1'])); }
  };
  await add(page, '恢复时正在记的');
  await page.evaluate(() => { window.App.cloud.sync(false); });
  await expect.poll(() => fired).toBe(true);
  await page.waitForTimeout(8000);   // 观察 8 秒：自动同步、补跑都算上
  const writes = gw.writes(uid, t0);
  expect(writes.length).toBe(1);
  expect(writes[0].status).toBe(409);
  expect(gw.log.some(l => l.uid === uid && l.t > writes[0].t && l.path === '/rest/v1/xm_meta')).toBe(true);
  expect(gw.db.live(uid)).toEqual(['x1']);
  // 2B-2 起：发现 epoch 变化会先把本机未同步的修改放进冲突箱，再与云端对齐；这笔账不会丢，原始内容完整保留、等用户处理
  await page.waitForFunction(() => window.App.S.sync.epoch === 1 && !window.App.cloud.busy);
  expect(await js(page, 'App.conflicts.pending().filter(c => c.table === "xm_records" && c.kind === "add" && c.local && c.local.note === "恢复时正在记的").length')).toBe(1);
  expect(await js(page, 'App.S.records.map(r => r.note)')).toEqual(['备份x1']);
});

test('版本号请求头没送到服务器（409 但版本号没变）：暂停自动同步、提示明确；只有手动同步才再试一次', async ({ openApp, gw }) => {
  const email = newEmail();
  gw.createUser(email, 'secret123');
  await serverRestore(gw, email, BK(['x1']));   // 账号已经恢复过（epoch 1）
  const uid = uidOf(gw, email);
  const page = await openApp({ time: T, cloudUrl: gw.url });
  await login(page, email);
  expect(await js(page, '[App.cloud.err, App.S.sync.epoch]')).toEqual(['', 1]);   // 新设备直接采用云端版本号
  gw.stripEpoch = true;
  const t0 = Date.now();
  await add(page, '请求头被去掉');
  await page.waitForFunction(() => window.App.cloud.halted);
  await add(page, '又记一笔');
  await page.waitForTimeout(8000);
  expect(gw.writes(uid, t0).length).toBe(1);
  expect(await js(page, 'App.cloud.err')).toContain('已暂停自动同步');
  await js(page, '(App.A.openCloud(), 0)');
  await page.click('[data-cl="sync"]');
  await page.waitForFunction(() => !window.App.cloud.busy);
  expect(gw.writes(uid, t0).length).toBe(2);
  gw.stripEpoch = false;
  await page.click('[data-cl="sync"]');
  await page.waitForFunction(() => !window.App.cloud.busy && !window.App.cloud.halted);
  expect(gw.db.live(uid)).toEqual(['x1'].concat(await js(page, 'App.S.records.filter(r => r.note !== "备份x1").map(r => r.id)')).sort());
});

test('旧版 App（main 上的前端）：恢复前照常同步；恢复后写入被拒、提示「请更新」，不会陷入无限重试', async ({ openApp, gw, oldBaseURL }) => {
  const page = await openApp({ time: T, cloudUrl: gw.url, baseURL: oldBaseURL });
  expect(await js(page, 'typeof App.cloud.checkEpoch')).toBe('undefined');   // 确认是旧版代码
  const email = newEmail();
  await add(page, '旧版记的');
  await login(page, email, 'secret123', { signup: true });
  const uid = uidOf(gw, email);
  expect(gw.db.live(uid)).toHaveLength(1);
  await serverRestore(gw, email, BK(['x1']));
  const t0 = Date.now();
  await add(page, '恢复后旧版又记一笔');
  await expect.poll(() => js(page, 'App.cloud.err'), { timeout: 15000 }).toContain('请把晓米记账更新到最新版');
  await page.waitForTimeout(12000);
  const writes = gw.writes(uid, t0);
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.length).toBeLessThanOrEqual(3);
  expect(writes.every(w => w.status === 409)).toBe(true);
  expect(gw.db.live(uid)).toEqual(['x1']);
});

test('暂停自动同步后换了账号：在登录页登录新账号（自动同步），不受上一个账号的暂停状态影响', async ({ openApp, gw }) => {
  const a = newEmail(), b = newEmail();
  gw.createUser(a, 'secret123'); gw.createUser(b, 'secret123');
  await serverRestore(gw, a, BK(['x1']));
  const page = await openApp({ time: T, cloudUrl: gw.url, forceGate: true });
  const gateLogin = async email => {
    await expect(page.locator('#auth-gate')).toBeVisible();
    await page.fill('#ag-email', email); await page.fill('#ag-pw', 'secret123'); await page.click('[data-ag="go"]');
    await expect(page.locator('#auth-gate')).toHaveCount(0, { timeout: 10000 });
    await page.waitForFunction(() => !window.App.cloud.busy && (window.App.cloud.last || window.App.cloud.err || window.App.cloud.halted));
  };
  await gateLogin(a);
  gw.stripEpoch = true;
  await add(page, '让 A 暂停');
  await page.waitForFunction(() => window.App.cloud.halted, null, { timeout: 15000 });
  gw.stripEpoch = false;
  await js(page, '(App.supabase.signOutNow(), App.replaceState(null), App.authGate.show(), 0)');   // 与退出登录后的状态一致
  const t0 = Date.now();
  await gateLogin(b);
  await page.waitForFunction(() => window.App.S.sync && window.App.S.sync.at, null, { timeout: 10000 });
  expect(await js(page, '[App.cloud.halted, App.cloud.err]')).toEqual(['', '']);
  expect(gw.log.some(l => l.uid === uidOf(gw, b) && l.t >= t0 && l.path === '/rest/v1/xm_meta')).toBe(true);
});

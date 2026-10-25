// 登录与云同步：全部走测试进程里的内存版假 Supabase（tests/support/mock-supabase.js），
// 不连接真实 Supabase，不读写任何真实用户数据。每个测试一个全新的假云端。
'use strict';
const { test, expect, js, loginViaSheet, syncNow, dismissCards, settle, MOCK_ORIGIN } = require('../support/fixtures');

const T = '2026-10-21T20:00:00+08:00';
const EMAIL = 'tester@example.test', PW = 'secret123';
const add = (page, o) => js(page, `(App.addRecord(Object.assign({ type: 'expense', amount: 100, cat: 'e_food', acc: 'a_cash', to: '', date: '2026-10-21', note: '' }, arg)), 0)`, o);
const notes = page => js(page, `App.S.records.map(r => r.note).sort()`);

test('请求头：apikey 每次都带；数据接口用用户自己的 access_token，不把 publishable key 当令牌', async ({ openApp, cloud }) => {
  const page = await openApp({ time: T });
  await add(page, { note: 'A1' });
  await loginViaSheet(page, EMAIL, PW, { signup: true });
  expect(cloud.log.length).toBeGreaterThan(5);
  expect(cloud.log.filter(l => !l.apikey)).toEqual([]);
  expect(cloud.log.filter(l => /^Bearer sb_/.test(l.auth))).toEqual([]);
  const rest = cloud.log.filter(l => l.path.startsWith('/rest/'));
  expect(rest.length).toBeGreaterThan(0);
  expect(rest.every(l => l.auth.startsWith('Bearer tok_'))).toBe(true);
});

test('注册后第一次同步：本机账本全部上传，云端行都属于这个用户', async ({ openApp, cloud }) => {
  const page = await openApp({ time: T });
  await add(page, { note: 'A1', amount: 1850 });
  await add(page, { note: 'A2', amount: 99 });
  await loginViaSheet(page, EMAIL, PW, { signup: true });
  const uid = cloud.uidOf(EMAIL);
  expect(await js(page, 'App.supabase.user().id')).toBe(uid);
  const recs = cloud.rows('xm_records', uid);
  expect(recs.map(r => [r.note, r.amount, r.deleted]).sort()).toEqual([['A1', 1850, false], ['A2', 99, false]]);
  expect(cloud.rows('xm_accounts', uid)).toHaveLength(5);
  expect(cloud.rows('xm_categories', uid)).toHaveLength(34);
  expect(cloud.rows('xm_state', uid)).toHaveLength(1);
  expect(cloud.rows('xm_state', uid)[0].data.game.coins).toBe(100);
});

test('第二台设备登录同一账号：拉下同样的账单；双向修改、删除都能同步', async ({ openApp, cloud }) => {
  const A = await openApp({ name: 'A', time: T });
  await add(A, { note: 'A1' });
  await loginViaSheet(A, EMAIL, PW, { signup: true });
  const B = await openApp({ name: 'B', time: T });
  await loginViaSheet(B, EMAIL, PW);
  expect(await notes(B)).toEqual(['A1']);

  await add(B, { note: 'B1', amount: 8800, type: 'income', cat: 'i_red' });
  await js(B, `(App.S.records.find(r => r.note === 'A1').amount = 4500, App.changed(), 0)`);
  expect(await syncNow(B)).toBe('');
  expect(await syncNow(A)).toBe('');
  expect(await notes(A)).toEqual(['A1', 'B1']);
  expect(await js(A, `App.S.records.find(r => r.note === 'A1').amount`)).toBe(4500);

  await js(A, `(App.deleteRecord(App.S.records.find(r => r.note === 'B1').id), 0)`);
  expect(await syncNow(A)).toBe('');
  expect(cloud.rows('xm_records').find(r => r.note === 'B1').deleted).toBe(true);
  expect(await syncNow(B)).toBe('');
  expect(await notes(B)).toEqual(['A1']);
});

test('没有改动时再同步：不上传任何东西', async ({ openApp }) => {
  const page = await openApp({ time: T });
  await loginViaSheet(page, EMAIL, PW, { signup: true });
  expect(await syncNow(page)).toBe('');
  expect(await js(page, 'App.cloud.last')).toEqual({ up: 0, down: 0, del: 0 });
});

test('数据隔离：另一个账号看不到别人的账单（模拟 RLS）', async ({ openApp, cloud }) => {
  const A = await openApp({ name: 'A', time: T });
  await add(A, { note: '我的私房钱' });
  await loginViaSheet(A, EMAIL, PW, { signup: true });
  const C = await openApp({ name: 'C', time: T });
  await loginViaSheet(C, 'other@example.test', 'pass456', { signup: true });
  expect(await notes(C)).toEqual([]);
  expect(await js(C, `App.supabase.select('xm_records', 'select=id,note')`)).toEqual([]);
  // 直接伪造 user_id 写别人的行会被拒绝
  const err = await js(C, `App.supabase.upsert('xm_records', [{ user_id: arg, id: 'evil', type: 'expense', amount: 1, date: '2026-10-21' }], 'user_id,id').then(() => 'ok', e => e.status)`, cloud.uidOf(EMAIL));
  expect(err).toBe(403);
  expect(cloud.rows('xm_records').some(r => r.id === 'evil')).toBe(false);
});

test('登录失败提示：密码错误 / 邮箱已注册 / 密码太短', async ({ openApp, cloud }) => {
  cloud.createUser(EMAIL, PW);
  const page = await openApp({ time: T });
  await settle(page);
  await js(page, '(App.A.openCloud(), 0)');
  await page.fill('#cl-email', EMAIL);
  await page.fill('#cl-pass', 'wrongpass');
  await page.click('[data-cl="in"]');
  await expect(page.locator('#toast')).toContainText('邮箱或密码不对');
  await page.fill('#cl-pass', 'another1');
  await page.click('[data-cl="up"]');
  await expect(page.locator('#toast')).toContainText('已经注册过了');
  await page.fill('#cl-pass', '123');
  await page.click('[data-cl="in"]');
  await expect(page.locator('#toast')).toContainText('密码至少 6 位');
  expect(await js(page, '!!App.supabase.user()')).toBe(false);
});

test('access_token 过期：自动用 refresh_token 换新令牌，同步成功、仍保持登录', async ({ openApp, cloud }) => {
  const page = await openApp({ time: T });
  await loginViaSheet(page, EMAIL, PW, { signup: true });
  cloud.revokeAllTokens();   // 服务器端令牌全部失效（相当于过期）
  await add(page, { note: '过期后新增' });
  expect(await syncNow(page)).toBe('');
  expect(await js(page, '!!App.supabase.user()')).toBe(true);
  expect(cloud.rows('xm_records').map(r => r.note)).toContain('过期后新增');
  expect(cloud.log.some(l => l.path === '/auth/v1/token' && l.status === 200)).toBe(true);
});

test('有改动约 5 秒后自动同步', async ({ openApp, cloud }) => {
  const page = await openApp({ time: T });
  await loginViaSheet(page, EMAIL, PW, { signup: true });
  await add(page, { note: '自动同步' });
  await expect.poll(() => cloud.rows('xm_records').map(r => r.note), { timeout: 12000 }).toContain('自动同步');
});

test('断网时同步失败会记录错误，不丢本地数据；恢复网络后再同步成功', async ({ openApp, cloud }) => {
  const page = await openApp({ time: T, });
  await loginViaSheet(page, EMAIL, PW, { signup: true });
  cloud.offline = true;
  await add(page, { note: '离线记的' });
  expect(await syncNow(page)).not.toBe('');
  expect(await notes(page)).toEqual(['离线记的']);
  cloud.offline = false;
  expect(await syncNow(page)).toBe('');
  expect(cloud.rows('xm_records').map(r => r.note)).toContain('离线记的');
});

test('线上登录门：登录页注册 → 进入主界面并完成首次同步', async ({ openApp, cloud }) => {
  const page = await openApp({ time: T, forceGate: true });
  await expect(page.locator('#auth-gate')).toBeVisible();
  await page.click('[data-ag="mode"][data-v="up"]');
  await page.fill('#ag-email', EMAIL);
  await page.fill('#ag-pw', PW);
  await page.fill('#ag-pw2', PW);
  await page.click('[data-ag="go"]');
  await expect(page.locator('#auth-gate')).toHaveCount(0, { timeout: 10000 });
  await page.waitForFunction(() => window.App.S.sync && window.App.S.sync.at);
  expect(cloud.rows('xm_state', cloud.uidOf(EMAIL))).toHaveLength(1);
});

test('线上登录门：退出登录会先同步，再清空本机账本并回到登录页；云端数据还在', async ({ openApp, cloud }) => {
  const page = await openApp({ time: T, forceGate: true });
  await page.fill('#ag-email', EMAIL);
  cloud.createUser(EMAIL, PW);
  await page.fill('#ag-pw', PW);
  await page.click('[data-ag="go"]');
  await expect(page.locator('#auth-gate')).toHaveCount(0, { timeout: 10000 });
  await page.waitForFunction(() => window.App.S.sync && window.App.S.sync.at);
  await add(page, { note: '退出前记的' });
  await dismissCards(page);
  await js(page, '(App.A.logout(), 0)');
  await page.click('.dlg [data-r="1"]');
  await expect(page.locator('#auth-gate')).toBeVisible({ timeout: 10000 });
  expect(await js(page, '[!!App.supabase.user(), App.S.records.length]')).toEqual([false, 0]);
  expect(cloud.rows('xm_records', cloud.uidOf(EMAIL)).map(r => r.note)).toEqual(['退出前记的']);
});

test('换账号登录：本机账本属于另一个账号时先清空，不把它并进新账号', async ({ openApp, cloud }) => {
  const first = cloud.createUser('first@example.test', PW);
  cloud.createUser('second@example.test', PW);
  const page = await openApp({ time: T, forceGate: true });
  // 本机还留着上一个账号（first）的账本和同步记录，但登录态已失效
  await js(page, `(App.S.records.push({ id: 'old', type: 'expense', amount: 1, date: '2026-10-21', acc: 'a_cash', cat: 'e_food', note: '旧账号残留', ts: 1 }), App.S.sync = { uid: arg, t: {}, at: 1 }, App.flush(), 0)`, first);
  await page.fill('#ag-email', 'second@example.test');
  await page.fill('#ag-pw', PW);
  await page.click('[data-ag="go"]');
  await expect(page.locator('#auth-gate')).toHaveCount(0, { timeout: 10000 });
  await page.waitForFunction(() => window.App.S.sync && window.App.S.sync.at);
  expect(await notes(page)).toEqual([]);
  expect(cloud.rows('xm_records', cloud.uidOf('second@example.test'))).toEqual([]);
});

test('原生 App 模式：网络请求经由原生桥（http 消息）发出，也能完成同步', async ({ openApp, cloud }) => {
  const page = await openApp({ time: T, native: true });
  await add(page, { note: '原生桥' });
  await loginViaSheet(page, EMAIL, PW, { signup: true });
  expect(await js(page, `window._msgs.filter(m => m.type === 'http').length`)).toBeGreaterThan(5);
  expect(await js(page, `window._msgs.filter(m => m.type === 'http').every(m => m.url.startsWith(arg))`, MOCK_ORIGIN)).toBe(true);
  expect(cloud.rows('xm_records').map(r => r.note)).toEqual(['原生桥']);
});

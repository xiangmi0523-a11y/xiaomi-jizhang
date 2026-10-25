// 已知缺陷 H1–H4（来自架构审计报告）
// H4 已在 fix/H4-password-reset 修复，对应测试已改成正式断言；H1–H3 仍未修复。
//
// 写法：先正常执行准备步骤和前置检查（这些步骤出错，测试会真的失败）；
// 走到最后一步时调用 test.fail() 声明「下面这条正确行为的断言目前预期会失败」，再按「修好之后应有的正确行为」断言。
//   - 缺陷还在：最后的断言失败 → 报告里这条显示为「预期内失败」（通过）
//   - 缺陷修好：最后的断言通过 → Playwright 会报「本应失败却通过」→ 提醒去掉这里的 test.fail()，让它变成正式回归测试
// 全部在假 Supabase 上运行，不碰真实数据。
'use strict';
const { test, expect, js, loginViaSheet, syncNow, dismissCards, ready } = require('../support/fixtures');

const EMAIL = 'bug@example.test', PW = 'secret123';
const D1 = '2026-10-20T09:00:00+08:00', D2 = '2026-10-21T09:00:00+08:00';

// 关掉自动同步，让每次同步都由测试显式触发，结果可复现
const manualSync = page => js(page, `(App.S.settings.cloudAuto = false, App.flush(), 0)`);
const reopenAt = async (page, time) => {
  await page.clock.setFixedTime(new Date(time));
  await page.reload();
  await ready(page);
  await dismissCards(page);
};

test('已知缺陷 H1：两台设备各自打开 App 时都会补记同一天的周期账单，同步后出现重复', async ({ openApp }) => {
  const A = await openApp({ name: 'A', time: D1 });
  await loginViaSheet(A, EMAIL, PW, { signup: true });
  await manualSync(A);
  await js(A, `(App.S.recurring.push({ id: 'p_daily', enabled: true, last: '', type: 'expense', amount: 1500, cat: 'e_food', acc: 'a_cash', freq: 'daily', start: '2026-10-20', note: '早餐' }), App.runRecurring(), App.changed(), 0)`);
  expect(await syncNow(A)).toBe('');
  const B = await openApp({ name: 'B', time: D1 });
  await loginViaSheet(B, EMAIL, PW);
  await manualSync(B);
  // 前置检查：第一天两台设备一致，各 1 笔
  expect(await js(A, `App.S.records.filter(r => r.rec === 'p_daily').length`)).toBe(1);
  expect(await js(B, `App.S.records.filter(r => r.rec === 'p_daily').length`)).toBe(1);

  // 第二天：A、B 各打开一次（打开时先补记周期账单，再同步）
  await reopenAt(A, D2); expect(await syncNow(A)).toBe('');
  await reopenAt(B, D2); expect(await syncNow(B)).toBe('');
  expect(await syncNow(A)).toBe('');
  const dates = await js(A, `App.S.records.filter(r => r.rec === 'p_daily').map(r => r.date).sort()`);
  expect(dates.length).toBeGreaterThanOrEqual(2);

  test.fail(true, 'H1 未修复：同一天的周期账单会被两台设备各记一次');
  expect(dates).toEqual(['2026-10-20', '2026-10-21']);
});

test('已知缺陷 H2：两台设备同时改金币等整体设置，后同步的一台会覆盖前一台', async ({ openApp }) => {
  const A = await openApp({ name: 'A', time: D2 });
  await loginViaSheet(A, EMAIL, PW, { signup: true });
  await manualSync(A); expect(await syncNow(A)).toBe('');
  const B = await openApp({ name: 'B', time: D2 });
  await loginViaSheet(B, EMAIL, PW);
  await manualSync(B);
  const base = await js(A, `App.S.game.coins`);
  expect(await js(B, `App.S.game.coins`)).toBe(base);

  await js(A, `(App.S.game.coins += 7, App.changed(), 0)`);
  await js(B, `(App.S.game.coins += 11, App.changed(), 0)`);
  expect(await syncNow(A)).toBe('');
  expect(await syncNow(B)).toBe('');
  expect(await syncNow(A)).toBe('');
  const got = [await js(A, `App.S.game.coins`), await js(B, `App.S.game.coins`)];

  test.fail(true, 'H2 未修复：xm_state 整块「最后写入者覆盖」，一台设备的金币改动丢失');
  expect(got).toEqual([base + 18, base + 18]);
});

test('已知缺陷 H3：登录状态下导入旧备份，同步又把备份之后的新账单合并回来', async ({ openApp }) => {
  const A = await openApp({ name: 'A', time: D2 });
  await loginViaSheet(A, EMAIL, PW, { signup: true });
  await manualSync(A);
  const backup = await js(A, `JSON.stringify(App.S)`);
  await js(A, `(App.addRecord({ type: 'expense', amount: 999, cat: 'e_snack', acc: 'a_cash', to: '', date: '2026-10-21', note: '导出后新增' }), 0)`);
  expect(await syncNow(A)).toBe('');
  await js(A, `(App.replaceState(JSON.parse(arg)), 0)`, backup);   // 与「数据与备份 → 导入备份 → 覆盖导入」相同的调用
  expect(await js(A, `App.S.records.some(r => r.note === '导出后新增')`)).toBe(false);   // 刚导入时确实回到了备份
  expect(await syncNow(A)).toBe('');
  const back = await js(A, `App.S.records.some(r => r.note === '导出后新增')`);

  test.fail(true, 'H3 未修复：导入的备份在同步后被云端数据合并覆盖');
  expect(back).toBe(false);
});

test('H4（已修复）：密码锁「忘记密码 → 清空并重置」会退出云端登录，同步不会把账本拉回来', async ({ openApp, cloud }) => {
  const A = await openApp({ name: 'A', time: D2 });
  await js(A, `(App.addRecord({ type: 'expense', amount: 5000, cat: 'e_food', acc: 'a_cash', to: '', date: '2026-10-21', note: '私密账单' }), 0)`);
  await loginViaSheet(A, EMAIL, PW, { signup: true });
  await manualSync(A);
  expect(cloud.rows('xm_records', cloud.uidOf(EMAIL)).map(r => r.note)).toEqual(['私密账单']);   // 前置：云端确实有这笔
  await js(A, `(App.S.settings.pin = App.U.hash('xm:1234'), App.flush(), App.lockNow(), 0)`);
  await expect(A.locator('#lock')).toBeVisible();
  // 不知道密码的人：点「忘记密码？」→「清空数据并重置」
  await A.click('#lock [data-lk="forgot"]');
  await A.click('#lock [data-lk="reset"]');
  await expect(A.locator('#lock')).toBeHidden();
  // 本机登录态立即清除（内存 + localStorage 里的 xm_supabase_session）
  expect(await js(A, `[!!App.supabase.user(), localStorage.getItem('xm_supabase_session')]`)).toEqual([false, null]);
  expect(await js(A, `App.S.records.length`)).toBe(0);
  // 服务器端令牌也被作废
  await expect.poll(() => cloud.log.some(l => l.path === '/auth/v1/logout' && l.status === 204)).toBe(true);
  // 再同步、再重开 App：都不会把云端账本拉回来
  expect(await syncNow(A)).toBe('');
  const after = await js(A, `({ loggedIn: !!App.supabase.user(), records: App.S.records.length, pin: App.S.settings.pin })`);
  expect(after).toEqual({ loggedIn: false, records: 0, pin: '' });
  await reopenAt(A, D2);
  await A.waitForTimeout(4000);   // 跨过启动后 3.5 秒的自动同步
  expect(await js(A, `[!!App.supabase.user(), App.S.records.length]`)).toEqual([false, 0]);
  // 云端数据本身还在：用户本人重新登录可以找回
  expect(cloud.rows('xm_records', cloud.uidOf(EMAIL)).map(r => [r.note, r.deleted])).toEqual([['私密账单', false]]);
});

test('H4（已修复）：重置时正好有一次同步在进行，拉下来的云端数据也不会写回本机；线上模式回到登录页', async ({ openApp, cloud }) => {
  cloud.createUser(EMAIL, PW);
  const A = await openApp({ name: 'A', time: D2, forceGate: true });
  await A.fill('#ag-email', EMAIL);
  await A.fill('#ag-pw', PW);
  await A.click('[data-ag="go"]');
  await expect(A.locator('#auth-gate')).toHaveCount(0, { timeout: 10000 });
  await A.waitForFunction(() => window.App.S.sync && window.App.S.sync.at);
  await manualSync(A);
  await js(A, `(App.addRecord({ type: 'expense', amount: 5000, cat: 'e_food', acc: 'a_cash', to: '', date: '2026-10-21', note: '私密账单' }), 0)`);
  expect(await syncNow(A)).toBe('');
  // 模拟「这台手机本机还没有这笔、正要从云端拉下来」：清掉本机账单和同步记录，下次同步会把云端全部重新拉一遍
  await js(A, `(App.S.settings.pin = App.U.hash('xm:1234'), App.S.records = [], App.S.sync = null, App.flush(), 0)`);
  // 让假云端每个请求慢 1.5 秒，然后发起一次同步，在它还没结束时重置
  cloud.delayMs = 1500;
  await js(A, `(App.cloud.sync(false), 0)`);
  await A.waitForFunction(() => window.App.cloud.busy);
  await js(A, `(App.lockNow(), 0)`);
  await A.click('#lock [data-lk="forgot"]');
  await A.click('#lock [data-lk="reset"]');
  await A.waitForFunction(() => !window.App.cloud.busy, null, { timeout: 20000 });
  cloud.delayMs = 0;
  const after = await js(A, `({ loggedIn: !!App.supabase.user(), session: localStorage.getItem('xm_supabase_session'), records: App.S.records.length, saved: JSON.parse(localStorage.getItem('xiaomi_ledger_v1')).records.length })`);
  expect(after).toEqual({ loggedIn: false, session: null, records: 0, saved: 0 });
  await expect(A.locator('#auth-gate')).toBeVisible();
});

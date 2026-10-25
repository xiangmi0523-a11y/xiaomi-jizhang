// 周期记账（单台设备）与密码锁：在固定 / 可快进的时钟下验证，不涉及云端
'use strict';
const { test, expect, js } = require('../support/fixtures');

const plan = o => Object.assign({ id: 'p1', enabled: true, last: '', type: 'expense', amount: 1500, cat: 'e_food', acc: 'a_cash', freq: 'daily', start: '2026-10-19', note: '早餐' }, o);

test.describe('周期记账（单台设备）', () => {
  test('启动时补记从开始日到今天的每一笔，并标记来源 rec', async ({ openApp }) => {
    const page = await openApp({ time: '2026-10-21T09:00:00+08:00', seed: { recurring: [plan()] } });
    const r = await js(page, `App.S.records.filter(r => r.rec === 'p1').map(r => [r.date, r.amount, r.note]).sort()`);
    expect(r).toEqual([['2026-10-19', 1500, '早餐'], ['2026-10-20', 1500, '早餐'], ['2026-10-21', 1500, '早餐']]);
    expect(await js(page, `App.S.recurring[0].last`)).toBe('2026-10-21');
  });

  test('同一台设备再次运行（回到前台 / 重开）不会重复记账', async ({ openApp }) => {
    const page = await openApp({ time: '2026-10-21T09:00:00+08:00', seed: { recurring: [plan()] } });
    expect(await js(page, `App.runRecurring()`)).toBe(0);
    await page.reload();
    await page.waitForFunction(() => window.App && window.App.S);
    expect(await js(page, `App.S.records.filter(r => r.rec === 'p1').length`)).toBe(3);
  });

  test('第二天打开只补新的一天', async ({ openApp }) => {
    const page = await openApp({ time: '2026-10-21T09:00:00+08:00', seed: { recurring: [plan()] } });
    await page.clock.setFixedTime(new Date('2026-10-22T09:00:00+08:00'));
    expect(await js(page, `App.runRecurring()`)).toBe(1);
    expect(await js(page, `App.S.records.filter(r => r.rec === 'p1').map(r => r.date).sort().pop()`)).toBe('2026-10-22');
  });

  test('每月 31 号的周期账单：小月记在月底', async ({ openApp }) => {
    const page = await openApp({ time: '2026-12-01T09:00:00+08:00', seed: { recurring: [plan({ freq: 'monthly', start: '2026-08-31', amount: 300000, cat: 'e_rent', note: '房租' })] } });
    expect(await js(page, `App.S.records.filter(r => r.rec === 'p1').map(r => r.date).sort()`)).toEqual(['2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30']);
  });

  test('停用的周期账单不记账', async ({ openApp }) => {
    const page = await openApp({ time: '2026-10-21T09:00:00+08:00', seed: { recurring: [plan({ enabled: false })] } });
    expect(await js(page, `App.S.records.length`)).toBe(0);
  });
});

test.describe('密码锁', () => {
  const PIN_STATE = page => js(page, `(App.S.settings.pin = App.U.hash('xm:1234'), App.flush(), 0)`);
  const type = async (page, code) => { for (const c of code) await page.click(`#lock [data-v="${c}"]`); await page.clock.runFor(500); };

  test('设置了密码：启动时先显示密码锁，输对密码解锁', async ({ openApp }) => {
    const page = await openApp({ time: '2026-10-21T09:00:00+08:00', clock: 'install' });
    await PIN_STATE(page);
    await page.reload();
    await page.clock.runFor(800);
    await expect(page.locator('#lock')).toBeVisible();
    await type(page, '1234');
    await expect(page.locator('#lock')).toBeHidden();
  });

  test('连续输错 5 次锁 30 秒；期间输对也打不开；30 秒后可以解锁', async ({ openApp }) => {
    const page = await openApp({ time: '2026-10-21T09:00:00+08:00', clock: 'install' });
    await PIN_STATE(page);
    await js(page, `(App.lockNow(), 0)`);
    await page.clock.runFor(500);
    for (let i = 0; i < 5; i++) await type(page, '0000');
    await expect(page.locator('#lock .lock-msg')).toContainText('30 秒后再试');
    await type(page, '1234');
    await expect(page.locator('#lock')).toBeVisible();
    await expect(page.locator('#lock .lock-msg')).toContainText('秒后再试');
    await page.clock.runFor(31000);
    await type(page, '1234');
    await expect(page.locator('#lock')).toBeHidden();
  });

  test('切到后台时自动上锁（onBackground）', async ({ openApp }) => {
    const page = await openApp({ time: '2026-10-21T09:00:00+08:00', clock: 'install' });
    await PIN_STATE(page);
    await js(page, `(App.onBackground(), 0)`);
    await page.clock.runFor(300);
    await expect(page.locator('#lock')).toBeVisible();
  });

  test('密码不以明文保存', async ({ openApp }) => {
    const page = await openApp({ time: '2026-10-21T09:00:00+08:00' });
    await js(page, `(App.S.settings.pin = App.U.hash('xm:1234'), App.flush(), 0)`);
    const raw = await js(page, `localStorage.getItem('xiaomi_ledger_v1')`);
    expect(JSON.parse(raw).settings.pin).not.toBe('1234');
    expect(JSON.parse(raw).settings.pin).not.toBe('');
  });
});

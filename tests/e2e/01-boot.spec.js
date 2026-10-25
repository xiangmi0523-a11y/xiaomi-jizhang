// 页面启动与状态初始化
'use strict';
const { test, expect, js, KEY } = require('../support/fixtures');

const MODULES = ['U', 'UI', 'game', 'cats', 'mood', 'inn', 'budget', 'smart', 'backup', 'remind', 'savings', 'sound', 'http', 'supabase', 'cloud', 'authGate', 'pwa', 'Lock'];

test('首次打开：所有脚本按顺序加载，没有 JS 报错，底栏 5 个按钮', async ({ openApp }) => {
  const page = await openApp({ time: '2026-10-21T20:00:00+08:00' });
  const missing = await js(page, `${JSON.stringify(MODULES)}.filter(k => !window.App[k])`);
  expect(missing).toEqual([]);
  await expect(page.locator('#tabbar .tab')).toHaveCount(4);
  await expect(page.locator('#tabbar .tab-add')).toHaveCount(1);
  await expect(page.locator('#tabbar .tab.on')).toHaveAttribute('data-t', 'home');
  await expect(page.locator('#page')).not.toBeEmpty();
  // 本机调试地址（127.0.0.1，http）不拦登录门
  await expect(page.locator('#auth-gate')).toHaveCount(0);
});

test('首次打开：默认账本结构正确（金额单位为分，金币 100）', async ({ openApp }) => {
  const page = await openApp({ time: '2026-10-21T20:00:00+08:00' });
  const s = await js(page, `(() => { const S = App.S; return {
    v: S.v, records: S.records.length, accounts: S.accounts.map(a => a.id), inits: S.accounts.map(a => a.init),
    exp: S.cats.expense.length, inc: S.cats.income.length, coins: S.game.coins, signed: S.game.signed.length,
    budget: S.budget, smartOn: S.smart.on, plans: S.saving.plans.length, pin: S.settings.pin, theme: S.settings.theme, ui31: S.settings.ui31 }; })()`);
  expect(s).toEqual({
    v: 1, records: 0, accounts: ['a_cash', 'a_wx', 'a_ali', 'a_bank', 'a_credit'], inits: [0, 0, 0, 0, 0],
    exp: 26, inc: 8, coins: 100, signed: 0, budget: { total: 0, cats: {} }, smartOn: false, plans: 0, pin: '', theme: 'millet', ui31: 1
  });
});

test('启动后立即写入一次本地存储（localStorage 里能读回同样的账本）', async ({ openApp }) => {
  const page = await openApp({ time: '2026-10-21T20:00:00+08:00' });
  const saved = await js(page, `JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}))`);
  expect(saved).not.toBeNull();
  expect(saved.accounts.length).toBe(5);
  expect(saved.game.coins).toBe(100);
});

test('四个主页面都能切换并渲染，不报错', async ({ openApp }) => {
  const page = await openApp({ time: '2026-10-21T20:00:00+08:00' });
  for (const t of ['stats', 'inn', 'mine', 'home']) {
    await page.click(`#tabbar .tab[data-t="${t}"]`);
    await expect(page.locator('#tabbar .tab.on')).toHaveAttribute('data-t', t);
    expect(await js(page, 'App.tab')).toBe(t);
    await expect(page.locator('#page')).not.toBeEmpty();
  }
});

test('线上模式（强制登录门）且未登录：先显示「晓米客栈」登录页', async ({ openApp }) => {
  const page = await openApp({ time: '2026-10-21T20:00:00+08:00', forceGate: true });
  await expect(page.locator('#auth-gate')).toBeVisible();
  await expect(page.locator('#auth-gate .ag-title')).toHaveText('欢迎回到晓米客栈');
  await expect(page.locator('#ag-email')).toBeVisible();
});

test('原生 App 模式：启动时把数据交给原生层保存（save 消息）', async ({ openApp }) => {
  const page = await openApp({ time: '2026-10-21T20:00:00+08:00', native: true });
  const types = await js(page, 'window._msgs.map(m => m.type)');
  expect(types).toContain('save');
  const save = await js(page, `JSON.parse(window._msgs.filter(m => m.type === 'save').pop().data)`);
  expect(save.accounts.length).toBe(5);
});

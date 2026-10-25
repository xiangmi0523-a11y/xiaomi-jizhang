// 记账流程：通过真实界面（记账面板 + 数字键盘）新增、修改、删除账单
'use strict';
const { test, expect, js, recordViaEditor } = require('../support/fixtures');

const T = '2026-10-21T20:00:00+08:00';

test('记一笔支出：金额按分保存、日期是今天、默认账户、首页列表显示 -18.50', async ({ openApp }) => {
  const page = await openApp({ time: T });
  await recordViaEditor(page, { catId: 'e_food', keys: '18.5' });
  await expect.poll(() => js(page, 'App.S.records.length')).toBe(1);
  const r = await js(page, 'App.S.records[0]');
  expect(r).toMatchObject({ type: 'expense', amount: 1850, cat: 'e_food', acc: 'a_cash', to: '', date: '2026-10-21', note: '' });
  expect(typeof r.id).toBe('string');
  await expect(page.locator('#page .rec')).toHaveCount(1);
  await expect(page.locator('#page .rec .rec-amt')).toHaveText('-18.50');
  await expect(page.locator('#toast')).toContainText('记账成功');
});

test('记一笔收入：显示为 +，计入收入合计', async ({ openApp }) => {
  const page = await openApp({ time: T });
  await recordViaEditor(page, { type: 'income', catId: 'i_salary', keys: '5000' });
  await expect.poll(() => js(page, 'App.S.records.length')).toBe(1);
  expect(await js(page, `[App.S.records[0].type, App.S.records[0].amount, App.sum(App.S.records).income]`)).toEqual(['income', 500000, 500000]);
  await expect(page.locator('#page .rec .rec-amt')).toHaveText('+5,000.00');
});

test('键盘算式：12+3.5 先按「=」得出结果，再按「完成」保存 15.50', async ({ openApp }) => {
  const page = await openApp({ time: T });
  await page.click('.tab-add');
  await page.click('.cat[data-cat="e_snack"]');
  for (const k of ['1', '2', '+', '3', '.', '5']) await page.click(`.key[data-k="${k}"]`);
  await expect(page.locator('.key[data-k="done"]')).toHaveText('=');
  await page.click('.key[data-k="done"]');
  await expect(page.locator('.key[data-k="done"]')).toHaveText('完成');
  await page.click('.key[data-k="done"]');
  await expect.poll(() => js(page, 'App.S.records.map(r => r.amount)')).toEqual([1550]);
});

test('没选分类或金额为 0 时不保存，并给出提示', async ({ openApp }) => {
  const page = await openApp({ time: T });
  await page.click('.tab-add');
  await page.click('.key[data-k="5"]');
  await page.click('.key[data-k="done"]');
  await expect(page.locator('#toast')).toContainText('请先选择分类');
  await page.click('.cat[data-cat="e_food"]');
  await page.click('.key[data-k="del"]');
  await page.click('.key[data-k="done"]');
  await expect(page.locator('#toast')).toContainText('请输入金额');
  expect(await js(page, 'App.S.records.length')).toBe(0);
});

test('连点三次「完成」只记一笔，只奖励一次金币', async ({ openApp }) => {
  const page = await openApp({ time: T });
  await page.click('.tab-add');
  await page.click('.cat[data-cat="e_food"]');
  await page.click('.key[data-k="5"]');
  await js(page, `(() => { const d = document.querySelector('.key[data-k="done"]'); d.click(); d.click(); d.click(); return 0; })()`);
  await expect.poll(() => js(page, 'App.S.records.length')).toBe(1);
  await page.waitForTimeout(400);
  expect(await js(page, '[App.S.records.length, App.S.game.coins]')).toEqual([1, 110]);
});

test('新记一笔 +10 金币；修改这笔不再奖励；删除这笔收回 10 金币', async ({ openApp }) => {
  const page = await openApp({ time: T });
  await recordViaEditor(page, { catId: 'e_food', keys: '20' });
  await expect.poll(() => js(page, 'App.S.game.coins')).toBe(110);
  expect(await js(page, 'App.S.game.progress')).toBe(1);
  // 修改：点开这笔，把金额改成 25
  await page.click('#page .rec');
  await page.waitForSelector('.key[data-k="done"]');
  await page.click('.key[data-k="del"]');
  await page.click('.key[data-k="del"]');
  await page.click('.key[data-k="2"]');
  await page.click('.key[data-k="5"]');
  await page.click('.key[data-k="done"]');
  await expect.poll(() => js(page, 'App.S.records[0].amount')).toBe(2500);
  await expect(page.locator('#toast')).toContainText('已修改');
  expect(await js(page, '[App.S.records.length, App.S.game.coins]')).toEqual([1, 110]);
  // 删除（走 App.deleteRecord，与面板里删除按钮调用的是同一个函数）
  await js(page, `(App.deleteRecord(App.S.records[0].id), 0)`);
  expect(await js(page, '[App.S.records.length, App.S.game.coins, App.S.game.progress, App.game.refunded]')).toEqual([0, 100, 0, 10]);
});

test('每天最多奖励 20 笔记账金币', async ({ openApp }) => {
  const page = await openApp({ time: T });
  const coins = await js(page, `(() => {
    for (let i = 0; i < 22; i++) { const r = App.addRecord({ type: 'expense', amount: 100, cat: 'e_food', acc: 'a_cash', to: '', date: App.U.today(), note: '' }); App.game.rewardRecord(null, r); }
    return [App.S.game.coins, App.S.records.filter(r => r.rw).length];
  })()`);
  expect(coins).toEqual([100 + 20 * 10, 20]);
});

test('转账：两个账户余额一增一减，不计入收支', async ({ openApp }) => {
  const page = await openApp({ time: T });
  await page.click('.tab-add');
  await page.click('[data-ed="type"][data-v="transfer"]');
  for (const k of ['3', '0', '0']) await page.click(`.key[data-k="${k}"]`);
  await page.click('.key[data-k="done"]');
  await expect.poll(() => js(page, 'App.S.records.length')).toBe(1);
  const r = await js(page, `(() => { const x = App.S.records[0]; return { type: x.type, amount: x.amount, from: App.balance(x.acc), to: App.balance(x.to), same: x.acc === x.to, sum: App.sum(App.S.records) }; })()`);
  expect(r).toEqual({ type: 'transfer', amount: 30000, from: -30000, to: 30000, same: false, sum: { expense: 0, income: 0 } });
});

test('签到：当天只能领一次 50 金币，第二天可以再签', async ({ openApp }) => {
  const page = await openApp({ time: T, clock: 'install' });
  await page.click('.sign-fab');
  await page.clock.runFor(500);
  await page.click('[data-sg="sign"]');
  await page.clock.runFor(4000);
  expect(await js(page, '[App.S.game.coins, App.S.game.signed]')).toEqual([150, ['2026-10-21']]);
  await expect(page.locator('.sg-btn')).toBeDisabled();
  await page.click('[data-sg="close"]');
  await page.clock.runFor(800);
  await page.clock.fastForward('24:00:00');
  await page.clock.runFor(1000);
  expect(await js(page, 'App.U.today()')).toBe('2026-10-22');
  await page.click('.sign-fab');
  await page.clock.runFor(500);
  await page.click('[data-sg="sign"]');
  await page.clock.runFor(4000);
  expect(await js(page, '[App.S.game.coins, App.S.game.signed, App.game.streak()]')).toEqual([200, ['2026-10-21', '2026-10-22'], 2]);
});

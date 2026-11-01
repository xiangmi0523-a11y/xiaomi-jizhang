// 月度预算：每月 1 号按模板重新开始、不结转、新月份从 0 算起、每日建议额度按实际消费和剩余天数调整；
// 历史账单和统计保留。资产页「总负债」换成「总消费」。
'use strict';
const { test, expect, js, dismissCards } = require('../support/fixtures');

const rec = (id, amount, date, o = {}) => Object.assign({ id, type: 'expense', amount, date, acc: 'a_ali', cat: 'e_food', ts: 1 }, o);
const OCT = [rec('o1', 20000, '2026-10-05'), rec('o2', 30000, '2026-10-20'), rec('o3', 5000, '2026-10-31')];   // 10 月花了 550
const heroMsg = page => page.locator('#page .bud2 .bd-msg');
const heroRow = page => page.locator('#page .bud2 .bd-row');

test.describe('普通月预算（模板 ¥1,000）', () => {
  test('11 月 1 号：预算回到模板金额，支出从 0 开始，上个月剩下的 ¥450 不结转', async ({ openApp }) => {
    const page = await openApp({ time: '2026-11-01T10:00:00+08:00', seed: { budget: { total: 100000, cats: {} }, records: OCT } });
    const c = await js(page, 'App.budget.cycle()');
    expect(c).toMatchObject({ ym: '2026-11', total: 100000, spent: 0, remain: 100000, before: 0, todaySpent: 0, daysLeft: 30, allow: 3333 });
    expect(await js(page, 'App.budget.current()')).toMatchObject({ spent: 0, total: 100000, smart: false });
    await expect(heroRow(page)).toContainText('本月预算剩余 ¥1,000.00');
    await expect(heroRow(page)).toContainText('0%');
    await expect(heroMsg(page)).toHaveText('每月预算 ¥1,000.00　|　今日建议 ¥33.33');
    // 模板没被改动；历史账单、10 月统计都还在
    expect(await js(page, 'App.S.budget.total')).toBe(100000);
    expect(await js(page, 'App.S.records.length')).toBe(3);
    expect(await js(page, `App.sum(App.recordsByMonth('2026-10')).expense`)).toBe(55000);
  });

  test('上个月超支也不顺延：11 月照样是完整的 ¥1,000', async ({ openApp }) => {
    const page = await openApp({ time: '2026-11-01T10:00:00+08:00', seed: { budget: { total: 100000, cats: {} }, records: [rec('o1', 150000, '2026-10-10')] } });
    expect(await js(page, 'App.budget.cycle()')).toMatchObject({ total: 100000, spent: 0, remain: 100000, allow: 3333 });
    await expect(page.locator('#page .bud2')).toHaveClass(/lv0/);
  });

  test('每日建议按本月实际消费和剩余天数自动调整', async ({ openApp }) => {
    // 11 月 1–10 号花了 500，11 号又花了 10：11 号的建议 = (1000-500)/20 = 25；12 号 = (1000-510)/19 = 25.78
    const nov = [rec('n1', 30000, '2026-11-02'), rec('n2', 20000, '2026-11-10'), rec('n3', 1000, '2026-11-11')];
    const page = await openApp({ time: '2026-11-11T12:00:00+08:00', clock: 'install', seed: { budget: { total: 100000, cats: {} }, records: OCT.concat(nov) } });
    expect(await js(page, 'App.budget.cycle()')).toMatchObject({ spent: 51000, before: 50000, todaySpent: 1000, daysLeft: 20, allow: 2500, left: 1500, remain: 49000 });
    await expect(heroMsg(page)).toContainText('今日建议 ¥25.00');
    expect(await js(page, `App.budget.cycle('2026-11-12')`)).toMatchObject({ daysLeft: 19, allow: 2578 });
    // 月底最后一天：剩下的全给今天
    expect(await js(page, `App.budget.cycle('2026-11-30')`)).toMatchObject({ daysLeft: 1, allow: 49000 });
    // 花得比预算还多：建议额度为 0，不出现负数
    await page.evaluate(() => { App.S.records.push({ id: 'big', type: 'expense', amount: 60000, date: '2026-11-03', acc: 'a_ali', cat: 'e_food', ts: 2, note: '' }); });
    expect(await js(page, `App.budget.cycle('2026-11-12')`)).toMatchObject({ allow: 0, remain: -11000 });
  });

  test('App 开着跨进 11 月 1 号：首页自动切到新月份，预算和提醒重新开始', async ({ openApp }) => {
    const page = await openApp({ time: '2026-10-31T23:59:00+08:00', clock: 'install', seed: { budget: { total: 100000, cats: {} }, records: [rec('o1', 120000, '2026-10-31')] } });
    await expect(page.locator('#page .bud2')).toHaveClass(/lv2/);   // 10 月超支
    await expect.poll(() => js(page, 'App.S.game.warn')).toEqual({ ym: '2026-10', lv: 2 });   // 启动后的预算检查
    await dismissCards(page);
    await page.clock.fastForward('02:00');   // 过了午夜，跨天检查每 15 秒跑一次
    await expect.poll(() => js(page, 'App.home.ym'), { timeout: 10000 }).toBe('2026-11');
    await expect(page.locator('#page .bud2')).toHaveClass(/lv0/);
    await expect(heroRow(page)).toContainText('本月预算剩余 ¥1,000.00');
    await expect(heroMsg(page)).toContainText('今日建议 ¥33.33');
    await expect.poll(() => js(page, 'App.S.game.warn')).toEqual({ ym: '2026-11', lv: 0 });
    expect(await js(page, 'App.S.records.map(r => r.id)')).toEqual(['o1']);
  });

  test('翻看往月时首页照旧显示那个月的提示语，不显示今日建议', async ({ openApp }) => {
    const page = await openApp({ time: '2026-11-05T10:00:00+08:00', seed: { budget: { total: 100000, cats: {} }, records: OCT } });
    await page.evaluate(() => { App.home.ym = '2026-10'; App.render(false); });
    await expect(heroRow(page)).toContainText('本月预算剩余 ¥450.00');
    await expect(heroMsg(page)).toHaveText('每月预算 ¥1,000.00　|　预算还很充足，继续保持喵');
  });

  test('只读：计算预算周期不改账本', async ({ openApp }) => {
    const page = await openApp({ time: '2026-11-11T12:00:00+08:00', seed: { budget: { total: 100000, cats: {} }, records: OCT } });
    await page.waitForTimeout(300);
    const before = await js(page, 'JSON.stringify(App.S)');
    await page.evaluate(() => { for (let i = 0; i < 5; i++) { App.budget.cycle(); App.budget.cycle('2026-10-15'); } });
    expect(await js(page, 'JSON.stringify(App.S)')).toBe(before);
  });
});

test.describe('智能预算（弹性额度 = 收入 − 固定 − 储蓄）', () => {
  // 收入 4200、固定 1130、储蓄 2000 → 每月弹性额度 1070；房租、话费算固定支出
  const smart = (o = {}) => Object.assign({ on: true, income: 420000, fixed: 113000, saving: 200000, fixedCats: ['e_rent', 'e_phone'], start: '2026-10-23', settled: '2026-10-30', closedYM: '2026-10', jar: 0, log: {}, flag: null }, o);

  test('11 月 1 号：弹性额度回到 1070，本月已花 0；10 月剩下的进储蓄罐，不加到 11 月额度上', async ({ openApp }) => {
    const page = await openApp({ time: '2026-11-01T09:00:00+08:00', seed: { smart: smart(), records: OCT.concat([rec('rent', 113000, '2026-10-25', { cat: 'e_rent' })]) } });
    await expect.poll(() => js(page, 'App.S.smart.closedYM')).toBe('2026-11');   // 启动后的月结
    await dismissCards(page);
    const m = await js(page, 'App.smart.month()');
    expect(m).toMatchObject({ ym: '2026-11', quota: 107000, spent: 0, remain: 107000 });
    expect(await js(page, 'App.smart.today()')).toMatchObject({ allow: 3566, spent: 0, before: 0, daysLeft: 30 });
    // 10 月月结：弹性 1070 − 实花 550 = 520 没花完，加计划储蓄 2000，进储蓄罐（这是原有功能，不是预算结转）
    const s = await js(page, 'App.S.smart');
    expect(s.closedYM).toBe('2026-11');
    expect(s.log['2026-10']).toEqual({ quota: 107000, spent: 55000, leftover: 52000, add: 252000 });
    expect(s.jar).toBe(252000);
    expect([s.income, s.fixed, s.saving]).toEqual([420000, 113000, 200000]);   // 模板不变
    await expect(page.locator('#page .bud2.smart .bd-msg')).toContainText('本月已用 0%');
    expect(await js(page, 'App.S.records.length')).toBe(4);
  });

  test('每日额度随本月实际消费和剩余天数调整', async ({ openApp }) => {
    const page = await openApp({ time: '2026-11-03T09:00:00+08:00', seed: { smart: smart({ closedYM: '2026-11', settled: '2026-11-02' }), records: [rec('a', 20000, '2026-11-01'), rec('b', 7000, '2026-11-02'), rec('r', 113000, '2026-11-01', { cat: 'e_rent' })] } });
    await dismissCards(page);
    // 固定支出（房租）不占弹性额度：(1070 − 270) ÷ 28 天 = 28.57
    expect(await js(page, 'App.smart.today()')).toMatchObject({ before: 27000, daysLeft: 28, allow: 2857 });
    expect(await js(page, 'App.smart.month()')).toMatchObject({ spent: 27000, remain: 80000 });
  });
});

test('资产页：「总负债」换成「总消费」= 所有账单的支出合计；净资产算法不变', async ({ openApp }) => {
  const recs = OCT.concat([
    rec('n1', 24838, '2026-11-01'),
    rec('in', 100500, '2026-10-01', { type: 'income', cat: 'i_salary', acc: 'a_bank' }),
    rec('tr', 500, '2026-10-02', { type: 'transfer', cat: '', acc: 'a_bank', to: 'a_wx' })
  ]);
  const page = await openApp({ time: '2026-11-01T22:00:00+08:00', seed: { records: recs } });
  await page.evaluate(() => { App.tab = 'assets'; App.render(false); });
  const hero = page.locator('#page .hero.slim');
  await expect(hero).toContainText('总消费');
  await expect(hero).not.toContainText('总负债');
  const pair = hero.locator('.hero-row.two > div');
  await expect(pair.nth(0)).toContainText('1,005.00');                 // 总资产：储蓄卡 1000 + 微信 5
  await expect(pair.nth(1)).toHaveText(/总消费\s*798\.38/);           // 550 + 248.38，不含收入和转账
  await expect(hero.locator('.big')).toContainText('206.62');          // 净资产 = 1005 − 支付宝欠的 798.38
});

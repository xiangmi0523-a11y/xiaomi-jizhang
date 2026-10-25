// 金额单位（整数「分」）与日期处理：直接调用页面里真实的 App.U 工具函数
'use strict';
const { test, expect, js } = require('../support/fixtures');

test.describe('金额', () => {
  test('toCents：各种写法都换算成整数分，不会被当成 0', async ({ openApp }) => {
    const page = await openApp({ time: '2026-10-21T12:00:00+08:00' });
    const cases = {
      '18': 1800, '18.5': 1850, '18.05': 1805, '0.01': 1, '.5': 50, '12.345': 1234, '8,000': 800000,
      '¥ 50': 5000, '￥12.3元': 1230, '12。5': 1250, '１２３': 12300, '': 0, '.': 0, 'abc': 0, '-5': 0, '1.2.3': 0
    };
    const got = await js(page, `Object.fromEntries(Object.keys(arg).map(k => [k, App.U.toCents(k)]))`, cases);
    expect(got).toEqual(cases);
  });

  test('money / centsToStr / cell：分 → 显示文字', async ({ openApp }) => {
    const page = await openApp({ time: '2026-10-21T12:00:00+08:00' });
    const r = await js(page, `({
      money: [0, 1, 99, 1850, 123456789, -1850, 1850.6].map(App.U.money),
      str: [1800, 1850, 1805, 1].map(App.U.centsToStr),
      cell: [1850, 123456, 1234567].map(App.U.cell) })`);
    expect(r.money).toEqual(['0.00', '0.01', '0.99', '18.50', '1,234,567.89', '-18.50', '18.51']);
    expect(r.str).toEqual(['18', '18.5', '18.05', '0.01']);
    expect(r.cell).toEqual(['18.5', '1235', '1.2万']);
  });

  test('evalExpr：键盘里的加减算式按分计算，没有浮点误差', async ({ openApp }) => {
    const page = await openApp({ time: '2026-10-21T12:00:00+08:00' });
    const r = await js(page, `['0.1+0.2', '12+3.5', '100-0.01', '10-20', '1.1+1.1+1.1'].map(App.U.evalExpr)`);
    expect(r).toEqual([30, 1550, 9999, -1000, 330]);
  });

  test('sum / balance：按分累加，转账只在账户之间移动', async ({ openApp }) => {
    const page = await openApp({ time: '2026-10-21T12:00:00+08:00', seed: {
      accounts: [{ id: 'a_cash', name: '现金', type: 'cash', init: 10000 }, { id: 'a_wx', name: '微信', type: 'ewallet', init: 0 }],
      records: [
        { id: 'r1', type: 'expense', amount: 1850, date: '2026-10-21', acc: 'a_cash', cat: 'e_food', ts: 1 },
        { id: 'r2', type: 'income', amount: 500000, date: '2026-10-20', acc: 'a_wx', cat: 'i_salary', ts: 2 },
        { id: 'r3', type: 'transfer', amount: 2000, date: '2026-10-19', acc: 'a_wx', to: 'a_cash', ts: 3 }
      ] } });
    const r = await js(page, `({ sum: App.sum(App.S.records), cash: App.balance('a_cash'), wx: App.balance('a_wx') })`);
    expect(r).toEqual({ sum: { expense: 1850, income: 500000 }, cash: 10000 - 1850 + 2000, wx: 500000 - 2000 });
  });
});

test.describe('日期', () => {
  test('today / curYM 跟随设备本地时区（Asia/Shanghai），不受 UTC 影响', async ({ openApp }) => {
    // 北京时间 10/22 凌晨 00:30 = UTC 10/21 16:30
    const page = await openApp({ time: '2026-10-21T16:30:00Z' });
    expect(await js(page, `[App.U.today(), App.U.curYM()]`)).toEqual(['2026-10-22', '2026-10']);
  });

  test('addDays / ymAdd / dim：跨月、跨年、闰年', async ({ openApp }) => {
    const page = await openApp({ time: '2026-10-21T12:00:00+08:00' });
    const r = await js(page, `({
      add: [['2026-10-31', 1], ['2026-12-31', 1], ['2028-02-28', 1], ['2026-03-01', -1], ['2026-01-01', -1]].map(a => App.U.addDays(a[0], a[1])),
      ym: [['2026-12', 1], ['2026-01', -1], ['2026-10', 0], ['2026-10', 14]].map(a => App.U.ymAdd(a[0], a[1])),
      dim: [[2026, 2], [2028, 2], [2100, 2], [2026, 4], [2026, 12]].map(a => App.U.dim(a[0], a[1])) })`);
    expect(r.add).toEqual(['2026-11-01', '2027-01-01', '2028-02-29', '2026-02-28', '2025-12-31']);
    expect(r.ym).toEqual(['2027-01', '2025-12', '2026-10', '2027-12']);
    expect(r.dim).toEqual([28, 29, 28, 30, 31]);
  });

  test('dayLabel：今天 / 昨天 / 明天 / 跨年显示年份', async ({ openApp }) => {
    const page = await openApp({ time: '2026-10-21T12:00:00+08:00' });
    const r = await js(page, `['2026-10-21', '2026-10-20', '2026-10-22', '2026-09-01', '2025-12-31'].map(App.U.dayLabel)`);
    expect(r).toEqual(['今天', '昨天', '明天', '9月1日', '2025年12月31日']);
  });

  test('周期日期 occurrence：每月 31 号在小月 / 二月自动落到月底；每年 2/29 在平年落到 2/28', async ({ openApp }) => {
    const page = await openApp({ time: '2026-10-21T12:00:00+08:00' });
    const r = await js(page, `({
      monthly: [0, 1, 2, 3].map(k => App.occurrence({ start: '2026-01-31', freq: 'monthly' }, k)),
      yearly: [0, 1, 4].map(k => App.occurrence({ start: '2028-02-29', freq: 'yearly' }, k)),
      weekly: [0, 1, 2].map(k => App.occurrence({ start: '2026-12-24', freq: 'weekly' }, k)),
      daily: [0, 1].map(k => App.occurrence({ start: '2026-12-31', freq: 'daily' }, k)) })`);
    expect(r.monthly).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(r.yearly).toEqual(['2028-02-29', '2029-02-28', '2032-02-29']);
    expect(r.weekly).toEqual(['2026-12-24', '2026-12-31', '2027-01-07']);
    expect(r.daily).toEqual(['2026-12-31', '2027-01-01']);
  });

  test('recordsByMonth：按月份筛选，并按日期、时间倒序', async ({ openApp }) => {
    const page = await openApp({ time: '2026-10-21T12:00:00+08:00', seed: { records: [
      { id: 'a', type: 'expense', amount: 100, date: '2026-10-01', acc: 'a_cash', cat: 'e_food', ts: 5 },
      { id: 'b', type: 'expense', amount: 100, date: '2026-10-21', acc: 'a_cash', cat: 'e_food', ts: 1 },
      { id: 'c', type: 'expense', amount: 100, date: '2026-10-21', acc: 'a_cash', cat: 'e_food', ts: 9 },
      { id: 'd', type: 'expense', amount: 100, date: '2026-09-30', acc: 'a_cash', cat: 'e_food', ts: 1 },
      { id: 'e', type: 'expense', amount: 100, date: '2026-11-01', acc: 'a_cash', cat: 'e_food', ts: 1 }
    ] } });
    expect(await js(page, `App.recordsByMonth('2026-10').map(r => r.id)`)).toEqual(['c', 'b', 'a']);
  });
});

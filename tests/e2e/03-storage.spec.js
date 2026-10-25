// 本地数据保存、读取、损坏恢复与数据清洗
'use strict';
const { test, expect, js, KEY } = require('../support/fixtures');

const T = '2026-10-21T12:00:00+08:00';
const rec = (o = {}) => Object.assign({ id: 'r1', type: 'expense', amount: 1200, date: '2026-10-21', acc: 'a_cash', cat: 'e_food', ts: 1 }, o);

test('改动会写入 localStorage，刷新页面后完整恢复', async ({ openApp }) => {
  const page = await openApp({ time: T });
  await js(page, `(App.addRecord({ type: 'expense', amount: 2350, cat: 'e_snack', acc: 'a_wx', to: '', date: '2026-10-21', note: '奶茶' }), App.S.budget.total = 300000, App.flush(), 0)`);
  const stored = await js(page, `JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}))`);
  expect(stored.records).toHaveLength(1);
  expect(stored.records[0]).toMatchObject({ amount: 2350, note: '奶茶', acc: 'a_wx' });
  await page.reload();
  await page.waitForFunction(() => window.App && window.App.S);
  expect(await js(page, `[App.S.records.length, App.S.records[0].amount, App.S.records[0].note, App.S.budget.total]`)).toEqual([1, 2350, '奶茶', 300000]);
});

test('App.changed 之后约 250ms 自动保存（不用等切后台）', async ({ openApp }) => {
  const page = await openApp({ time: T });
  await js(page, `(App.S.records.push({ id: 'x1', type: 'expense', amount: 100, date: '2026-10-21', acc: 'a_cash', cat: 'e_food', ts: 1 }), App.changed(), 0)`);
  await expect.poll(() => js(page, `JSON.parse(localStorage.getItem(${JSON.stringify(KEY)})).records.length`)).toBe(1);
});

test('localStorage 数据损坏：用新账本启动、提示用户，坏数据另存不丢', async ({ openApp }) => {
  const page = await openApp({ time: T, seed: '{broken json' });
  expect(await js(page, `[App.loadError === true, App.S.records.length]`)).toEqual([true, 0]);
  expect(await js(page, `localStorage.getItem(${JSON.stringify(KEY + '_corrupt0')})`)).toBe('{broken json');
  await expect(page.locator('#toast')).toContainText('数据文件读取失败');
});

test('原生 App：原生数据文件损坏时，退回 localStorage 备用副本并把坏文件另存', async ({ openApp }) => {
  const good = { records: [rec()], accounts: [{ id: 'a_cash', name: '现金', type: 'cash', init: 0 }] };
  const page = await openApp({ time: T, native: true, seed: good, nativeB64: Buffer.from('{broken').toString('base64') });
  expect(await js(page, `[App.loadRecovered === true, App.S.records.length, App.S.records[0].amount]`)).toEqual([true, 1, 1200]);
  // 另外还会有一份「自动备份」快照，这里只看「损坏的数据」那份
  const snaps = await js(page, `window._msgs.filter(m => m.type === 'snapshot' && m.filename.startsWith('晓米记账-损坏的数据-')).map(m => m.content)`);
  expect(snaps).toEqual(['{broken']);
  await expect(page.locator('#toast')).toContainText('已从备用副本恢复');
});

test('原生 App：原生文件正常时优先用原生文件', async ({ openApp }) => {
  const nativeState = { records: [rec({ id: 'n', amount: 777 })], accounts: [{ id: 'a_cash', name: '现金', type: 'cash' }] };
  const webState = { records: [rec({ id: 'w', amount: 111 })], accounts: [{ id: 'a_cash', name: '现金', type: 'cash' }] };
  const page = await openApp({ time: T, native: true, seed: webState, nativeB64: Buffer.from(JSON.stringify(nativeState)).toString('base64') });
  expect(await js(page, `App.S.records.map(r => r.id + ':' + r.amount)`)).toEqual(['n:777']);
});

test('数据清洗：金额字符串转整数分、坏记录丢弃、图标里的 HTML 被去掉', async ({ openApp }) => {
  const page = await openApp({ time: T, seed: {
    records: [
      rec({ id: 'ok', amount: '1250' }),
      rec({ id: 'bad-amount', amount: 'abc' }),
      rec({ id: 'zero', amount: 0 }),
      rec({ id: 'bad-type', type: '??' }),
      rec({ id: 'bad-date', date: '2026/10/21' }),
      rec({ id: 'float', amount: 99.6 })
    ],
    accounts: [{ id: 'a_cash', name: '现金', type: 'weird' }],
    cats: { expense: [{ id: 'e_food', name: '餐饮', icon: '<img src=x onerror=window.PWN=1>' }], income: [] }
  } });
  const r = await js(page, `({ recs: App.S.records.map(r => [r.id, r.amount]), sum: App.sum(App.S.records).expense,
    accType: App.S.accounts[0].type, icon: App.S.cats.expense[0].icon, incomeCats: App.S.cats.income.length, pwn: !!window.PWN })`);
  expect(r.recs).toEqual([['ok', 1250], ['float', 100]]);
  expect(r.sum).toBe(1350);
  expect(r.accType).toBe('other');
  expect(r.icon).not.toMatch(/[<>"']/);
  expect(r.incomeCats).toBe(8);      // 空的收入分类回退到默认
  expect(r.pwn).toBe(false);
});

test('旧版本备份（缺少 game / smart / saving 字段）能补齐默认值', async ({ openApp }) => {
  const page = await openApp({ time: T, seed: { records: [rec()], accounts: [{ id: 'a1', name: 'x', type: 'cash', init: 0 }] } });
  const r = await js(page, `({ coins: App.S.game.coins, signed: App.S.game.signed, inn: App.S.game.inn, smart: App.S.smart.on, plans: App.S.saving.plans, budget: App.S.budget })`);
  expect(r).toEqual({ coins: 100, signed: [], inn: { slots: {}, owned: [] }, smart: false, plans: [], budget: { total: 0, cats: {} } });
});

test('覆盖账本（replaceState）前，原生 App 会先留一份「操作前备份」', async ({ openApp }) => {
  const page = await openApp({ time: T, native: true, seed: { records: [rec()], accounts: [{ id: 'a_cash', name: '现金', type: 'cash' }] } });
  await js(page, `(App.replaceState(null), 0)`);
  const snap = await js(page, `window._msgs.filter(m => m.type === 'snapshot' && m.filename.startsWith('晓米记账-操作前备份-')).map(m => JSON.parse(m.content).records.length)`);
  expect(snap).toEqual([1]);
  expect(await js(page, `App.S.records.length`)).toBe(0);
});

test('CSV 导出：金额按元两位小数，以 = + - @ 开头的备注加前缀防公式', async ({ openApp }) => {
  const page = await openApp({ time: T, seed: { records: [
    rec({ id: 'a', amount: 1850, note: '=HYPERLINK("x")' }),
    rec({ id: 'b', amount: 5, note: '-5' }),
    rec({ id: 'c', amount: 100, note: '@me', date: '2026-10-20' })
  ] } });
  const lines = (await js(page, `App.csv()`)).replace(/^﻿/, '').split('\r\n');
  expect(lines[0]).toBe('"日期","类型","分类","金额","账户","转入账户","备注"');
  expect(lines).toContain(`"2026-10-21","支出","餐饮","18.50","现金","","'=HYPERLINK(""x"")"`);
  expect(lines).toContain('"2026-10-21","支出","餐饮","0.05","现金","","-5"');
  expect(lines).toContain(`"2026-10-20","支出","餐饮","1.00","现金","","'@me"`);
});

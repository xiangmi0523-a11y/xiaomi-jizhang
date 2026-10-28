// 猫咪财务点评：纯前端规则，按本月支出比例吐槽 / 夸奖 / 鼓励；只读数据，不写账本、不同步
'use strict';
const { test, expect, js, dismissCards, KEY } = require('../support/fixtures');

const T = '2026-10-21T20:00:00+08:00';   // 10 月有 31 天，21 号 → 已过 68%
// 超支时启动会弹出预警卡片（会稍晚出现），先等它出来再关掉，免得挡住气泡
const closeWarn = async page => { await page.locator('.wn').first().waitFor({ timeout: 8000 }); await dismissCards(page); };
const rec = (id, amount, type = 'expense', date = '2026-10-05') => ({ id, type, amount, date, acc: 'a_cash', cat: type === 'income' ? 'i_salary' : 'e_food', ts: 1 });

test.describe('判断规则（App.critic.judge）', () => {
  test('各种比例落到正确的类别', async ({ openApp }) => {
    const page = await openApp({ time: T });
    const J = o => js(page, 'App.critic.judge(arg)', o);
    // 设了预算：以预算为基准（金额单位：分）
    expect(await J({ spent: 0, total: 100000, day: 21, dim: 31 })).toMatchObject({ key: 'zero', kind: 'praise' });
    expect(await J({ spent: 120000, total: 100000, day: 21, dim: 31 })).toMatchObject({ key: 'over', kind: 'roast', pct: 120, over: 20000, basis: 'budget' });
    expect(await J({ spent: 100000, total: 100000, day: 30, dim: 31 })).toMatchObject({ key: 'near', kind: 'roast', left: 0 });   // 正好 100% 不算超支
    expect(await J({ spent: 85000, total: 100000, day: 30, dim: 31 })).toMatchObject({ key: 'near', kind: 'roast', pct: 85, left: 15000 });
    expect(await J({ spent: 60000, total: 100000, day: 10, dim: 30 })).toMatchObject({ key: 'fast', kind: 'roast', days: 33 });
    expect(await J({ spent: 20000, total: 100000, day: 15, dim: 30 })).toMatchObject({ key: 'slow', kind: 'praise' });
    expect(await J({ spent: 50000, total: 100000, day: 15, dim: 30 })).toMatchObject({ key: 'ontrack', kind: 'cheer' });
    // 边界：比进度快正好 15 个百分点还算正常，慢正好 10 个百分点算省钱
    expect(await J({ spent: 65000, total: 100000, day: 15, dim: 30 })).toMatchObject({ key: 'ontrack' });
    expect(await J({ spent: 40000, total: 100000, day: 15, dim: 30 })).toMatchObject({ key: 'slow' });
    // 没设预算：以本月收入为基准
    expect(await J({ spent: 600000, total: 0, income: 500000, day: 21, dim: 31 })).toMatchObject({ key: 'overIncome', kind: 'roast', basis: 'income' });
    expect(await J({ spent: 450000, total: 0, income: 500000, day: 21, dim: 31 })).toMatchObject({ key: 'nearIncome', kind: 'roast' });
    expect(await J({ spent: 100000, total: 0, income: 500000, day: 21, dim: 31 })).toMatchObject({ key: 'slow', basis: 'income' });
    // 既没预算也没收入：鼓励去设预算
    expect(await J({ spent: 100, total: 0, income: 0, day: 21, dim: 31 })).toMatchObject({ key: 'nobudget', kind: 'cheer', basis: 'none' });
  });

  test('每一句话都把占位符替换掉了，金额按元显示', async ({ openApp }) => {
    const page = await openApp({ time: T });
    const bad = await js(page, `(() => {
      const v = { pct: 120, days: 68, left: 1234, over: 20050 }, out = [];
      Object.keys(App.critic.LINES).forEach(key => App.critic.LINES[key].forEach((_, i) => {
        const t = App.critic.text(Object.assign({ key }, v), '2026-10-21', i);
        if (/[{}]/.test(t) || !t) out.push(key + ':' + t);
      }));
      return out;
    })()`);
    expect(bad).toEqual([]);
    expect(await js(page, `App.critic.text({ key: 'near', pct: 85, days: 68, left: 15000, over: 0 }, '2026-10-21', 0) + App.critic.text({ key: 'near', pct: 85, days: 68, left: 15000, over: 0 }, '2026-10-21', 1)`)).toContain('¥150.00');
  });
});

test.describe('首页气泡', () => {
  test('超支：吐槽气泡 + 生气的猫；点一下换一句，同一天刷新不变', async ({ openApp }) => {
    const page = await openApp({ time: T, seed: { budget: { total: 100000 }, records: [rec('a', 120000)] } });
    await closeWarn(page);
    const ck = page.locator('#page .hm-card .ck');
    await expect(ck).toHaveClass(/ck-roast/);
    const first = await ck.textContent();
    expect(first).toMatch(/超|花到预算的 120%/);
    await expect(page.locator('#page .hm-cat .xc')).toHaveClass(/mood-angry/);
    await ck.click();
    await expect(ck).not.toHaveText(first);
    await ck.click(); await ck.click();
    await expect(ck).toHaveText(first);   // 3 句一轮
    await page.reload();
    await expect(page.locator('#page .hm-card .ck')).toHaveText(first);
  });

  test('省钱：夸奖气泡；花得快：吐槽；正常：鼓励', async ({ openApp }) => {
    const cases = [
      { amount: 20000, cls: /ck-praise/ },   // 20%，进度 68%
      { amount: 70000, cls: /ck-cheer/ },    // 70%
      { amount: 90000, cls: /ck-roast/ }     // 90%
    ];
    for (const c of cases) {
      const page = await openApp({ time: T, seed: { budget: { total: 100000 }, records: [rec('a', c.amount)] } });
      await dismissCards(page);
      await expect(page.locator('#page .hm-card .ck')).toHaveClass(c.cls);
    }
  });

  test('没设预算也没收入：鼓励设预算，点气泡打开智能预算', async ({ openApp }) => {
    const page = await openApp({ time: T, seed: { records: [rec('a', 5000)] } });
    const ck = page.locator('#page .hm-card .ck');
    await expect(ck).toHaveClass(/ck-cheer/);
    await expect(ck).toContainText('还没设预算');
    await expect(ck).toHaveAttribute('data-act', 'openSmart');
  });

  test('没设预算时按收入比较', async ({ openApp }) => {
    const page = await openApp({ time: T, seed: { records: [rec('i', 500000, 'income'), rec('a', 600000)] } });
    await expect(page.locator('#page .hm-card .ck')).toHaveClass(/ck-roast/);
    expect(await js(page, 'App.critic.now().key')).toBe('overIncome');
  });

  test('切到别的月份时不显示点评，切回本月又出现', async ({ openApp }) => {
    const page = await openApp({ time: T, seed: { budget: { total: 100000 }, records: [rec('a', 20000)] } });
    await expect(page.locator('#page .ck')).toHaveCount(1);
    await page.evaluate(() => { App.home.ym = '2026-09'; App.render(false); });
    await expect(page.locator('#page .hm-card')).toBeVisible();
    await expect(page.locator('#page .ck')).toHaveCount(0);
    await page.evaluate(() => { App.home.ym = '2026-10'; App.render(false); });
    await expect(page.locator('#page .ck')).toHaveCount(1);
  });

  test('只读：显示和点击气泡都不改账本、不保存、不发网络请求', async ({ openApp }) => {
    const page = await openApp({ time: T, seed: { budget: { total: 100000 }, records: [rec('a', 120000)] } });
    await closeWarn(page);
    await page.waitForTimeout(500);
    const before = await js(page, `[JSON.stringify(App.S), localStorage.getItem(arg)]`, KEY);
    const reqs = [];
    page.on('request', r => reqs.push(r.url()));
    for (let i = 0; i < 5; i++) await page.locator('#page .hm-card .ck').click();
    await page.evaluate(() => { for (let i = 0; i < 5; i++) App.critic.now(); });
    await page.waitForTimeout(300);
    expect(await js(page, `[JSON.stringify(App.S), localStorage.getItem(arg)]`, KEY)).toEqual(before);
    expect(reqs).toEqual([]);
  });
});

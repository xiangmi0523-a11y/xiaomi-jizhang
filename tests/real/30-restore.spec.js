// Phase 2B-3：登录状态下「导入备份」= 用备份替换云端账本（restore.js），全部走界面，连真实 PostgreSQL + PostgREST
'use strict';
const { test, expect, js, serverRestore, login, newEmail, uidOf } = require('./fixtures');
const { rec, acc, cat } = require('./protocol-cjs');

const T = '2026-10-21T20:00:00+08:00';
const addRec = (page, note, amount = 100) => js(page, `App.addRecord({ type: 'expense', amount: ${amount}, cat: 'e_food', acc: 'a_cash', to: '', date: '2026-10-21', note: ${JSON.stringify(note)} }).id`);
const syncNow = async page => { await page.evaluate(() => { window.App.cloud.sync(false); }); await page.waitForFunction(() => !window.App.cloud.busy); return page.evaluate(() => window.App.cloud.err || ''); };
const setAuto = (page, on) => js(page, `(App.S.settings.cloudAuto = ${on}, App.flush(), 0)`);
const notes = page => js(page, 'App.S.records.map(r => r.note).sort()');
const calls = (gw, uid, fn, since = 0) => gw.log.filter(l => l.uid === uid && l.t >= since && l.path === '/rest/v1/rpc/' + fn);
const jobs = (gw, uid) => JSON.parse(gw.db.sql(`select coalesce(json_agg(json_build_object('id', job_id, 'state', state, 'scope', scope) order by created_at), '[]') from public.xm_restore_job where user_id = '${uid}'`));

// 「我的 → 数据与备份 → 导入备份」选文件；start 时在确认页点「开始恢复」，等进度面板出现
// 进度面板（标题正好是「恢复备份」；很快就恢复完的话面板里只剩「没有正在进行的恢复」）
const waitPanel = page => page.locator('.sheet-title').filter({ hasText: /^恢复备份$/ }).waitFor();
async function importViaUI(page, obj, { start = true } = {}) {
  await page.evaluate(() => { window.App.UI.closeAll(); window.App.A.openData(); });
  await page.setInputFiles('#importFile', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)) });
  if (!start) return;
  await page.click('[data-rs="go"]');
  await waitPanel(page);
}
const waitDone = (page, timeout = 30000) => page.waitForFunction(() => !window.App.restore.pending() && !window.App.cloud.busy, null, { timeout });
const waitErr = page => page.waitForFunction(() => { const j = window.App.restore.job(); return j && j.err && !window.App.cloud.busy; }, null, { timeout: 20000 });

// 准备：A 登录、记三笔并同步；关掉自动同步（测试里显式触发）
async function setup(openApp, gw, { name = 'A' } = {}) {
  const email = newEmail();
  const A = await openApp({ name, time: T, cloudUrl: gw.url });
  const ids = { r1: await addRec(A, '早餐', 100), r2: await addRec(A, '午饭', 200), r3: await addRec(A, '晚饭', 300) };
  await login(A, email, 'secret123', { signup: true });
  await setAuto(A, false);
  expect(await syncNow(A)).toBe('');
  const uid = uidOf(gw, email);
  expect(gw.db.live(uid)).toHaveLength(3);
  return { email, A, ids, uid };
}

test('H3 修复：导出 → 之后又记了一笔并同步 → 通过界面导入旧备份：云端和本机都回到备份，再同步也不会合并回来；另一台设备跟着对齐', async ({ openApp, gw }) => {
  const { email, A, ids, uid } = await setup(openApp, gw);
  const backup = await js(A, 'App.restore.exportText()');
  expect(JSON.parse(backup).sync).toBeUndefined();                       // 导出不含同步记录
  const extra = await addRec(A, '导出后新增', 999);
  await js(A, '(App.S.budget.total = 77700, App.changed(), 0)');
  expect(await syncNow(A)).toBe('');
  const B = await openApp({ name: 'B', time: T, cloudUrl: gw.url });
  await login(B, email);
  await setAuto(B, false);
  expect(await notes(B)).toContain('导出后新增');

  await importViaUI(A, backup);
  await waitDone(A);
  // 云端：版本号 +1，备份里没有的那笔被软删除，整块设置回到备份
  expect(gw.db.epochOf(uid)).toBe(1);
  expect(gw.db.live(uid)).toEqual(Object.values(ids).sort());
  expect(gw.db.rows('xm_records', uid, `id = '${extra}'`)[0].deleted).toBe(true);
  expect(gw.db.state(uid).budget.total).toBe(0);
  expect(jobs(gw, uid).map(j => j.state)).toEqual(['applied']);
  // 恢复任务存在期间，A 只调用了恢复 RPC，没有直接写数据表
  const t0 = calls(gw, uid, 'xm_restore_create')[0].t, t1 = calls(gw, uid, 'xm_restore_apply')[0].t;
  expect(gw.writes(uid, t0).filter(w => w.t <= t1)).toEqual([]);
  // 本机：回到备份，版本号更新，冲突箱是空的（恢复前没有未同步的修改）
  expect(await notes(A)).toEqual(['午饭', '早餐', '晚饭']);
  expect(await js(A, '[App.S.sync.epoch, App.conflicts.pending().length, App.restore.pending(), App.S.budget.total]')).toEqual([1, 0, false, 0]);
  // 再同步两次：新账单不会被合并回来（这就是 H3）
  expect(await syncNow(A)).toBe('');
  expect(await syncNow(A)).toBe('');
  expect(await notes(A)).toEqual(['午饭', '早餐', '晚饭']);
  expect(gw.db.live(uid)).toEqual(Object.values(ids).sort());
  // 另一台设备：发现版本号变化 → 自动对齐
  expect(await syncNow(B)).toBe('');
  expect(await notes(B)).toEqual(['午饭', '早餐', '晚饭']);
  expect(await js(B, '[App.S.sync.epoch, App.conflicts.pending().length]')).toEqual([1, 0]);
});

test('无效备份：校验不过的一律不发任何恢复请求，本机和云端都不动，提示具体原因', async ({ openApp, gw }) => {
  const { A, uid } = await setup(openApp, gw);
  const good = JSON.parse(await js(A, 'App.restore.exportText()'));
  const legacy = () => { const o = JSON.parse(JSON.stringify(good)); delete o._manifest; return o; };
  const cases = [
    ['校验码对不上', (() => { const o = JSON.parse(JSON.stringify(good)); o.records[0].amount = 1; return o; })()],
    ['日期、金额或类型无效', (() => { const o = legacy(); o.records[0].date = '2026/10/21'; return o; })()],
    ['重复的编号', (() => { const o = legacy(); o.records[1].id = o.records[0].id; return o; })()],
    ['缺少账户', (() => { const o = legacy(); o.accounts = []; return o; })()],
    ['缺少分类', (() => { const o = legacy(); delete o.cats; return o; })()],
    ['猫咪数据格式不对', (() => { const o = legacy(); o.game.cats = ['n1']; return o; })()]
  ];
  const before = await js(A, 'JSON.stringify(App.S.records)');
  for (const [msg, obj] of cases) {
    await importViaUI(A, obj, { start: false });
    const dlg = A.locator('.dlg');
    await expect(dlg.locator('h4')).toHaveText('这份备份不能恢复');
    await expect(dlg.locator('p')).toContainText(msg);
    await dlg.locator('[data-r="0"]').click();
    expect(await A.locator('[data-rs="go"]').count()).toBe(0);           // 没有进入确认页
  }
  expect(gw.log.filter(l => l.uid === uid && l.path.startsWith('/rest/v1/rpc/'))).toEqual([]);
  expect(await js(A, 'JSON.stringify(App.S.records)')).toBe(before);
  expect(await js(A, 'App.restore.pending()')).toBe(false);
  expect(gw.db.epochOf(uid)).toBe(0);
});

test('apply 已在服务器成功、但响应丢了：本机先不动；重试同一个任务，服务器返回原结果，不会恢复两次', async ({ openApp, gw }) => {
  const { A, ids, uid } = await setup(openApp, gw);
  const backup = await js(A, 'App.restore.exportText()');
  await addRec(A, '导出后新增', 999);
  expect(await syncNow(A)).toBe('');
  // 丢掉 apply 的响应，直到 App 自己报错为止（浏览器在连接被断开时可能会自动重发一次 POST，那一次也一并丢掉）
  gw.after = e => (e.uid === uid && e.path === '/rest/v1/rpc/xm_restore_apply' ? 'lose' : undefined);
  await importViaUI(A, backup);
  await waitErr(A);
  gw.after = null;
  const lostCalls = calls(gw, uid, 'xm_restore_apply').length;
  expect(lostCalls).toBeGreaterThanOrEqual(1);
  expect(gw.db.epochOf(uid)).toBe(1);                                    // 服务器已经应用了
  expect(await js(A, '[App.restore.job().phase, App.S.sync.epoch]')).toEqual(['sealed', 0]);   // 本机没收到结果：仍是「已封存」，账本没动
  expect(await notes(A)).toContain('导出后新增');
  expect(await js(A, 'App.cloud.err')).toContain('备份恢复还没完成');
  expect(await syncNow(A)).toBe('');                                     // 重试（自动重试同理）
  await waitDone(A);
  expect(calls(gw, uid, 'xm_restore_apply')).toHaveLength(lostCalls + 1);   // 服务器第二次（及以后）直接返回原结果
  expect(calls(gw, uid, 'xm_restore_create')).toHaveLength(1);
  expect(jobs(gw, uid).map(j => j.state)).toEqual(['applied']);
  expect(gw.db.epochOf(uid)).toBe(1);                                    // 只恢复了一次
  expect(gw.db.sql(`select count(*) from public.xm_restore_archive a join public.xm_restore_job j using (job_id) where j.user_id = '${uid}' and a.tbl = 'xm_records'`)).toBe('4');
  expect(await notes(A)).toEqual(['午饭', '早餐', '晚饭']);
  expect(await js(A, 'App.S.sync.epoch')).toBe(1);
  expect(gw.db.live(uid)).toEqual(Object.values(ids).sort());
});

test('连点「开始恢复」：只建一个任务', async ({ openApp, gw }) => {
  const { A, uid } = await setup(openApp, gw);
  const backup = await js(A, 'App.restore.exportText()');
  await importViaUI(A, backup, { start: false });
  await A.locator('[data-rs="go"]').evaluate(el => { el.click(); el.click(); el.click(); });
  await waitPanel(A);
  await waitDone(A);
  expect(calls(gw, uid, 'xm_restore_create')).toHaveLength(1);
  expect(jobs(gw, uid)).toHaveLength(1);
  expect(gw.db.epochOf(uid)).toBe(1);
  // 按钮之外的第二道防线：两次 start 同时到达（例如面板重画前的快速双击）→ 只有一次生效
  const r = await js(A, 'Promise.allSettled([0, 1].map(() => App.restore.start(App.restore.validate(JSON.parse(arg))))).then(a => a.map(x => x.status === "fulfilled" ? x.value : "err"))', backup);
  expect(r.filter(x => x === true)).toHaveLength(1);
  await waitDone(A);
  expect(calls(gw, uid, 'xm_restore_create')).toHaveLength(2);
  expect(jobs(gw, uid)).toHaveLength(2);
  expect(gw.db.epochOf(uid)).toBe(2);
});

test('上传到一半断网、App 被杀后重开：接着同一个任务、跳过已传完的批次，不新建任务', async ({ openApp, gw }) => {
  const { A, uid } = await setup(openApp, gw);
  await js(A, "(() => { for (let i = 0; i < 1200; i++) App.S.records.push({ id: 'b' + i, type: 'expense', amount: 100 + i, cat: 'e_food', acc: 'a_cash', to: '', date: '2026-10-01', note: '批量' + i, ts: i }); App.changed(); return 0; })()");
  expect(await syncNow(A)).toBe('');
  const backup = await js(A, 'App.restore.exportText()');
  await addRec(A, '导出后新增', 999);
  expect(await syncNow(A)).toBe('');
  let n = 0;
  // 账户 1 批、分类 1 批、账单 3 批：第 2 批账单失败
  gw.before = e => { if (e.uid === uid && e.path === '/rest/v1/rpc/xm_restore_stage' && ++n === 4) return { status: 503, body: { message: 'upstream down' } }; };
  await importViaUI(A, backup);
  await waitErr(A);
  const jobId = await js(A, 'App.restore.job().id');
  expect(await js(A, 'App.restore.job().staged')).toEqual({ xm_accounts: 1, xm_categories: 1, xm_records: 1 });
  expect(gw.db.epochOf(uid)).toBe(0);
  // 「App 被杀后重开」：重新加载页面，打开自动同步（启动时会同步一次）
  await setAuto(A, true);
  const t0 = Date.now();
  await A.reload(); await A.waitForFunction(() => window.App && window.App.S && window.App.restore);
  await waitDone(A, 60000);
  expect(calls(gw, uid, 'xm_restore_create', t0)).toHaveLength(0);
  expect(calls(gw, uid, 'xm_restore_stage', t0)).toHaveLength(2);       // 只补传第 2、3 批账单
  expect(jobs(gw, uid).map(j => [j.id, j.state])).toEqual([[jobId, 'applied']]);
  expect(gw.db.epochOf(uid)).toBe(1);
  expect(gw.db.live(uid)).toHaveLength(1203);
  expect(await js(A, '[App.S.records.length, App.S.sync.epoch]')).toEqual([1203, 1]);
});

test('已封存、还没应用时 App 被杀：重开后直接应用同一个任务，不会当成「未开始」重新上传', async ({ openApp, gw }) => {
  const { A, ids, uid } = await setup(openApp, gw);
  const backup = await js(A, 'App.restore.exportText()');
  await addRec(A, '导出后新增', 999);
  expect(await syncNow(A)).toBe('');
  let blocked = 0;
  gw.before = e => { if (e.uid === uid && e.path === '/rest/v1/rpc/xm_restore_apply' && !blocked++) return { status: 503, body: { message: 'upstream down' } }; };
  await importViaUI(A, backup);
  await waitErr(A);
  expect(await js(A, 'App.restore.job().phase')).toBe('sealed');
  expect(jobs(gw, uid).map(j => j.state)).toEqual(['sealed']);
  await setAuto(A, true);
  const t0 = Date.now();
  await A.reload(); await A.waitForFunction(() => window.App && window.App.S && window.App.restore);
  await waitDone(A);
  for (const fn of ['xm_restore_create', 'xm_restore_stage', 'xm_restore_seal']) expect(calls(gw, uid, fn, t0)).toHaveLength(0);
  expect(calls(gw, uid, 'xm_restore_apply', t0)).toHaveLength(1);
  expect(gw.db.epochOf(uid)).toBe(1);
  expect(gw.db.live(uid)).toEqual(Object.values(ids).sort());
  expect(await notes(A)).toEqual(['午饭', '早餐', '晚饭']);
});

const OTHER = { tables: { xm_records: [rec('x1', 100, '别的设备的备份')], xm_accounts: [acc('a_cash')], xm_categories: [cat('e_food')] } };

test('确认之后另一台设备抢先恢复（epoch_changed）：停下来问；选「取消恢复」→ 云端保持另一台设备的恢复，本机跟着对齐', async ({ openApp, gw }) => {
  const { email, A, uid } = await setup(openApp, gw);
  const backup = await js(A, 'App.restore.exportText()');
  let hit = false;
  gw.before = async e => { if (!hit && e.uid === uid && e.path === '/rest/v1/rpc/xm_restore_apply') { hit = true; await serverRestore(gw, email, OTHER); } };
  await importViaUI(A, backup);
  await expect(A.locator('.rs-msg.ask')).toContainText('另一台设备也恢复了一次备份');
  expect(await notes(A)).toEqual(['午饭', '早餐', '晚饭']);              // 等用户决定期间，本机不动
  expect(await syncNow(A)).toBe('');                                     // 自动 / 手动同步都不会擅自继续
  expect(calls(gw, uid, 'xm_restore_apply')).toHaveLength(1);
  await A.click('[data-rs="cancel"]');
  await A.click('.dlg [data-r="1"]');
  await A.waitForFunction(() => !window.App.restore.pending());
  expect(jobs(gw, uid).map(j => j.state)).toEqual(['cancelled', 'applied']);   // A 的任务已取消；另一台设备的恢复保持生效
  expect(gw.db.epochOf(uid)).toBe(1);
  expect(gw.db.live(uid)).toEqual(['x1']);
  expect(await syncNow(A)).toBe('');
  expect(await notes(A)).toEqual(['别的设备的备份']);
  expect(await js(A, 'App.S.sync.epoch')).toBe(1);
});

test('确认之后另一台设备抢先恢复：选「继续用这份备份覆盖」→ 用同一个已封存任务在新版本上应用', async ({ openApp, gw }) => {
  const { email, A, ids, uid } = await setup(openApp, gw);
  const backup = await js(A, 'App.restore.exportText()');
  let hit = false;
  gw.before = async e => { if (!hit && e.uid === uid && e.path === '/rest/v1/rpc/xm_restore_apply') { hit = true; await serverRestore(gw, email, OTHER); } };
  await importViaUI(A, backup);
  await A.waitForSelector('[data-rs="cont"]');
  await A.click('[data-rs="cont"]');
  await waitDone(A);
  expect(calls(gw, uid, 'xm_restore_create')).toHaveLength(1);
  expect(gw.db.epochOf(uid)).toBe(2);
  expect(gw.db.live(uid)).toEqual(Object.values(ids).sort());
  expect(await notes(A)).toEqual(['午饭', '早餐', '晚饭']);
  expect(await js(A, 'App.S.sync.epoch')).toBe(2);
});

test('旧版备份（没有校验信息、缺少可选模块）：确认页说明清楚；恢复后预算、存钱计划、金币、猫咪都保留云端现有的，不会被清空', async ({ openApp, gw }) => {
  const { A, uid } = await setup(openApp, gw);
  const full = JSON.parse(await js(A, 'App.restore.exportText()'));
  const legacy = { v: 1, records: full.records, accounts: full.accounts, cats: full.cats };   // 只有必需模块
  await js(A, "(App.S.budget.total = 88800, App.S.saving.plans.push({ id: 'sv1', type: 'free', name: '旅行', created: '2026-10-21', done: {}, log: [], target: 1000 }), App.S.game.coins = 555, App.S.game.cats.n1 = { got: '2026-10-01', n: 2, mood: 90 }, App.changed(), 0)");
  await addRec(A, '导出后新增', 999);
  expect(await syncNow(A)).toBe('');
  const catsBefore = gw.db.rows('xm_cats', uid).map(r => [r.cat_id, r.deleted, r.n]);
  expect(catsBefore).toContainEqual(['n1', false, 2]);

  await importViaUI(A, legacy, { start: false });
  const page = A.locator('.rs-form');
  await expect(page).toContainText('旧版 App 导出的备份');
  await expect(page).toContainText('备份里没有');
  await expect(page).toContainText('预算');
  await expect(page).toContainText('保留云端现有的');
  await A.click('[data-rs="go"]');
  await waitPanel(A);
  await waitDone(A);
  expect(jobs(gw, uid)[0].scope).toEqual({ tables: ['xm_accounts', 'xm_categories', 'xm_records'], state_modules: [] });
  const st = gw.db.state(uid);
  expect([st.budget.total, st.saving.plans.length, st.game.coins]).toEqual([88800, 1, 555]);
  expect(gw.db.rows('xm_cats', uid).map(r => [r.cat_id, r.deleted, r.n])).toEqual(catsBefore);
  expect(await notes(A)).toEqual(['午饭', '早餐', '晚饭']);
  expect(await js(A, '[App.S.budget.total, App.S.saving.plans.length, App.S.game.coins, App.S.game.cats.n1 && App.S.game.cats.n1.n]')).toEqual([88800, 1, 555, 2]);
});

test('恢复前没同步的修改、恢复途中新记的账：都不会被静默丢掉 —— 恢复生效后进冲突箱（来源：导入备份），加回去后正常上云', async ({ openApp, gw }) => {
  const { A, ids, uid } = await setup(openApp, gw);
  const backup = await js(A, 'App.restore.exportText()');
  const before = await addRec(A, '恢复前没同步的', 444);                 // 没同步
  await js(A, `(() => { const r = App.S.records.find(x => x.id === ${JSON.stringify(ids.r1)}); r.note = '早餐（改过没同步）'; App.changed(); return 0; })()`);
  let during = null;
  gw.before = async e => { if (!during && e.uid === uid && e.path === '/rest/v1/rpc/xm_restore_seal') during = await addRec(A, '恢复途中记的', 555); };
  await importViaUI(A, backup);
  await waitDone(A);
  expect(gw.writes(uid, calls(gw, uid, 'xm_restore_create')[0].t)).toEqual([]);   // 恢复前后都没有把未同步的修改直接写上云
  const box = await js(A, 'App.conflicts.pending().map(c => [c.src, c.table, c.key, c.kind, c.local && c.local.note]).sort()');
  expect(box).toEqual([
    ['import', 'xm_records', before, 'add', '恢复前没同步的'],
    ['import', 'xm_records', during, 'add', '恢复途中记的'],
    ['import', 'xm_records', ids.r1, 'edit', '早餐（改过没同步）']
  ].sort());
  expect(await notes(A)).toEqual(['午饭', '早餐', '晚饭']);
  const snap = await js(A, "JSON.parse(JSON.parse(localStorage.getItem('xm_snap_rebase')).data).records.map(r => r.note).sort()");
  expect(snap).toEqual(expect.arrayContaining(['恢复前没同步的', '恢复途中记的', '早餐（改过没同步）']));
  // 加回去 → 正常同步上云（新版本号）
  await js(A, `(App.conflicts.pending().filter(c => c.key === ${JSON.stringify(during)}).forEach(c => App.conflicts.resolve(c.id, 'apply')), 0)`);
  expect(await syncNow(A)).toBe('');
  expect(gw.db.live(uid)).toEqual(Object.values(ids).concat([during]).sort());
  expect(gw.db.rows('xm_records', uid, `id = '${during}'`)[0].epoch).toBe(1);
});

test('点「开始恢复」的瞬间正好有一次自动同步：这次同步被挡住，没同步的修改不会被抢先传上去、再被备份删掉（仍然进冲突箱）', async ({ openApp, gw }) => {
  const { A, ids, uid } = await setup(openApp, gw);
  const backup = await js(A, 'App.restore.exportText()');
  const pend = await addRec(A, '没同步的', 444);
  await importViaUI(A, backup, { start: false });
  let fired = false;
  // 开始恢复时第一件事是读版本号：就在这时触发一次自动同步，并让版本号的响应慢一点
  gw.before = async e => {
    if (!fired && e.uid === uid && e.method === 'GET' && e.path === '/rest/v1/xm_meta') {
      fired = true;
      await A.evaluate(() => { window.App.cloud.sync(false); });
      await new Promise(r => setTimeout(r, 800));
    }
  };
  await A.click('[data-rs="go"]');
  await waitPanel(A);
  await waitDone(A);
  expect(fired).toBe(true);
  expect(gw.db.rows('xm_records', uid, `id = '${pend}'`)).toEqual([]);   // 从没上过云
  expect(await js(A, 'App.conflicts.pending().map(c => [c.src, c.key, c.kind])')).toEqual([['import', pend, 'add']]);
  expect(gw.db.live(uid)).toEqual(Object.values(ids).sort());
});

test('恢复已在云端生效、但这台手机存储空间不足写不了快照：本机不覆盖、提示原因；腾出空间后点「现在重试」完成对齐', async ({ openApp, gw }) => {
  const { A, ids, uid } = await setup(openApp, gw);
  const backup = await js(A, 'App.restore.exportText()');
  await addRec(A, '导出后新增', 999);
  expect(await syncNow(A)).toBe('');
  await js(A, `(() => { const raw = Storage.prototype.setItem; window.__full = true; Storage.prototype.setItem = function (k, v) { if (window.__full && k === 'xm_snap_rebase') throw new DOMException('QuotaExceededError', 'QuotaExceededError'); return raw.call(this, k, v); }; return 0; })()`);
  await importViaUI(A, backup);
  await expect(A.locator('.rs-msg.warn')).toContainText('备份已经恢复到云端，但这台手机还没更新');
  expect(gw.db.epochOf(uid)).toBe(1);
  expect(await js(A, '[App.restore.job().phase, App.S.sync.epoch]')).toEqual(['applied', 0]);
  expect(await notes(A)).toContain('导出后新增');                      // 快照没写成功 → 本机不覆盖
  await A.locator('[data-rs="cancel"]').count().then(n => expect(n).toBe(0));   // 已生效的恢复不能取消
  await js(A, '(window.__full = false, 0)');
  await A.click('[data-rs="retry"]');
  await waitDone(A);
  expect(await notes(A)).toEqual(['午饭', '早餐', '晚饭']);
  expect(await js(A, 'App.S.sync.epoch')).toBe(1);
  expect(gw.db.live(uid)).toEqual(Object.values(ids).sort());
});

test('服务器还没装恢复协议：登录状态下导入会被拒绝，提示明确，本机和云端都不动', async ({ openApp, gwBase }) => {
  const email = newEmail();
  const A = await openApp({ name: 'A', time: T, cloudUrl: gwBase.url });
  await addRec(A, '早餐', 100);
  await login(A, email, 'secret123', { signup: true });
  await setAuto(A, false);
  expect(await syncNow(A)).toBe('');
  const backup = await js(A, 'App.restore.exportText()');
  await addRec(A, '导出后新增', 999);
  expect(await syncNow(A)).toBe('');
  const uid = uidOf(gwBase, email);
  await importViaUI(A, backup, { start: false });
  await A.click('[data-rs="go"]');
  await expect(A.locator('#toast')).toContainText('云端还没升级');
  expect(await js(A, 'App.restore.pending()')).toBe(false);
  expect(await notes(A)).toEqual(['导出后新增', '早餐']);
  expect(gwBase.log.filter(l => l.uid === uid && l.path.startsWith('/rest/v1/rpc/'))).toEqual([]);
  expect(gwBase.db.live(uid)).toHaveLength(2);
});

// 大数据量：N 笔账单通过界面完整恢复一遍，记录各阶段耗时（authenticated 角色的语句超时是 8 秒，apply 在一个事务里完成）
const BIG = Number(process.env.XM_BIG_RECORDS || 10000);
test(`大数据量：${BIG} 笔账单通过界面恢复，各阶段耗时记录在测试报告里`, async ({ openApp, gw }, info) => {
  test.setTimeout(300000);
  const { A, uid } = await setup(openApp, gw);
  await js(A, `(() => { for (let i = 0; i < ${BIG}; i++) App.S.records.push({ id: 'b' + i, type: i % 7 ? 'expense' : 'income', amount: 100 + i, cat: i % 7 ? 'e_food' : 'i_salary', acc: 'a_cash', to: '', date: '2026-0' + (1 + i % 9) + '-1' + (i % 9), note: '批量账单第' + i + '笔', ts: 1700000000000 + i }); App.changed(); return 0; })()`);
  expect(await syncNow(A)).toBe('');
  const backup = await js(A, 'App.restore.exportText()');
  await addRec(A, '导出后新增', 999);
  expect(await syncNow(A)).toBe('');
  const dur = {};
  gw.after = e => { if (e.uid === uid && e.path.startsWith('/rest/v1/rpc/')) { const k = e.path.split('/').pop(); dur[k] = Math.max(dur[k] || 0, Date.now() - e.t); } };
  const t0 = Date.now();
  await importViaUI(A, backup);
  const t1 = Date.now();
  await A.waitForFunction(() => { const j = window.App.restore.job(); return !j || j.phase === 'applied'; }, null, { timeout: 240000 });
  const t2 = Date.now();
  await waitDone(A, 240000).catch(async e => { throw new Error('本机对齐没完成：' + JSON.stringify(await js(A, '[App.cloud.err, App.restore.job() && App.restore.job().phase]')) + '\n' + e.message); });
  const t3 = Date.now();
  const total = BIG + 3;
  expect(gw.db.epochOf(uid)).toBe(1);
  expect(gw.db.sql(`select count(*) from public.xm_records where user_id = '${uid}' and not deleted and epoch = 1`)).toBe(String(total));
  expect(await js(A, '[App.S.records.length, App.S.sync.epoch, App.conflicts.pending().length]')).toEqual([total, 1, 0]);
  const report = `账单 ${total} 笔：校验+确认页 ${t1 - t0}ms；上传+封存+应用 ${t2 - t1}ms（stage 单批最慢 ${dur.xm_restore_stage}ms，seal ${dur.xm_restore_seal}ms，apply ${dur.xm_restore_apply}ms）；本机对齐 ${t3 - t2}ms`;
  info.annotations.push({ type: 'timing', description: report });
  console.log('[大数据量] ' + report);
});

test('apply 撞上数据库语句超时：云端整体回滚；App 停下来说明原因（不无限自动重试），取消后云端和本机都不变', async ({ openApp, gw }) => {
  const { A, ids, uid } = await setup(openApp, gw);
  const backup = await js(A, 'App.restore.exportText()');
  const extra = await addRec(A, '导出后新增', 999);
  expect(await syncNow(A)).toBe('');
  await setAuto(A, true);
  // 与真实超时同样的响应（PostgREST 对 57014 返回 500）：大账本时 apply 超过 authenticated 角色的 8 秒限制
  gw.before = e => { if (e.uid === uid && e.path === '/rest/v1/rpc/xm_restore_apply') return { status: 500, body: { code: '57014', message: 'canceling statement due to statement timeout', hint: null, details: null } }; };
  await importViaUI(A, backup);
  await expect(A.locator('.rs-msg.err')).toContainText('备份太大');
  await A.waitForTimeout(6000);
  expect(calls(gw, uid, 'xm_restore_apply')).toHaveLength(1);           // 不会自动反复重试
  await expect(A.locator('[data-rs="retry"]')).toBeVisible();
  await A.click('[data-rs="cancel"]');
  await A.click('.dlg [data-r="1"]');
  await A.waitForFunction(() => !window.App.restore.pending());
  expect(jobs(gw, uid).map(j => j.state)).toEqual(['cancelled']);
  expect(gw.db.epochOf(uid)).toBe(0);
  expect(gw.db.live(uid)).toEqual(Object.values(ids).concat([extra]).sort());
  expect(await notes(A)).toContain('导出后新增');
});

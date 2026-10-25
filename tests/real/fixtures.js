// 真实数据库端到端测试的夹具：在通用夹具（tests/support/fixtures.js）基础上，加上
//   gw      连「加了恢复协议的库」（xm_prot）的测试网关，每个测试一个，可以装钩子
//   gwBase  连「没有恢复协议的库」（xm_base）的测试网关：模拟还没执行迁移的服务器
//   db      直接读库的工具（以超级用户身份，绕过 RLS，用来断言）
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const support = require('../support/fixtures');
const { startGateway } = require('./gateway');

const ENV = () => JSON.parse(fs.readFileSync(process.env.XM_DB_ENV, 'utf8'));
const dbUrl = (env, db) => { const u = new URL(env.superUrl); u.pathname = '/' + db; return u.toString(); };

function dbTools(env, db) {
  const sql = text => {
    const r = spawnSync('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', dbUrl(env, db)], { input: text, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('SQL 失败：' + r.stderr);
    return r.stdout.trim();
  };
  const rows = (table, uid, where = 'true') => JSON.parse(sql(`select coalesce(json_agg(t), '[]') from (select * from public.${table} t where user_id = '${uid}' and ${where}) t`) || '[]');
  const live = (uid, table = 'xm_records', key = 'id') => rows(table, uid, 'not deleted').map(r => r[key]).sort();
  const epochOf = uid => Number(sql(`select coalesce((select epoch from public.xm_meta where user_id = '${uid}'), -1)`) || -1);
  const state = uid => { const r = rows('xm_state', uid); return r[0] ? r[0].data : null; };
  return { sql, rows, live, epochOf, state };
}

const test = support.test.extend({
  realEnv: [async ({}, use) => { await use(ENV()); }, { scope: 'worker' }],
  gw: async ({ realEnv }, use) => {
    const g = await startGateway({ restUrl: realEnv.rest.xm_prot, jwtSecret: realEnv.jwtSecret, dbUrl: dbUrl(realEnv, 'xm_prot') });
    g.db = dbTools(realEnv, 'xm_prot'); g.restUrl = realEnv.rest.xm_prot;
    await use(g); await g.close();
  },
  gwBase: async ({ realEnv }, use) => {
    const g = await startGateway({ restUrl: realEnv.rest.xm_base, jwtSecret: realEnv.jwtSecret, dbUrl: dbUrl(realEnv, 'xm_base') });
    g.db = dbTools(realEnv, 'xm_base'); g.restUrl = realEnv.rest.xm_base;
    await use(g); await g.close();
  },
  oldBaseURL: async ({}, use, testInfo) => { await use(testInfo.config.metadata.oldBaseURL); }
});

// 用「另一台设备」（测试进程直接调 PostgREST）完成一次恢复；返回 apply 的结果
async function serverRestore(gw, email, backup) {
  const { planFor } = await import('../db/protocol.mjs');
  const token = gw.tokenFor(email), plan = planFor(backup), job = crypto.randomUUID();
  const rpc = async (fn, args) => {
    const r = await fetch(`${gw.restUrl}/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(args) });
    const t = await r.text(); if (r.status !== 200) throw new Error(`${fn} ${r.status} ${t}`); return JSON.parse(t);
  };
  const c = await rpc('xm_restore_create', { p_job: job, p_scope: plan.scope });
  for (const t of plan.scope.tables) await rpc('xm_restore_stage', { p_job: job, p_table: t, p_rows: plan.items[t].map(x => ({ h: x.h, row: x.row })) });
  await rpc('xm_restore_seal', { p_job: job, p_manifest: plan.manifest, p_state_patch: plan.state });
  return rpc('xm_restore_apply', { p_job: job, p_expected_epoch: c.created_epoch });
}

// 通过「云端同步」面板登录，等登录完成、第一次同步结束（成功或失败都算结束）
async function login(page, email, pw = 'secret123', { signup = false } = {}) {
  await support.settle(page);
  await page.evaluate(() => window.App.A.openCloud());
  await page.fill('#cl-email', email);
  await page.fill('#cl-pass', pw);
  await page.click(signup ? '[data-cl="up"]' : '[data-cl="in"]');
  await page.waitForFunction(() => window.App.supabase.user() && !window.App.cloud.busy && (window.App.cloud.last || window.App.cloud.err), null, { timeout: 20000 });
  await page.evaluate(() => window.App.UI.closeAll());
}

const newEmail = () => `t-${crypto.randomBytes(4).toString('hex')}@example.test`;
const uidOf = (gw, email) => gw.users.get(email.toLowerCase()).id;

module.exports = { ...support, test, serverRestore, login, newEmail, uidOf };

// 公共测试夹具：
//   openApp(opts)  打开一台「设备」（独立的浏览器 context = 独立的 localStorage），等 App 启动完成并跳过启动动画
//   cloud          一个全新的内存版假 Supabase（每个测试一份，测试之间互不影响）
// 安全护栏（每台设备自动生效）：
//   - 除了本地静态服务器和假 Supabase，任何对外请求都会被拦截并记录；测试结束时如果出现过，测试判为失败
//   - 特别地，只要有请求指向 *.supabase.co（真实生产库），测试判为失败
//   - 页面里出现的 JS 报错（pageerror / console.error）也会让测试失败，除非用 allowErrors 明确放行
'use strict';
const base = require('@playwright/test');
const { MockSupabase, MOCK_ORIGIN } = require('./mock-supabase');

const KEY = 'xiaomi_ledger_v1';

// 原生壳模拟：记录发给原生层的消息；http 消息转成 fetch（会被假 Supabase 接住），再按原生层的格式回调
const NATIVE_STUB = () => {
  window.__NATIVE_APP__ = true;
  window._msgs = [];
  window.webkit = { messageHandlers: { native: { postMessage: m => {
    window._msgs.push(JSON.parse(JSON.stringify(m)));
    if (m.type === 'http') {
      fetch(m.url, { method: m.method, headers: m.headers, body: m.body || undefined })
        .then(async r => { const buf = new Uint8Array(await r.arrayBuffer()); let s = ''; buf.forEach(b => { s += String.fromCharCode(b); }); window.App.http.done(m.id, r.status, btoa(s), ''); })
        .catch(e => window.App.http.done(m.id, 0, '', String(e)));
    }
  } } } };
};

const test = base.test.extend({
  cloud: async ({}, use) => { await use(new MockSupabase()); },

  openApp: async ({ browser, cloud }, use, testInfo) => {
    const devices = [];
    const open = async (opts = {}) => {
      const u = testInfo.project.use;
      const context = await browser.newContext({
        baseURL: u.baseURL, viewport: u.viewport, isMobile: u.isMobile, hasTouch: u.hasTouch,
        locale: u.locale, timezoneId: u.timezoneId, serviceWorkers: u.serviceWorkers
      });
      const page = await context.newPage();
      const dev = { name: opts.name || 'dev' + (devices.length + 1), context, page, errors: [], external: [], allowErrors: opts.allowErrors || null };
      devices.push(dev);

      // 1) 网络护栏
      await context.route(url => {
        const u = new URL(url);
        return !(u.origin === MOCK_ORIGIN || u.hostname === '127.0.0.1' || u.protocol === 'data:' || u.protocol === 'blob:');
      }, route => { dev.external.push(route.request().url()); return route.abort('blockedbyclient'); });
      if (opts.cloud !== false) await cloud.attach(context);

      // 2) JS 报错收集
      page.on('pageerror', e => dev.errors.push('pageerror: ' + e.message));
      // 浏览器自带的「Failed to load resource: 4xx」网络日志不是 JS 报错（测试里会故意制造 400/401/403），不计入；
      // 对外请求另有网络护栏单独检查
      page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) dev.errors.push('console.error: ' + m.text()); });

      // 3) 时钟：固定「现在」的时间（timers 照常走），或完全接管（可以快进）
      if (opts.time && opts.clock === 'install') await page.clock.install({ time: new Date(opts.time) });
      else if (opts.time) await page.clock.setFixedTime(new Date(opts.time));

      // 4) 启动前注入：测试用云端地址（永远指向假 Supabase）、原生壳、强制登录门、初始账本
      await page.addInitScript(o => {
        window.__XM_CLOUD_CFG__ = { url: o.mock };
        if (o.forceGate) window.__XM_FORCE_GATE__ = true;
        if (o.seed !== undefined && !sessionStorage.getItem('__xm_seeded')) {
          sessionStorage.setItem('__xm_seeded', '1');
          if (o.seed === null) localStorage.removeItem(o.key); else localStorage.setItem(o.key, typeof o.seed === 'string' ? o.seed : JSON.stringify(o.seed));
        }
      }, { mock: MOCK_ORIGIN, forceGate: !!opts.forceGate, seed: opts.seed, key: KEY });
      if (opts.native) await page.addInitScript(NATIVE_STUB);
      if (opts.nativeB64 !== undefined) await page.addInitScript(b64 => { window.__NATIVE_B64__ = b64; }, opts.nativeB64);
      if (opts.init) await page.addInitScript(opts.init);

      await page.goto('/index.html');
      if (opts.wait !== false) await ready(page, opts);
      return page;
    };
    open.devices = devices;
    await use(open);

    // 收尾检查
    const problems = [];
    for (const d of devices) {
      const real = d.external.filter(u => /supabase\.co/i.test(u));
      if (real.length) problems.push(`[${d.name}] 有请求发往真实 Supabase：${real.join(', ')}`);
      else if (d.external.length) problems.push(`[${d.name}] 有意外的外部请求：${d.external.join(', ')}`);
      const errs = d.allowErrors ? d.errors.filter(e => !d.allowErrors.test(e)) : d.errors;
      if (errs.length) problems.push(`[${d.name}] 页面报错：\n  ${errs.join('\n  ')}`);
      await d.context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});   // 先撤掉拦截，忽略还在路上的请求
      await d.context.close().catch(() => {});
    }
    if (problems.length) throw new Error(problems.join('\n'));
  }
});

// 等 App 启动完成，并跳过约 2 秒的启动动画
async function ready(page, opts = {}) {
  await page.waitForFunction(() => window.App && window.App.S && document.querySelector('#tabbar .tab'));
  if (opts.clock === 'install') {
    await page.evaluate(() => window.App.endSplash(true));
    await page.clock.runFor(500);
  } else {
    await page.evaluate(() => window.App.endSplash(true));
    await page.waitForFunction(() => !document.getElementById('splash'));
  }
}

// 在页面里执行表达式并返回结果（避免 evaluate 把返回的函数当成要调用的函数）
const js = (page, expr, arg) => page.evaluate(new Function('arg', 'return (' + expr + ');'), arg);

// 关掉启动后可能自动弹出的提醒卡片（预算预警、备份提醒等）
const dismissCards = page => page.evaluate(() => document.querySelectorAll('.wn, .cat-nudge').forEach(x => x.remove()));

// 通过记账面板记一笔：type 支出/收入，catId 分类，keys 键盘输入（例如 '18.5' 或 '12+3'）
async function recordViaEditor(page, { catId = 'e_food', keys = '10', type } = {}) {
  await page.click('.tab-add');
  await page.waitForSelector('.key[data-k="done"]');
  if (type) await page.click(`[data-ed="type"][data-v="${type}"]`);
  await page.click(`.cat[data-cat="${catId}"]`);
  for (const ch of keys) await page.click(`.key[data-k="${ch}"]`);
  await page.click('.key[data-k="done"]');
}

// 云端：通过「云端同步」面板登录 / 注册（和用户手动操作一样）
// 注意：App 启动后约 2.5 秒内会有几次定时刷新（预算检查、备份提醒等），刷新会重画打开着的面板、清空输入框，
// 所以先等启动阶段的定时任务跑完再填表（现象已记录在 tests/README.md 的「观察到的问题」里）
const settle = page => page.waitForFunction(() => performance.now() > 3000, null, { timeout: 10000 });

async function loginViaSheet(page, email, pw, { signup = false } = {}) {
  await settle(page);
  await page.evaluate(() => window.App.A.openCloud());
  await page.fill('#cl-email', email);
  await page.fill('#cl-pass', pw);
  await page.click(signup ? '[data-cl="up"]' : '[data-cl="in"]');
  await page.waitForFunction(() => window.App.supabase.user() && !window.App.cloud.busy && window.App.S.sync && window.App.S.sync.at, null, { timeout: 15000 });
  await page.evaluate(() => window.App.UI.closeAll());
}

// 手动同步一次并等它结束，返回错误信息（成功时为空字符串）
async function syncNow(page) {
  await page.evaluate(() => { window.App.cloud.sync(false); });
  await page.waitForFunction(() => !window.App.cloud.busy, null, { timeout: 15000 });
  return page.evaluate(() => window.App.cloud.err || '');
}

module.exports = { test, expect: base.expect, KEY, MOCK_ORIGIN, js, dismissCards, recordViaEditor, loginViaSheet, syncNow, ready, settle };

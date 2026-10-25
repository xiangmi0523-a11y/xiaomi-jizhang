// 真实数据库的端到端测试：浏览器里的 App → 测试网关 → 真实 PostgREST → 真实 PostgreSQL（含恢复协议迁移）
// 运行：npx playwright test -c playwright.real.config.js
//   全局准备：起临时 PostgreSQL + PostgREST（tests/db/env.mjs），与数据库协议测试用的是同一套
//   静态服务器：4183 = 当前分支的 www/（新版），4184 = main 上的 www/（旧版 App，验证旧版客户端的表现）
'use strict';
const { defineConfig } = require('@playwright/test');
const base = require('./playwright.config.js');

const NEW = Number(process.env.XM_REAL_PORT || 4183), OLD = NEW + 1;
module.exports = defineConfig({
  ...base,
  testDir: './tests/real',
  timeout: 90000,
  workers: 1,
  globalSetup: require.resolve('./tests/real/global-setup.js'),
  use: { ...base.use, baseURL: `http://127.0.0.1:${NEW}` },
  webServer: [
    { command: `node tests/support/server.js ${NEW}`, url: `http://127.0.0.1:${NEW}/index.html`, reuseExistingServer: false, timeout: 20000 },
    { command: `node tests/real/serve-old.js ${OLD}`, url: `http://127.0.0.1:${OLD}/index.html`, reuseExistingServer: false, timeout: 60000 }
  ],
  metadata: { oldBaseURL: `http://127.0.0.1:${OLD}` }
});

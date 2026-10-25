// 晓米记账回归测试配置
// - 用本地静态服务器打开 www/index.html（127.0.0.1，不是 localhost：这样不会注册 Service Worker）
// - 固定 iPhone 尺寸的 Chromium；时区固定为 Asia/Shanghai，保证日期相关的测试结果稳定
// - 任何发往真实 Supabase 的请求都会在测试里被拦截并判为失败（见 tests/support/fixtures.js）
'use strict';
const { defineConfig } = require('@playwright/test');

const PORT = Number(process.env.XM_TEST_PORT || 4173);

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 45000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  workers: process.env.CI ? 2 : 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: `node tests/support/server.js ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 20000
  }
});

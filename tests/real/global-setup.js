// 全局准备：起真实数据库环境，把连接信息交给测试进程；返回的函数用于全部结束后清理
'use strict';
module.exports = async () => {
  const { startEnv } = await import('../db/env.mjs');
  const env = await startEnv({ log: (...a) => console.log('[real-env]', ...a) });
  process.env.XM_DB_ENV = env.envFile;
  return async () => { await env.stop(); };
};

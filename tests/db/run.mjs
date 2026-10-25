#!/usr/bin/env node
// 数据库协议测试的启动器：起环境（见 env.mjs），用 node --test 跑 tests/db/*.test.mjs，结束后全部清理
// 参数：--migration <file>  用别的迁移文件（变异测试用）
//       其余参数原样传给 node --test（例如只跑某个文件）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEnv, ROOT } from './env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let migration = path.join(ROOT, 'supabase', 'restore_epoch.sql');
const mi = args.indexOf('--migration');
if (mi >= 0) { migration = path.resolve(args[mi + 1]); args.splice(mi, 2); }
const testFiles = args.length ? args : fs.readdirSync(HERE).filter(f => f.endsWith('.test.mjs')).sort().map(f => path.join(HERE, f));
const log = (...a) => { if (!process.env.XM_QUIET) console.error('[db-env]', ...a); };

let env = null;
const done = async code => { if (env) await env.stop(); process.exit(code); };
process.on('SIGINT', () => done(130));
process.on('uncaughtException', e => { console.error(e); done(1); });
process.on('unhandledRejection', e => { console.error(e); done(1); });

env = await startEnv({ migration, log });
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...testFiles], { stdio: 'inherit', env: { ...process.env, XM_DB_ENV: env.envFile } });
child.on('exit', code => done(code == null ? 1 : code));

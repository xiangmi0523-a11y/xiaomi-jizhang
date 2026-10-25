#!/usr/bin/env node
// 数据库协议测试的启动器：
//   1. 起一个临时 PostgreSQL 集群（或连接 XM_PG_URL 指定的现成服务器，例如 CI 里的 postgres:17 容器）
//   2. 建模拟 Supabase 的角色，再建两个库：
//        xm_base = 模拟环境 + supabase/schema.sql              （现状：没有恢复协议，用来复现问题）
//        xm_prot = 模拟环境 + supabase/schema.sql + 迁移脚本    （用来验证防护）
//   3. 为两个库各起一个真实的 PostgREST
//   4. 用 node --test 跑 tests/db/*.test.mjs，结束后全部清理
// 参数：--migration <file>  用别的迁移文件（变异测试用）
//       其余参数原样传给 node --test（例如只跑某个文件）
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
let migration = path.join(ROOT, 'supabase', 'restore_epoch.sql');
const mi = args.indexOf('--migration');
if (mi >= 0) { migration = path.resolve(args[mi + 1]); args.splice(mi, 2); }
const testFiles = args.length ? args : fs.readdirSync(HERE).filter(f => f.endsWith('.test.mjs')).sort().map(f => path.join(HERE, f));

const JWT_SECRET = 'xm-test-only-jwt-secret-0123456789abcdef';   // 只用于本地临时环境
const AUTH_PW = 'xm-test-only-authenticator';
const log = (...a) => { if (!process.env.XM_QUIET) console.error('[db-env]', ...a); };

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const pgBin = () => {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  const base = '/usr/lib/postgresql';
  const v = fs.existsSync(base) ? fs.readdirSync(base).sort((a, b) => Number(b) - Number(a))[0] : null;
  if (!v) throw new Error('找不到 PostgreSQL（设置 PG_BIN 或 XM_PG_URL）');
  return path.join(base, v, 'bin');
};

const cleanup = [];
const done = async code => { for (const f of cleanup.reverse()) { try { await f(); } catch (e) { /* ignore */ } } process.exit(code); };
process.on('SIGINT', () => done(130));
process.on('uncaughtException', e => { console.error(e); done(1); });
process.on('unhandledRejection', e => { console.error(e); done(1); });

let superUrl, pgHost, pgPort;
if (process.env.XM_PG_URL) {
  superUrl = process.env.XM_PG_URL;
  const u = new URL(superUrl); pgHost = u.hostname; pgPort = Number(u.port || 5432);
  log('使用现成的 PostgreSQL：', `${pgHost}:${pgPort}`);
} else {
  const bin = pgBin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xm-pg-'));
  const data = path.join(dir, 'data'), sock = path.join(dir, 'sock');
  fs.mkdirSync(sock);
  pgHost = '127.0.0.1'; pgPort = await freePort();
  const runAs = process.getuid && process.getuid() === 0 ? ['runuser', ['-u', 'nobody', '--']] : null;   // root 不能直接跑 postgres
  if (runAs) execFileSync('chown', ['-R', 'nobody', dir]);
  const sh = (cmd, a) => runAs ? execFileSync(runAs[0], [...runAs[1], cmd, ...a], { stdio: 'pipe' }) : execFileSync(cmd, a, { stdio: 'pipe' });
  sh(path.join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
  sh(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(dir, 'pg.log'), '-w', '-o', `-p ${pgPort} -k ${sock} -c listen_addresses=127.0.0.1 -c max_connections=200`, 'start']);
  // 清理按倒序执行：先停数据库，再删目录
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => sh(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', 'stop']));
  superUrl = `postgres://postgres@127.0.0.1:${pgPort}/postgres`;
  log('临时 PostgreSQL：', `127.0.0.1:${pgPort}`, execFileSync('psql', ['-X', '-A', '-t', '-d', superUrl, '-c', 'show server_version'], { encoding: 'utf8' }).trim());
}

const dbUrl = (db, user = null) => { const u = new URL(superUrl); u.pathname = '/' + db; if (user) { u.username = user; u.password = ''; } return u.toString(); };
const psql = (url, sqlText, { file } = {}) => {
  const a = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url];
  const r = file ? spawnSync('psql', [...a, '-f', file], { encoding: 'utf8' }) : spawnSync('psql', a, { input: sqlText, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql 失败（${file || sqlText.slice(0, 80)}）：\n${r.stderr}`);
  return r.stdout;
};

// 角色（整个集群共用）
psql(superUrl, `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit password '${AUTH_PW}'; end if;
  if not exists (select 1 from pg_roles where rolname = 'xm_owner') then create role xm_owner login bypassrls; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
`);

const SCHEMA = path.join(ROOT, 'supabase', 'schema.sql');
const EMU = path.join(HERE, 'supabase-emulation.sql');
function makeDb(name, withMigration, migrationFile = migration) {
  psql(superUrl, `drop database if exists ${name} with (force); create database ${name} owner xm_owner;`);
  psql(dbUrl(name), '', { file: EMU });
  psql(dbUrl(name, 'xm_owner'), '', { file: SCHEMA });
  if (withMigration) psql(dbUrl(name, 'xm_owner'), '', { file: migrationFile });
}
makeDb('xm_base', false);
makeDb('xm_prot', true);
log('迁移文件：', path.relative(ROOT, migration));

// PostgREST
const pgrst = execFileSync(path.join(HERE, 'get-postgrest.sh'), { encoding: 'utf8' }).trim().split('\n').pop();
const startRest = async db => {
  const port = await freePort();
  const conf = path.join(os.tmpdir(), `xm-pgrst-${db}-${port}.conf`);
  const u = new URL(superUrl); u.username = 'authenticator'; u.password = AUTH_PW; u.pathname = '/' + db;
  fs.writeFileSync(conf, [
    `db-uri = "${u.toString()}"`, 'db-schemas = "public"', 'db-anon-role = "anon"', `jwt-secret = "${JWT_SECRET}"`,
    'server-host = "127.0.0.1"', `server-port = ${port}`, 'db-pool = 20', 'log-level = "crit"'
  ].join('\n'));
  const p = spawn(pgrst, [conf], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; p.stderr.on('data', d => { err += d; });
  cleanup.push(() => { p.kill('SIGTERM'); fs.rmSync(conf, { force: true }); });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.status < 500) return `http://127.0.0.1:${port}`; } catch (e) { /* not yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('PostgREST 没有启动：' + err);
};
const rest = { xm_base: await startRest('xm_base'), xm_prot: await startRest('xm_prot') };
log('PostgREST：', execFileSync(pgrst, ['--version'], { encoding: 'utf8' }).trim(), rest);

const envFile = path.join(os.tmpdir(), `xm-db-env-${process.pid}.json`);
fs.writeFileSync(envFile, JSON.stringify({ superUrl, rest, jwtSecret: JWT_SECRET, migration, schema: SCHEMA, emulation: EMU, root: ROOT }));
cleanup.push(() => fs.rmSync(envFile, { force: true }));

const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...testFiles], { stdio: 'inherit', env: { ...process.env, XM_DB_ENV: envFile } });
child.on('exit', code => done(code == null ? 1 : code));

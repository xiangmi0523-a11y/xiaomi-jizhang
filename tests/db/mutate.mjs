#!/usr/bin/env node
// SQL 变异测试：每次把迁移脚本里的一道防护故意拆掉，跑对应的测试文件，必须失败。
// 证明测试真的在检查这道防护，而不是碰巧通过。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIG = fs.readFileSync(path.join(HERE, '..', '..', 'supabase', 'restore_epoch.sql'), 'utf8');

const M = [
  ['写入保护不检查请求头', "if v is null or v !~ '^[0-9]{1,9}$' or v::integer <> e then", 'if false then', '10-write-guard'],
  ['所有角色都走受信路径', "if current_user not in ('authenticated', 'anon') then", 'if true then', '10-write-guard'],
  ['写入检查不加共享锁', "select m.epoch into e from public.xm_meta m where m.user_id = p_uid for share;\n  if not found", "select m.epoch into e from public.xm_meta m where m.user_id = p_uid;\n  if not found", '20-concurrency'],
  ['应用不锁版本号', 'select epoch into e from public.xm_meta where user_id = uid for update;', 'select epoch into e from public.xm_meta where user_id = uid;', '20-concurrency'],
  ['应用不核对逐行结果', 'if n1 <> 0 or n2 <> 0 or n3 <> 0 then', 'if false then', '40-verify-modules'],
  ['整块设置直接覆盖（不合并）', "on conflict (user_id) do update set data = coalesce(public.xm_state.data, '{}'::jsonb) || excluded.data;", 'on conflict (user_id) do update set data = excluded.data;', '40-verify-modules'],
  ['建任务时就把版本号 +1（旧设计）', "  insert into public.xm_restore_job (job_id, user_id, state, scope, created_epoch)", "  update public.xm_meta set epoch = epoch + 1 where user_id = uid;\n  select epoch into e from public.xm_meta where user_id = uid;\n  insert into public.xm_restore_job (job_id, user_id, state, scope, created_epoch)", '30-retry-interrupt'],
  ['任务不校验所属用户', 'if not found or j.user_id <> p_uid then', 'if not found then', '50-security'],
  ['RPC 不收回 anon 权限', "revoke all on function public.xm_restore_apply(uuid, integer)         from public, anon, service_role;", "revoke all on function public.xm_restore_apply(uuid, integer)         from service_role;", '50-security'],
  ['definer 函数不固定 search_path', "create or replace function public.xm_restore_cancel(p_job uuid)\nreturns jsonb\nlanguage plpgsql\nsecurity definer\nset search_path = ''", "create or replace function public.xm_restore_cancel(p_job uuid)\nreturns jsonb\nlanguage plpgsql\nsecurity definer", '50-security'],
  ['类型检查对缺失字段不安全（NULL）', "as $$ select coalesce(pg_catalog.jsonb_typeof(p), 'missing') $$;", 'as $$ select pg_catalog.jsonb_typeof(p) $$;', '50-security'],
  ['应用后不软删除多余行', "execute format('update public.%1$I t set deleted = true where", "execute format('update public.%1$I t set deleted = deleted where", '40-verify-modules'],
  ['已应用的任务可以再次应用（不幂等）', "  if j.state = 'applied' then\n    return j.result;", "  if false then\n    return j.result;", '30-retry-interrupt']
];

const only = process.argv[2];
const results = [];
for (const [name, find, repl, file] of M) {
  if (only && !name.includes(only)) continue;
  const n = MIG.split(find).length - 1;
  if (n !== 1) { results.push([name, file, `变异无效：原文出现 ${n} 次`]); continue; }
  const tmp = path.join(os.tmpdir(), `xm-mut-${results.length}.sql`);
  fs.writeFileSync(tmp, MIG.replace(find, () => repl));   // 用函数替换，避免 $$ 被当成特殊符号
  const r = spawnSync(process.execPath, [path.join(HERE, 'run.mjs'), '--migration', tmp, path.join(HERE, file + '.test.mjs')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, XM_QUIET: '1' } });
  fs.rmSync(tmp, { force: true });
  const fails = (r.stdout.match(/^not ok .*$/gm) || []).map(l => l.replace(/^not ok \d+ - /, ''));
  results.push([name, file, r.status !== 0 && fails.length ? `已被发现（${fails.length} 项失败）：${fails[0]}` : `!!! 没被发现（exit ${r.status}）`]);
  console.log(`${r.status !== 0 && fails.length ? '✓' : '✗'} ${name} → ${file}：${results.at(-1)[2]}`);
  if (!fails.length) console.log('  stdout 末尾：' + r.stdout.slice(-400).replace(/\n/g, ' | ') + '\n  stderr 末尾：' + r.stderr.slice(-400).replace(/\n/g, ' | '));
}
const missed = results.filter(r => !r[2].startsWith('已被发现'));
console.log(`\n变异 ${results.length} 个，被测试发现 ${results.length - missed.length} 个，漏掉 ${missed.length} 个`);
process.exit(missed.length ? 1 : 0);

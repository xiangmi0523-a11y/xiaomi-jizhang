#!/usr/bin/env node
// 前端变异测试：把 www/ 复制一份，故意拆掉一处保护，用真实数据库端到端测试跑对应的用例，必须失败。
// 用法：node tests/real/mutate-frontend.js [名字关键词]
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');

const M = require('./mutations.js');
const only = process.argv[2];
const results = [];
for (const m of M) {
  if (only && !m.name.includes(only)) continue;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xm-mut-www-'));
  fs.cpSync(path.join(ROOT, 'www'), dir, { recursive: true });
  let ok = true;
  for (const [file, find, repl] of m.edits) {
    const p = path.join(dir, file), s = fs.readFileSync(p, 'utf8');
    const n = s.split(find).length - 1;
    if (n !== 1) { results.push([m.name, `变异无效：${file} 里原文出现 ${n} 次`]); ok = false; break; }
    fs.writeFileSync(p, s.replace(find, () => repl));
  }
  if (ok) {
    const r = spawnSync('npx', ['playwright', 'test', '-c', 'playwright.real.config.js', '--reporter=line', '-g', m.grep], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, XM_WWW_ROOT: dir, XM_REAL_PORT: '4193' } });
    const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '');
    const failed = /(\d+) failed/.exec(out);
    results.push([m.name, r.status !== 0 && failed ? `已被发现（${failed[1]} 项失败）` : `!!! 没被发现（exit ${r.status}）`]);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${results.at(-1)[1].startsWith('已被发现') ? '✓' : '✗'} ${m.name}：${results.at(-1)[1]}`);
}
const missed = results.filter(r => !r[1].startsWith('已被发现'));
console.log(`\n前端变异 ${results.length} 个，被发现 ${results.length - missed.length} 个，漏掉 ${missed.length} 个`);
process.exit(missed.length ? 1 : 0);

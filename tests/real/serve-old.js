// 把 main（已发布版本）上的 www/ 取出来，用同一个静态服务器提供：模拟「还没更新的旧版 App」
'use strict';
const { execSync, spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const port = process.argv[2] || '4184';
const ref = process.env.XM_OLD_REF || 'origin/main';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xm-old-www-'));
execSync(`git archive ${ref} www | tar -x -C ${dir}`, { cwd: path.resolve(__dirname, '..', '..') });
const p = spawn(process.execPath, [path.resolve(__dirname, '..', 'support', 'server.js'), port], { stdio: 'inherit', env: { ...process.env, XM_WWW_ROOT: path.join(dir, 'www') } });
const bye = () => { p.kill(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); };
process.on('SIGTERM', bye); process.on('SIGINT', bye);

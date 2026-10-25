// 测试用的「迷你 Supabase 网关」：让浏览器里的 App 连到真实的 PostgreSQL + PostgREST
//   /auth/v1/signup、/auth/v1/token（password / refresh_token）、/auth/v1/logout：在测试进程里模拟 GoTrue，签发 HS256 JWT
//   /rest/v1/*：原样转发给 PostgREST（带上 Authorization、Prefer、x-xm-epoch 等请求头）
//   CORS：像 Supabase 网关一样回显浏览器请求的头
// 还提供测试钩子：记录每个请求、在请求前插入动作（例如抢先完成一次恢复）、丢掉响应、去掉请求头。
'use strict';
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const b64u = b => Buffer.from(b).toString('base64url');
const sign = (claims, secret) => {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), body = b64u(JSON.stringify(claims));
  return head + '.' + body + '.' + crypto.createHmac('sha256', secret).update(head + '.' + body).digest('base64url');
};
const subOf = auth => { try { return JSON.parse(Buffer.from(String(auth).split('.')[1], 'base64url').toString()).sub; } catch (e) { return null; } };

function startGateway({ restUrl, jwtSecret, dbUrl, ttl = 3600 }) {
  const users = new Map();      // email -> { id, pw }
  const refresh = new Map();    // refresh_token -> { id, email }
  const gw = { log: [], before: null, after: null, stripEpoch: false, users };
  const session = (id, email) => {
    const rt = 'ref_' + crypto.randomBytes(12).toString('hex');
    refresh.set(rt, { id, email });
    const exp = Math.floor(Date.now() / 1000) + ttl;
    return { access_token: sign({ sub: id, role: 'authenticated', aud: 'authenticated', exp, email }, jwtSecret), refresh_token: rt, expires_in: ttl, expires_at: exp, token_type: 'bearer', user: { id, email } };
  };
  gw.createUser = (email, pw) => {
    const id = crypto.randomUUID();
    const r = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', dbUrl, '-c', `insert into auth.users (id, email) values ('${id}', '${email.replace(/'/g, "''")}')`], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    users.set(email.toLowerCase(), { id, pw });
    return id;
  };
  gw.tokenFor = email => { const u = users.get(email.toLowerCase()); return session(u.id, email).access_token; };

  const cors = req => ({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
    'Access-Control-Expose-Headers': 'content-range'
  });
  const readBody = req => new Promise(res => { const a = []; req.on('data', d => a.push(d)); req.on('end', () => res(Buffer.concat(a))); });

  const server = http.createServer(async (req, res) => {
    const send = (status, obj, extra = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...cors(req), ...extra }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors(req)); res.end(); return; }
    const u = new URL(req.url, 'http://x');
    const raw = await readBody(req);
    const entry = { t: Date.now(), method: req.method, path: u.pathname, query: u.search, epoch: req.headers['x-xm-epoch'], uid: subOf((req.headers.authorization || '').replace(/^Bearer /, '')), status: 0 };
    gw.log.push(entry);
    try {
      if (gw.before) { const r = await gw.before(entry, req); if (r && r.status) { entry.status = r.status; return send(r.status, r.body); } }
      if (u.pathname === '/auth/v1/signup') {
        const b = JSON.parse(raw.toString() || '{}'), email = String(b.email || '').toLowerCase();
        if (users.has(email)) return send(entry.status = 422, { msg: 'User already registered' });
        if (String(b.password || '').length < 6) return send(entry.status = 422, { msg: 'Password should be at least 6 characters.' });
        const id = gw.createUser(email, b.password);
        return send(entry.status = 200, session(id, email));
      }
      if (u.pathname === '/auth/v1/token') {
        const b = JSON.parse(raw.toString() || '{}'), g = u.searchParams.get('grant_type');
        if (g === 'password') {
          const x = users.get(String(b.email || '').toLowerCase());
          if (!x || x.pw !== b.password) return send(entry.status = 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
          return send(entry.status = 200, session(x.id, String(b.email).toLowerCase()));
        }
        const r = refresh.get(b.refresh_token);
        if (!r) return send(entry.status = 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
        refresh.delete(b.refresh_token);
        return send(entry.status = 200, session(r.id, r.email));
      }
      if (u.pathname === '/auth/v1/logout') return send(entry.status = 204);
      if (u.pathname.startsWith('/rest/v1/')) {
        const h = {};
        for (const k of ['authorization', 'content-type', 'prefer', 'accept', 'range', 'x-xm-epoch']) if (req.headers[k] != null) h[k] = req.headers[k];
        if (gw.stripEpoch) delete h['x-xm-epoch'];
        const up = await fetch(restUrl + u.pathname.slice('/rest/v1'.length) + u.search, { method: req.method, headers: h, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw });
        const text = await up.text();
        entry.status = up.status; entry.hint = (() => { try { return JSON.parse(text).hint; } catch (e) { return undefined; } })();
        if (gw.after && (await gw.after(entry)) === 'lose') { entry.lost = true; req.socket.destroy(); return; }   // 服务器已执行，但响应「丢了」
        res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json', ...cors(req) });
        res.end(text);
        return;
      }
      send(entry.status = 404, { message: 'not found' });
    } catch (e) {
      send(entry.status = 500, { message: String(e && e.message || e) });
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    gw.url = `http://127.0.0.1:${server.address().port}`;
    gw.close = () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); });
    // 便捷查询：某个用户发出的数据写请求
    gw.writes = (uid, since = 0) => gw.log.filter(l => l.uid === uid && l.t >= since && l.method !== 'GET' && /^\/rest\/v1\/xm_/.test(l.path));
    resolve(gw);
  }));
}

module.exports = { startGateway, sign };

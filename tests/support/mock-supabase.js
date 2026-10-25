// 内存版「假 Supabase」：只在测试进程里存在，不连接任何真实服务器、不碰真实用户数据
// 模拟 App 用到的那一部分接口：
//   GoTrue  POST /auth/v1/signup、/auth/v1/token?grant_type=password|refresh_token、/auth/v1/logout
//   PostgREST GET / POST(upsert, on_conflict) / PATCH(…=in.(…)) /rest/v1/xm_*
// 行为尽量贴近线上：
//   - 每行都有 user_id；只能读写自己的行（相当于 RLS 的 (select auth.uid()) = user_id）
//   - 插入 / 更新时自动刷新 updated_at（相当于 *_touch 触发器），时间戳是 UTC 字符串，严格递增
//   - 没带 apikey、或把 publishable key 当 Bearer 令牌用，都会被拒绝
'use strict';

const MOCK_ORIGIN = 'https://mock-supabase.test';
const TABLE_KEYS = { xm_records: 'id', xm_accounts: 'id', xm_categories: 'id', xm_cats: 'cat_id', xm_state: null };

class MockSupabase {
  constructor() {
    this.users = new Map();      // email -> { id, pw }
    this.tokens = new Map();     // access_token -> uid
    this.refresh = new Map();    // refresh_token -> uid
    this.tables = {};            // name -> Map(rowKey -> row)
    Object.keys(TABLE_KEYS).forEach(t => { this.tables[t] = new Map(); });
    this.log = [];               // 每个请求：{ method, path, apikey, auth, status }
    this.lastMicros = 0;
    this.seq = 0;
    this.offline = false;        // 设为 true 时模拟断网（请求直接失败）
  }

  // 严格递增的 UTC 时间戳，格式与 Supabase 返回的 timestamptz 一致
  stamp() {
    const now = Date.now() * 1000;
    this.lastMicros = Math.max(now, this.lastMicros + 1);
    const ms = Math.floor(this.lastMicros / 1000), us = String(this.lastMicros % 1000).padStart(3, '0');
    return new Date(ms).toISOString().replace('Z', '') + us + '+00:00';
  }

  session(uid, email, expiresIn = 3600) {
    const at = 'tok_' + (++this.seq) + '_' + Math.random().toString(36).slice(2);
    const rt = 'ref_' + this.seq + '_' + Math.random().toString(36).slice(2);
    this.tokens.set(at, uid); this.refresh.set(rt, uid);
    return { access_token: at, refresh_token: rt, expires_in: expiresIn, expires_at: Math.floor(Date.now() / 1000) + expiresIn, token_type: 'bearer', user: { id: uid, email } };
  }

  // 直接造一个账号（测试准备数据用）
  createUser(email, pw) {
    const id = '00000000-0000-4000-8000-' + String(this.users.size + 1).padStart(12, '0');
    this.users.set(email.toLowerCase(), { id, pw });
    return id;
  }
  uidOf(email) { const u = this.users.get(email.toLowerCase()); return u && u.id; }
  // 查看某个用户在某张表里的行（测试断言用，绕过 RLS）
  rows(table, uid) { return Array.from(this.tables[table].values()).filter(r => !uid || r.user_id === uid); }
  revokeAllTokens() { this.tokens.clear(); }

  handle(method, url, headers, bodyText) {
    const u = new URL(url);
    const h = {}; Object.keys(headers || {}).forEach(k => { h[k.toLowerCase()] = headers[k]; });
    const entry = { method, path: u.pathname, apikey: h.apikey || '', auth: (h.authorization || '').slice(0, 12), status: 0 };
    this.log.push(entry);
    const out = (status, obj) => { entry.status = status; return { status, body: obj === undefined ? '' : JSON.stringify(obj) }; };

    if (!h.apikey) return out(401, { message: 'No API key found in request' });
    if (/^Bearer sb_/.test(h.authorization || '')) return out(401, { message: 'Invalid JWT: publishable keys cannot be used as Bearer tokens' });
    let uid = null;
    if (h.authorization && h.authorization.startsWith('Bearer ')) {
      uid = this.tokens.get(h.authorization.slice(7));
      if (!uid) return out(401, { message: 'JWT expired' });
    }
    let body = null;
    try { body = bodyText ? JSON.parse(bodyText) : null; } catch (e) { return out(400, { message: 'bad json' }); }

    const p = u.pathname, q = u.searchParams;
    if (p === '/auth/v1/signup' && method === 'POST') {
      const email = String(body.email || '').toLowerCase();
      if (this.users.has(email)) return out(422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' });
      if (String(body.password || '').length < 6) return out(422, { msg: 'Password should be at least 6 characters.' });
      const id = this.createUser(email, body.password);
      return out(200, this.session(id, email));
    }
    if (p === '/auth/v1/token' && method === 'POST') {
      const g = q.get('grant_type');
      if (g === 'password') {
        const email = String(body.email || '').toLowerCase(), user = this.users.get(email);
        if (!user || user.pw !== body.password) return out(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
        return out(200, this.session(user.id, email));
      }
      if (g === 'refresh_token') {
        const rid = this.refresh.get(body && body.refresh_token);
        if (!rid) return out(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Refresh Token Not Found' });
        this.refresh.delete(body.refresh_token);
        const email = Array.from(this.users.entries()).find(([, v]) => v.id === rid)[0];
        return out(200, this.session(rid, email));
      }
      return out(400, { error: 'unsupported_grant_type' });
    }
    if (p === '/auth/v1/logout') { if (uid) this.tokens.delete(h.authorization.slice(7)); return out(204); }

    const m = p.match(/^\/rest\/v1\/(xm_\w+)$/);
    if (!m || !(m[1] in TABLE_KEYS)) return out(404, { message: 'Could not find the table' });
    const table = m[1], key = TABLE_KEYS[table], store = this.tables[table];
    if (!uid) return out(401, { code: '42501', message: 'permission denied for table ' + table });
    const rk = row => (key ? row.user_id + '|' + row[key] : row.user_id);

    if (method === 'GET') {
      let list = Array.from(store.values()).filter(r => r.user_id === uid);   // RLS
      const gt = q.get('updated_at');
      if (gt) { const v = gt.replace(/^gt\./, ''); list = list.filter(r => r.updated_at > v); }
      list.sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0));
      const off = Number(q.get('offset') || 0), lim = Number(q.get('limit') || 1000);
      list = list.slice(off, off + lim);
      const sel = q.get('select');
      if (sel && sel !== '*') { const cols = sel.split(','); list = list.map(r => { const o = {}; cols.forEach(c => { o[c] = r[c]; }); return o; }); }
      return out(200, JSON.parse(JSON.stringify(list)));
    }
    if (method === 'POST') {
      const rows = Array.isArray(body) ? body : [body];
      if (rows.some(r => r.user_id !== uid)) return out(403, { code: '42501', message: 'new row violates row-level security policy' });
      const ts = this.stamp(), back = [];
      rows.forEach(r => {
        const prev = store.get(rk(r));
        const row = Object.assign({}, prev || { deleted: false }, JSON.parse(JSON.stringify(r)), { updated_at: ts });
        store.set(rk(row), row); back.push(row);
      });
      return out(201, JSON.parse(JSON.stringify(back)));
    }
    if (method === 'PATCH') {
      let col = null, vals = [];
      q.forEach((v, k) => { if (v.startsWith('in.')) { col = k; vals = Array.from(v.matchAll(/"([^"]*)"/g)).map(x => x[1]); } });
      if (!col) return out(400, { message: 'PATCH needs a filter' });
      const ts = this.stamp(), back = [];
      store.forEach(r => {
        if (r.user_id === uid && vals.includes(String(r[col]))) { Object.assign(r, body, { updated_at: ts }); back.push(r); }
      });
      return out(200, JSON.parse(JSON.stringify(back)));
    }
    return out(405, { message: 'method not allowed' });
  }

  // 挂到一个浏览器 context 上：所有发往 MOCK_ORIGIN 的请求都由这里回答
  async attach(context) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
    await context.route(MOCK_ORIGIN + '/**', async route => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (this.offline) return route.abort('internetdisconnected');
      const r = this.handle(req.method(), req.url(), await req.allHeaders(), req.postData());
      return route.fulfill({ status: r.status, headers: Object.assign({ 'Content-Type': 'application/json' }, cors), body: r.body });
    });
  }
}

module.exports = { MockSupabase, MOCK_ORIGIN };

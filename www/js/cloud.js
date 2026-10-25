/* 晓米记账 · 云端同步（Supabase）
 *
 * - 用 Supabase 官方 REST 接口：认证走 /auth/v1（GoTrue），数据走 /rest/v1（PostgREST）。
 * - 新版 Publishable key（sb_publishable_…）只放在 apikey 请求头里；它不是 JWT，不能放进 Authorization。
 *   登录后 Authorization 里放的是用户自己的 access_token，数据库靠它做行级安全（RLS），只能看到自己的数据。
 * - 在 App 里网络请求交给 iOS 原生层（URLSession）发，不受网页跨域限制。
 * - 同步方式：每张表按行做增量同步。本地记住「上次同步时每一行的指纹」，指纹变了就上传；
 *   云端按 updated_at 拉取别的设备改过的行；本地删掉的行在云端标记 deleted = true。
 */
(() => {
  'use strict';
  const App = window.App, U = App.U, UI = App.UI, A = App.A, esc = U.esc;

  const CFG = {
    url: 'https://vpgqzdkpoidudibsquhx.supabase.co',
    key: 'sb_publishable_vkALaVUKNtM4smlwr75SjQ_dsx2SB2_'
  };
  if (window.__XM_CLOUD_CFG__) Object.assign(CFG, window.__XM_CLOUD_CFG__);   // 仅测试时覆盖

  /* =================== 网络：App 里走原生 URLSession，浏览器里走 fetch =================== */
  const H = App.http = { seq: 0, wait: {} };
  H.request = (method, url, headers, body) => {
    if (!(window.__NATIVE_APP__ && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native)) {
      return fetch(url, { method, headers, body: body == null ? undefined : body })
        .then(async r => ({ status: r.status, text: await r.text() }));
    }
    return new Promise((res, rej) => {
      const id = 'h' + (++H.seq) + '_' + Date.now().toString(36);
      const t = setTimeout(() => { delete H.wait[id]; rej(new Error('网络超时，请检查网络后再试')); }, 35000);
      H.wait[id] = { res, rej, t };
      App.native('http', { id, method, url, headers, body: body == null ? null : body });
    });
  };
  // 原生层回调：body 用 base64 传回来，避免中文、换行在传递中出问题
  H.done = (id, status, b64, err) => {
    const w = H.wait[id]; if (!w) return;
    delete H.wait[id]; clearTimeout(w.t);
    if (!status) { w.rej(new Error(err || '网络连接失败')); return; }
    let text = '';
    try { const bin = atob(b64 || ''); text = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); } catch (e) { text = ''; }
    w.res({ status, text });
  };

  /* =================== Supabase 客户端（认证 + 数据） =================== */
  const SB = App.supabase = {};
  const SKEY = 'xm_supabase_session';
  let session = null;
  try { session = JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch (e) { session = null; }
  const saveSession = s => {
    session = s;
    try { if (s) localStorage.setItem(SKEY, JSON.stringify(s)); else localStorage.removeItem(SKEY); } catch (e) { /* ignore */ }
  };
  SB.user = () => (session && session.user) || null;

  const errText = (j, status) => {
    const m = (j && (j.msg || j.message || j.error_description || j.error)) || '';
    if (/invalid login credentials/i.test(m)) return '邮箱或密码不对';
    if (/email not confirmed/i.test(m)) return '邮箱还没确认：请先点一下注册确认邮件里的链接';
    if (/already registered|already been registered|user_already_exists/i.test(m)) return '这个邮箱已经注册过了，直接登录就行';
    if (/password should be at least/i.test(m)) return '密码至少 6 位';
    if (/rate limit/i.test(m)) return '操作太频繁了，稍等一会儿再试';
    if (/relation .* does not exist|could not find the table/i.test(m)) return '云端还没建表：请先在 Supabase 的 SQL Editor 里运行建表脚本';
    if (/jwt expired/i.test(m)) return '登录已过期，请重新登录';
    return m || ('请求失败（' + status + '）');
  };

  // 统一发请求：apikey 永远带上；需要登录的接口再带上用户自己的 access_token
  SB.call = async (method, path, { body, headers = {}, auth = true } = {}) => {
    const h = Object.assign({ apikey: CFG.key, 'Content-Type': 'application/json' }, headers);
    if (auth) {
      await SB.ensureToken();
      if (!session) throw new Error('请先登录');
      h.Authorization = 'Bearer ' + session.access_token;
    }
    const r = await H.request(method, CFG.url + path, h, body == null ? null : JSON.stringify(body));
    let j = null;
    try { j = r.text ? JSON.parse(r.text) : null; } catch (e) { j = null; }
    if (r.status === 401 && auth && session && !SB._retried) {   // access_token 过期：刷新一次再试
      SB._retried = true;
      try { await SB.refresh(true); return await SB.call(method, path, { body, headers, auth }); } finally { SB._retried = false; }
    }
    if (r.status < 200 || r.status >= 300) { const e = new Error(errText(j, r.status)); e.status = r.status; throw e; }
    return j;
  };

  const takeSession = j => {
    if (!j || !j.access_token) return false;
    saveSession({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || (Math.floor(Date.now() / 1000) + (j.expires_in || 3600)), user: { id: j.user.id, email: j.user.email } });
    return true;
  };

  SB.signUp = async (email, password) => {
    const j = await SB.call('POST', '/auth/v1/signup', { body: { email, password }, auth: false });
    return takeSession(j) ? 'in' : 'confirm';   // 项目开了「邮箱确认」时不会直接给登录态
  };
  SB.signIn = async (email, password) => {
    const j = await SB.call('POST', '/auth/v1/token?grant_type=password', { body: { email, password }, auth: false });
    if (!takeSession(j)) throw new Error('登录失败');
  };
  SB.refresh = async force => {
    if (!session || !session.refresh_token) return;
    if (!force && session.expires_at - 90 > Date.now() / 1000) return;
    try {
      const j = await SB.call('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: session.refresh_token }, auth: false });
      takeSession(j);
    } catch (e) {
      if (e.status === 400 || e.status === 401) { saveSession(null); C.paint(); throw new Error('登录已过期，请重新登录'); }
      throw e;
    }
  };
  let refreshing = null;
  SB.ensureToken = () => { if (!refreshing) refreshing = SB.refresh(false).finally(() => { refreshing = null; }); return refreshing; };
  SB.signOut = async () => {
    try { if (session) await SB.call('POST', '/auth/v1/logout', {}); } catch (e) { /* 离线也照样退出 */ }
    saveSession(null);
  };

  // PostgREST：查询 / 写入
  SB.select = (table, query) => SB.call('GET', `/rest/v1/${table}?${query}`);
  SB.upsert = (table, rows, conflict) => SB.call('POST', `/rest/v1/${table}?on_conflict=${conflict}`, { body: rows, headers: { Prefer: 'resolution=merge-duplicates,return=representation' } });
  SB.markDeleted = (table, keyCol, keys) => {
    const list = keys.map(k => '"' + String(k).replace(/["\\]/g, '') + '"').join(',');
    return SB.call('PATCH', `/rest/v1/${table}?${keyCol}=in.(${encodeURIComponent(list)})`, { body: { deleted: true }, headers: { Prefer: 'return=representation' } });
  };

  /* =================== 同步 =================== */
  const C = App.cloud = { busy: false };
  const hash = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
  const meta = () => {
    const S = App.S;
    if (!S.sync || typeof S.sync !== 'object' || S.sync.uid !== (SB.user() && SB.user().id)) S.sync = { uid: SB.user() ? SB.user().id : '', t: {}, at: 0 };
    return S.sync;
  };
  const pick = (o, keys) => { const out = {}; Object.keys(o).forEach(k => { if (!keys.includes(k)) out[k] = o[k]; }); return out; };
  const dOrNull = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);

  // 每张表：本地怎么列出来、怎么转成云端的行、怎么从行还原、怎么写回本地
  const TABLES = [
    {
      name: 'xm_records', key: 'id',
      list: () => App.S.records,
      toRow: r => ({ id: r.id, type: r.type, amount: r.amount, cat: r.cat || '', acc: r.acc || '', to_acc: r.to || '', date: r.date, note: r.note || '', ts: r.ts || 0, rec: r.rec || null,
        extra: pick(r, ['id', 'type', 'amount', 'cat', 'acc', 'to', 'date', 'note', 'ts', 'rec']) }),
      fromRow: w => Object.assign({}, w.extra || {}, { id: w.id, type: w.type, amount: Number(w.amount), cat: w.cat || '', acc: w.acc || '', to: w.to_acc || '', date: String(w.date).slice(0, 10), note: w.note || '', ts: Number(w.ts) || 0 }, w.rec ? { rec: w.rec } : {}),
      write: list => { App.S.records = list; }
    },
    {
      name: 'xm_accounts', key: 'id',
      list: () => App.S.accounts.map((a, i) => Object.assign({}, a, { _sort: i })),
      toRow: a => ({ id: a.id, name: a.name, type: a.type, init: a.init || 0, hidden: !!a.hidden, sort: a._sort, extra: pick(a, ['id', 'name', 'type', 'init', 'hidden', '_sort']) }),
      fromRow: w => Object.assign({}, w.extra || {}, { id: w.id, name: w.name || '账户', type: w.type || 'other', init: Number(w.init) || 0, _sort: w.sort }, w.hidden ? { hidden: true } : {}),
      write: list => { App.S.accounts = list.sort((a, b) => (a._sort || 0) - (b._sort || 0)).map(a => { const o = Object.assign({}, a); delete o._sort; return o; }); }
    },
    {
      name: 'xm_categories', key: 'id',
      list: () => ['expense', 'income'].flatMap(k => App.S.cats[k].map((c, i) => Object.assign({}, c, { _kind: k, _sort: i }))),
      toRow: c => ({ id: c.id, kind: c._kind, name: c.name, icon: c.icon, hidden: !!c.hidden, sort: c._sort, extra: pick(c, ['id', 'name', 'icon', 'hidden', '_kind', '_sort']) }),
      fromRow: w => Object.assign({}, w.extra || {}, { id: w.id, name: w.name || '分类', icon: U.cleanIcon(w.icon), _kind: w.kind === 'income' ? 'income' : 'expense', _sort: w.sort }, w.hidden ? { hidden: true } : {}),
      write: list => {
        ['expense', 'income'].forEach(k => {
          const part = list.filter(c => c._kind === k).sort((a, b) => (a._sort || 0) - (b._sort || 0)).map(c => { const o = Object.assign({}, c); delete o._kind; delete o._sort; return o; });
          if (part.length) App.S.cats[k] = part;
        });
      }
    },
    {
      name: 'xm_cats', key: 'cat_id',
      list: () => Object.keys(App.S.game.cats).map(id => Object.assign({ id }, App.S.game.cats[id])),
      toRow: c => ({ cat_id: c.id, got: dOrNull(c.got), n: c.n || 1, mood: typeof c.mood === 'number' ? c.mood : null, fed: dOrNull(c.fed), extra: pick(c, ['id', 'got', 'n', 'mood', 'fed']) }),
      fromRow: w => { const o = Object.assign({}, w.extra || {}, { id: w.cat_id, got: w.got ? String(w.got).slice(0, 10) : U.today(), n: w.n || 1 }); if (w.mood != null) o.mood = w.mood; if (w.fed) o.fed = String(w.fed).slice(0, 10); return o; },
      write: list => { const m = {}; list.forEach(c => { const o = Object.assign({}, c); delete o.id; m[c.id] = o; }); App.S.game.cats = m; }
    }
  ];
  const keyOf = (t, row) => row[t.key];

  // 其余设置的整体快照（不含只属于这台手机的：密码锁、面容 ID、备份文件夹、提醒、底栏样式…）
  const LOCAL_ONLY = ['pin', 'bio', 'backup', 'remind', 'tabStyle', 'lastAcc', 'ui31', 'rcSkin', 'uiZoom', 'sound'];
  const stateOut = () => {
    const S = App.S, g = Object.assign({}, S.game); delete g.cats;
    const settings = pick(S.settings, LOCAL_ONLY);
    return { budget: S.budget, recurring: S.recurring, game: g, smart: S.smart, saving: S.saving, settings, created: S.created };
  };
  const stateIn = d => {
    const S = App.S;
    ['budget', 'recurring', 'smart', 'saving'].forEach(k => { if (d[k] != null) S[k] = d[k]; });
    if (d.game) S.game = Object.assign({}, d.game, { cats: S.game.cats });
    if (d.settings) {
      const mine = {};
      LOCAL_ONLY.forEach(k => { if (k in S.settings) mine[k] = S.settings[k]; });
      S.settings = Object.assign({}, S.settings, d.settings, mine);
    }
    if (d.created) S.created = d.created;
    const keep = S.sync;
    App.S = App.normalize(S); App.S.sync = keep;
  };

  const rowHash = (t, row) => hash(JSON.stringify(row));

  // 拉取某张表在 since 之后改过的所有行（分页）
  const pullSince = async (t, since) => {
    const out = [];
    for (let off = 0; off < 100000; off += 1000) {
      const q = `select=*&order=updated_at.asc&limit=1000&offset=${off}` + (since ? `&updated_at=gt.${encodeURIComponent(since)}` : '');
      const rows = await SB.select(t.name, q);
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
  };
  // 时间戳直接按字符串比较：Supabase 返回的都是同一种 UTC 格式（Safari 解析 6 位小数秒不一定可靠）
  const later = (a, b) => (!a ? b : !b ? a : (b > a ? b : a));

  const syncTable = async (t, stat) => {
    const m = meta(), tm = m.t[t.name] || (m.t[t.name] = { since: '', h: {}, init: false });
    const first = !tm.init;   // 这台手机第一次和云端对账：云端已有的行以云端为准
    const local = t.list(), map = new Map();
    local.forEach(item => map.set(keyOf(t, t.toRow(item)), item));
    let since = tm.since, changedLocal = false;

    // 1) 先拉：别的设备改过的行
    const remote = await pullSince(t, tm.since);
    remote.forEach(w => {
      since = later(since, w.updated_at);
      const k = w[t.key], cur = map.get(k);
      const curHash = cur ? rowHash(t, t.toRow(cur)) : null;
      const editedHere = cur ? (!first && curHash !== tm.h[k]) : false;
      if (w.deleted) {
        if (cur && !editedHere) { map.delete(k); changedLocal = true; stat.down++; }
        delete tm.h[k];
        return;
      }
      if (editedHere) return;                          // 两边都改了：以这台手机为准，下面会上传
      const item = t.fromRow(w), h = rowHash(t, t.toRow(item));
      // 这台手机上已经删掉了：云端这行没再被别的设备改过 → 保持删除（下面会把删除传上去）；
      // 云端在那之后又被改过 → 以云端为准把它找回来，免得误删别人刚改的内容
      if (!cur && tm.h[k] !== undefined && !first && tm.h[k] === h) return;
      if (!cur || curHash !== h) { map.set(k, item); changedLocal = true; stat.down++; }
      tm.h[k] = h;
    });
    if (changedLocal) t.write(Array.from(map.values()));

    // 2) 再推：本地新增 / 修改的行
    const uid = SB.user().id, now = t.list(), present = new Set();
    const ups = [];
    now.forEach(item => {
      const row = t.toRow(item), k = row[t.key]; present.add(k);
      const h = rowHash(t, row);
      if (tm.h[k] !== h) ups.push({ row: Object.assign({ user_id: uid }, row, { deleted: false }), k, h });
    });
    for (let i = 0; i < ups.length; i += 500) {
      const part = ups.slice(i, i + 500);
      await SB.upsert(t.name, part.map(x => x.row), 'user_id,' + t.key);
      part.forEach(x => { tm.h[x.k] = x.h; });
      stat.up += part.length;
    }
    // 3) 本地删掉的行：云端标记 deleted
    const gone = Object.keys(tm.h).filter(k => !present.has(k));
    for (let i = 0; i < gone.length; i += 100) {
      const part = gone.slice(i, i + 100);
      await SB.markDeleted(t.name, t.key, part);
      part.forEach(k => { delete tm.h[k]; });
      stat.del += part.length;
    }
    // 只用「拉下来的行」推进同步位置：自己刚上传的行下次会再拉到一次（指纹相同，直接跳过），
    // 这样即使别的设备恰好在中间写入，也不会被漏掉
    tm.since = since; tm.init = true;
    return changedLocal;
  };

  const syncState = async stat => {
    const m = meta(), sm = m.t.xm_state || (m.t.xm_state = { since: '', h: '', rh: '', init: false });
    const first = !sm.init;
    const localH = () => hash(JSON.stringify(stateOut()));
    const rows = await SB.select('xm_state', 'select=data,updated_at');
    const w = rows && rows[0];
    let changedLocal = false;
    if (w && (!sm.since || w.updated_at > sm.since)) {
      sm.since = w.updated_at;
      const rh = hash(JSON.stringify(w.data || {}));
      const editedHere = !first && localH() !== sm.h;
      if (rh !== sm.rh && !editedHere) { stateIn(w.data || {}); changedLocal = true; stat.down++; }
      sm.rh = rh;
      if (!editedHere) sm.h = localH();
    }
    if (!w || localH() !== sm.h) {
      const back = await SB.upsert('xm_state', [{ user_id: SB.user().id, data: stateOut() }], 'user_id');
      if (back && back[0]) sm.rh = hash(JSON.stringify(back[0].data || {}));   // 云端存的样子（jsonb 会重排字段）
      sm.h = localH();
      stat.up++;
    }
    sm.init = true;
    return changedLocal;
  };

  let again = false, timer = null;
  C.sync = async (manual) => {
    if (!SB.user()) { if (manual) UI.toast('请先登录'); return false; }
    if (C.busy) { again = true; return false; }
    C.busy = true; C.err = ''; C.paint();
    const stat = { up: 0, down: 0, del: 0 };
    let changed = false;
    try {
      for (const t of TABLES) changed = (await syncTable(t, stat)) || changed;
      changed = (await syncState(stat)) || changed;
      meta().at = Date.now();
      C.last = stat;
      if (manual) UI.toast(stat.up + stat.down + stat.del ? `同步完成：上传 ${stat.up} · 下载 ${stat.down}${stat.del ? ' · 删除 ' + stat.del : ''}` : '已经是最新的了', 2200, 'gold');
    } catch (e) {
      C.err = e.message || String(e);
      if (manual) UI.toast('同步失败：' + C.err, 3200);
    } finally {
      C.busy = false;
      quiet = true; App.flush(); quiet = false;   // 保存同步记录（这次保存不再触发同步）
      if (changed) App.render(true);
      C.paint();
      if (again) { again = false; C.schedule(1500); }
    }
    return !C.err;
  };
  C.schedule = ms => {
    if (!SB.user() || App.S.settings.cloudAuto === false) return;
    clearTimeout(timer); timer = setTimeout(() => C.sync(false), ms == null ? 5000 : ms);
  };

  // 有改动就（5 秒后）自动同步；回到前台时也同步一次
  let quiet = false;
  const flush = App.flush;
  App.flush = () => { flush(); if (!quiet) C.schedule(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) C.schedule(800); });
  window.addEventListener('load', () => C.schedule(3500));

  /* =================== 界面 =================== */
  const when = t => {
    if (!t) return '还没同步过';
    const d = new Date(t), s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return '刚刚同步';
    if (s < 3600) return Math.round(s / 60) + ' 分钟前同步';
    return (U.ymd(d) === U.today() ? '今天 ' : U.md(U.ymd(d)) + ' ') + U.pad(d.getHours()) + ':' + U.pad(d.getMinutes()) + ' 同步';
  };
  C.status = () => {
    if (!SB.user()) return '未登录';
    if (C.busy) return '同步中…';
    if (C.err) return '同步失败';
    return when(App.S.sync && App.S.sync.at);
  };

  let sheet = null;
  C.paint = () => { if (sheet && !sheet.closed) sheet.update(); };

  A.openCloud = () => {
    sheet = UI.sheet({
      title: '云端同步', cls: 'tall', autoRefresh: true,
      render: () => {
        const u = SB.user();
        if (!u) {
          return `<div class="form cl-form">
            <div class="cl-hero">${App.catArt.svg('n1', { head: true, w: 64, mood: 'happy' })}<p>登录后，账单、账户、分类、猫咪和各种设置都会同步到你自己的 Supabase 云端，换手机、删 App 都能找回来。</p></div>
            <label class="field"><span>邮箱</span><input id="cl-email" type="email" autocomplete="username" placeholder="you@example.com" value="${esc(C._email || '')}"></label>
            <label class="field"><span>密码</span><input id="cl-pass" type="password" autocomplete="current-password" placeholder="至少 6 位"></label>
            <button class="btn primary wide" data-cl="in">登录</button>
            <button class="btn wide" data-cl="up">注册新账号</button>
            <p class="hint">第一次用先点「注册新账号」。如果 Supabase 项目开着「邮箱确认」，会收到一封确认邮件，点完里面的链接再回来登录。<br>只有你自己能看到你的数据：云端每张表都开了行级安全（RLS）。</p>
          </div>`;
        }
        const m = App.S.sync || {}, last = C.last;
        return `<div class="form cl-form">
          <div class="cl-card"><div class="cl-av">${App.catArt.svg(App.budget.catId(), { head: true, w: 54, mood: C.err ? 'worried' : 'happy' })}</div>
            <div class="cl-who"><b>${esc(u.email || '已登录')}</b><span class="${C.err ? 'r' : ''}">${esc(C.status())}</span></div></div>
          ${C.err ? `<p class="hint cl-err">${esc(C.err)}</p>` : ''}
          ${last ? `<p class="hint">上次：上传 ${last.up} · 下载 ${last.down}${last.del ? ' · 删除 ' + last.del : ''}</p>` : ''}
          <button class="btn primary wide" data-cl="sync" ${C.busy ? 'disabled' : ''}>${C.busy ? '同步中…' : '立即同步'}</button>
          <button class="field cl-toggle" data-cl="auto"><span>有改动时自动同步</span><span class="switch${App.S.settings.cloudAuto === false ? '' : ' on'}"><i></i></span></button>
          <p class="hint">在任何一台手机上登录同一个账号，账单会自动合并。两台手机同时改了同一笔，以最后同步的那台为准。${m.at ? '' : '第一次同步会把这台手机里的全部数据上传。'}</p>
          <button class="btn danger wide" data-cl="out">退出登录</button>
        </div>`;
      },
      onMount: h => {
        h.body.addEventListener('click', async e => {
          const b = e.target.closest('[data-cl]'); if (!b) return;
          const a = b.dataset.cl;
          if (a === 'in' || a === 'up') {
            const email = h.body.querySelector('#cl-email').value.trim(), pass = h.body.querySelector('#cl-pass').value;
            C._email = email;
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { UI.toast('请填写正确的邮箱'); return; }
            if (pass.length < 6) { UI.toast('密码至少 6 位'); return; }
            b.disabled = true; b.textContent = a === 'in' ? '登录中…' : '注册中…';
            try {
              if (a === 'up') {
                const r = await SB.signUp(email, pass);
                if (r === 'confirm') { UI.toast('注册成功！请去邮箱点确认链接，然后回来登录', 4200); h.update(); return; }
              } else await SB.signIn(email, pass);
              UI.toast('登录成功，正在同步…', 2000, 'gold');
              h.update();
              await C.sync(true);
            } catch (er) { UI.toast(er.message || '失败了，再试一次', 3200); h.update(); }
          } else if (a === 'sync') C.sync(true);
          else if (a === 'auto') { App.S.settings.cloudAuto = App.S.settings.cloudAuto === false; App.changed(); h.update(); }
          else if (a === 'out') {
            await A.logout(); if (!sheet || sheet.closed) return; h.update();
          }
        });
      },
      onClose: () => { sheet = null; }
    });
  };
})();

/* 晓米记账 · 登录门：没登录时先进「晓米客栈」的登录 / 注册页，登录后才能进入主界面
 * - 邮箱 + 密码，走 Supabase Auth（App.supabase，见 cloud.js）
 * - 第一次在这台手机登录：手机里已有的账本会自动并进这个账号并上传（旧数据自动绑定到你的 user_id）
 * - 退出登录：先在「文件 → 晓米记账 → 自动备份」留一份操作前备份，再清空这台手机上的账本（云端的数据还在），
 *   这样别人在这台手机上登录，看不到你的账
 */
(() => {
  'use strict';
  const App = window.App, U = App.U, UI = App.UI, A = App.A, esc = U.esc;
  const G = App.authGate = { el: null };
  const SB = () => App.supabase;

  // 只在 App 里启用（浏览器里预览 / 自动化测试时不拦截；测试时可以用 __XM_FORCE_GATE__ 强制打开）
  G.enabled = () => location.protocol === 'xiaomi:' || !!window.__XM_FORCE_GATE__;
  G.needed = () => G.enabled() && !SB().user();

  let mode = 'in', busy = false, email = '', showPw = false, note = '';

  const paw = c => `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="${c}"><ellipse cx="12" cy="15.6" rx="5" ry="4.2"/><ellipse cx="5.6" cy="10.6" rx="2.1" ry="2.6"/><ellipse cx="9.6" cy="6.6" rx="2.2" ry="2.8"/><ellipse cx="14.4" cy="6.6" rx="2.2" ry="2.8"/><ellipse cx="18.4" cy="10.6" rx="2.1" ry="2.6"/></g></svg>`;
  const ico = {
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5.5" width="17" height="13" rx="3"/><path d="M4.5 7.5l7.5 5.5 7.5-5.5"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10.5" rx="3"/><path d="M8 10.5V8a4 4 0 018 0v2.5"/><circle cx="12" cy="15.8" r="1.3" fill="currentColor"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.6 6a9.6 9.6 0 0110.9 6 13 13 0 01-2.6 3.6M6.3 7.6A12.6 12.6 0 002.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1"/><path d="M9.9 9.9a3 3 0 004.2 4.2"/></svg>'
  };

  const html = () => {
    const isUp = mode === 'up';
    return `<div class="ag-bg">${[0, 1, 2, 3, 4, 5].map(i => `<i class="ag-p p${i}">${paw('currentColor')}</i>`).join('')}</div>
      <div class="ag-scroll"><div class="ag-in">
        <div class="ag-inn">
          <div class="ag-sign"><b>晓米客栈</b><small>XIAOMI INN</small></div>
          <div class="ag-cats">
            <span class="ag-c side l">${App.catArt.svg('n3', { head: true, w: 64, mood: 'happy' })}</span>
            <span class="ag-c main">${App.catArt.svg('n1', { w: 132, mood: 'happy' })}</span>
            <span class="ag-c side r">${App.catArt.svg('r1', { head: true, w: 64, mood: 'happy' })}</span>
          </div>
        </div>
        <h1 class="ag-title">${isUp ? '入住晓米客栈' : '欢迎回到晓米客栈'}</h1>
        <p class="ag-sub">${isUp ? '注册一个账号，账本和猫咪会跟着你走～' : '登录后，账本和猫咪都在云端等你喵～'}</p>
        <div class="ag-card">
          <div class="seg wide ag-seg"><button data-ag="mode" data-v="in" class="${isUp ? '' : 'on'}">登录</button><button data-ag="mode" data-v="up" class="${isUp ? 'on' : ''}">注册</button></div>
          <label class="ag-field"><i>${ico.mail}</i><input id="ag-email" type="email" inputmode="email" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="邮箱" value="${esc(email)}"></label>
          <label class="ag-field"><i>${ico.lock}</i><input id="ag-pw" type="${showPw ? 'text' : 'password'}" autocomplete="${isUp ? 'new-password' : 'current-password'}" placeholder="${isUp ? '设置密码（至少 6 位）' : '密码'}"><button class="ag-eye" data-ag="eye" type="button" aria-label="显示密码">${showPw ? ico.eyeOff : ico.eye}</button></label>
          ${isUp ? `<label class="ag-field"><i>${ico.lock}</i><input id="ag-pw2" type="${showPw ? 'text' : 'password'}" autocomplete="new-password" placeholder="再输一次密码"></label>` : ''}
          ${note ? `<p class="ag-note">${esc(note)}</p>` : ''}
          <button class="ag-go" data-ag="go" ${busy ? 'disabled' : ''}>${busy ? (isUp ? '注册中…' : '登录中…') : (isUp ? '注册并入住' : '登录')}</button>
          <p class="ag-tip">${isUp ? '注册后如果收到确认邮件，点一下里面的链接，再回来登录就好。' : '还没有账号？点上面的「注册」。'}<br>只有你自己能看到你的账本：云端开了行级安全（RLS）。</p>
        </div>
      </div></div>`;
  };

  const paint = () => { if (G.el) { G.el.innerHTML = html(); } };

  G.show = () => {
    if (G.el) return;
    mode = 'in'; busy = false; note = ''; showPw = false;
    G.el = document.createElement('div');
    G.el.id = 'auth-gate';
    G.el.className = 'ag';
    document.body.appendChild(G.el);
    document.body.classList.add('ag-open');
    paint();
    G.el.addEventListener('click', onClick);
    G.el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  };

  G.hide = () => {
    if (!G.el) return;
    const el = G.el; G.el = null;
    document.body.classList.remove('ag-open');
    el.classList.add('out');
    setTimeout(() => el.remove(), 420);
  };

  const readForm = () => {
    email = (G.el.querySelector('#ag-email').value || '').trim();
    return { email, pw: G.el.querySelector('#ag-pw').value || '', pw2: (G.el.querySelector('#ag-pw2') || {}).value };
  };

  const onClick = e => {
    const b = e.target.closest('[data-ag]'); if (!b) return;
    const a = b.dataset.ag;
    if (a === 'mode') { readForm(); mode = b.dataset.v; note = ''; paint(); }
    else if (a === 'eye') { const f = readForm(); showPw = !showPw; paint(); G.el.querySelector('#ag-pw').value = f.pw; if (f.pw2 != null && G.el.querySelector('#ag-pw2')) G.el.querySelector('#ag-pw2').value = f.pw2; }
    else if (a === 'go') submit();
  };

  const submit = async () => {
    if (busy || !G.el) return;
    const f = readForm();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) { UI.toast('请填写正确的邮箱'); return; }
    if (f.pw.length < 6) { UI.toast('密码至少 6 位'); return; }
    if (mode === 'up' && f.pw !== f.pw2) { UI.toast('两次输入的密码不一样'); return; }
    busy = true; note = ''; paint(); G.el.querySelector('#ag-pw').value = f.pw;
    try {
      if (mode === 'up') {
        const r = await SB().signUp(f.email, f.pw);
        if (r === 'confirm') {
          busy = false; mode = 'in';
          note = '注册成功！确认邮件已经发到 ' + f.email + '，点里面的链接后回来登录。';
          paint(); return;
        }
      } else {
        await SB().signIn(f.email, f.pw);
      }
      busy = false;
      // 这台手机上的账本属于另一个账号（比如之前登录过别的账号、登录过期后换了账号）：先留备份再清空，不把别人的账并进来
      const uid = SB().user() && SB().user().id, prev = App.S.sync && App.S.sync.uid;
      if (uid && prev && prev !== uid) { App.replaceState(null); App.S.settings.ui31 = 1; App.flush(); }
      G.hide();
      UI.toast('登录成功，正在同步账本…', 2200, 'gold');
      App.render(false);
      await App.cloud.sync(false);
      App.render(false);
      if (App.cloud.err) UI.toast('同步失败：' + App.cloud.err + '（稍后会自动重试）', 3600);
    } catch (er) {
      busy = false; note = er.message || '失败了，再试一次'; paint();
      if (G.el) G.el.querySelector('#ag-pw').value = f.pw;
    }
  };

  // 「我的」页的退出登录
  A.logout = async () => {
    if (!SB().user()) { G.show(); return; }
    const ok = await UI.confirm({ title: '退出登录？', msg: '退出前会先同步一次。退出后这台手机上的账本会清空（云端的数据还在），重新登录就会回来。', ok: '退出登录', danger: true });
    if (!ok) return;
    UI.toast('正在同步…', 1500);
    await App.cloud.sync(false);
    if (App.cloud.err && !await UI.confirm({ title: '同步没成功', msg: '有些改动可能还没传到云端：' + App.cloud.err + '。仍然要退出吗？（App 内会留一份操作前备份）', ok: '仍然退出', danger: true })) return;
    await SB().signOut();
    UI.closeAll();
    App.replaceState(null);   // 会先在 App 内留一份「操作前备份」
    App.S.settings.ui31 = 1;
    App.tab = 'home'; App.render(false);
    UI.toast('已退出登录');
    if (G.enabled()) G.show();
  };

  // 启动时：没登录就拦在登录页；登录过期（刷新令牌失效）后回到前台 / 同步完也拦回登录页
  G.boot = () => { if (G.needed()) G.show(); };
  const recheck = () => { if (G.needed() && !G.el) G.show(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(recheck, 600); });
  const sync = App.cloud.sync;
  App.cloud.sync = async m => { const r = await sync(m); recheck(); return r; };
})();

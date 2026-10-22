/* 晓米记账 · 入口：路由、底部导航、密码锁、事件分发 */
(() => {
  'use strict';
  const App = window.App, U = App.U, UI = App.UI, esc = U.esc;
  const A = App.A;

  /* ---------- 底部导航 ---------- */
  const TABS = [['home', '明细'], ['stats', '统计'], ['add', ''], ['inn', '客栈'], ['mine', '我的']];
  const renderTabbar = () => {
    document.getElementById('tabbar').innerHTML = TABS.map(t => t[0] === 'add'
      ? `<button class="tab-add" data-act="add" aria-label="记一笔">${UI.icons.plus}</button>`
      : `<button class="tab${(App.tab === t[0] || (t[0] === 'mine' && App.tab === 'assets')) ? ' on' : ''}" data-act="tab" data-t="${t[0]}">${UI.icons[t[0]]}<span>${t[1]}</span></button>`).join('');
  };

  App.render = keep => {
    const page = document.getElementById('page');
    const top = page.scrollTop;
    const v = App.views[App.tab];
    page.innerHTML = v.render();
    page.scrollTop = keep === false ? 0 : top;
    renderTabbar();
    App.sheets.slice().forEach(h => { if (h.opt.autoRefresh && !h.closed) h.update(); });
  };

  A.tab = el => { App.tab = el.dataset.t; App.render(false); };
  A.add = () => App.openEditor(App.tab === 'home' && App.home.mode === 'cal' ? { date: App.home.sel } : {});
  A.sheetClose = el => { const s = el.closest('.sheet'); if (s && s._h) s._h.close(); };

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const fn = A[el.dataset.act];
    if (fn) fn(el, e);
  });

  /* ---------- 密码锁 ---------- */
  App.bioName = () => ({ faceID: '面容 ID', touchID: '触控 ID', opticID: '视控 ID' }[window.__BIO__] || '面容 ID');
  const Lock = App.Lock = { active: false, fails: 0, until: 0 };   // 连续输错 5 次要等 30 秒，防止乱试
  Lock.ask = (title, o = {}) => new Promise(res => {
    const el = document.getElementById('lock');
    let buf = '', mode = 'pad';
    Lock.active = true;
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
    const paint = msg => {
      if (mode === 'forgot') {
        el.innerHTML = `<div class="lock-in"><div class="lock-cat">⚠️</div><h3>忘记密码？</h3><p class="lock-tip">重置会清空这台手机上的所有记账数据，无法恢复。<br>如果有备份文件，重置后可以在「数据与备份」里导入。</p><button class="btn danger wide" data-lk="reset">清空数据并重置</button><button class="lk-link" data-lk="back">返回</button></div>`;
        return;
      }
      el.innerHTML = `<div class="lock-in"><div class="lock-cat">${App.catArt.svg('n1', { head: true, w: 92 })}</div><h3>${esc(title)}</h3><div class="lock-msg">${esc(msg || '')}</div>` +
        `<div class="dots" id="lkDots">${[0, 1, 2, 3].map(i => `<i class="${i < buf.length ? 'on' : ''}"></i>`).join('')}</div>` +
        `<div class="lk-pad">${keys.map(k => k === '' ? '<span></span>' : `<button data-lk="k" data-v="${k}">${k === 'del' ? '⌫' : k}</button>`).join('')}</div>` +
        (o.cancel ? '<button class="lk-link" data-lk="cancel">取消</button>' : '') +
        (o.bio ? `<button class="lk-bio" data-lk="bio">${App.bioName()} 解锁</button>` : '') +
        (o.forgot ? '<button class="lk-link" data-lk="forgot">忘记密码？</button>' : '') + '</div>';
    };
    const close = v => { el.hidden = true; el.innerHTML = ''; el.onclick = null; Lock.active = false; Lock.onBio = null; res(v); };
    el.hidden = false; paint();
    if (o.bio) {   // 面容 / 指纹：成功直接解锁，失败或取消就用密码
      Lock.onBio = ok => { if (!Lock.active) return; if (ok) close('bio'); else paint('可以输入 4 位密码解锁'); };
      setTimeout(() => { if (Lock.active) App.native('auth', {}); }, 350);
    }
    el.onclick = e => {
      const b = e.target.closest('[data-lk]'); if (!b) return;
      const a = b.dataset.lk;
      if (a === 'cancel') { close(null); return; }
      if (a === 'bio') { App.native('auth', {}); return; }
      if (a === 'forgot') { mode = 'forgot'; paint(); return; }
      if (a === 'back') { mode = 'pad'; buf = ''; paint(); return; }
      if (a === 'reset') { App.replaceState(null); close(''); UI.toast('已重置'); return; }
      if (a !== 'k') return;
      const wait = Math.ceil((Lock.until - Date.now()) / 1000);
      if (wait > 0) { buf = ''; paint(`输错太多次啦，请 ${wait} 秒后再试`); return; }
      const v = b.dataset.v;
      if (v === 'del') buf = buf.slice(0, -1);
      else if (buf.length < 4) buf += v;
      if (buf.length < 4) { paint(); return; }
      if (o.validate && !o.validate(buf)) {
        paint(); const d = el.querySelector('#lkDots'); if (d) d.classList.add('shake');
        buf = '';
        let msg = o.mismatch || '密码不对';
        if (o.forgot || o.mismatch === '密码不对') {   // 只对「验证密码」限次，设置新密码时的两次确认不算
          Lock.fails++;
          if (Lock.fails >= 5) { Lock.fails = 0; Lock.until = Date.now() + 30000; msg = '输错太多次啦，请 30 秒后再试'; }
          else if (Lock.fails >= 3) msg += `，还可以试 ${5 - Lock.fails} 次`;
        }
        setTimeout(() => { if (Lock.active) paint(msg); }, 380);
        return;
      }
      Lock.fails = 0;
      paint();
      const out = buf; setTimeout(() => close(out), 90);
    };
  });

  App.lockNow = async () => {
    if (!App.S.settings.pin || Lock.active) return;
    await Lock.ask('输入密码', { forgot: true, bio: App.S.settings.bio && !!window.__BIO__, validate: v => U.hash('xm:' + v) === App.S.settings.pin, mismatch: '密码不对' });
  };

  /* ---------- 前后台 ---------- */
  App.onBackground = () => { App.flush(); App.lockNow(); };
  App.onForeground = () => { App.runRecurring(); if (App.mood.decay()) App.flush(); App.smart.run(); App.render(true); App.budget.check(); App.backup.run(); App.remind.sync(true); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) App.onBackground(); else App.onForeground(); });
  window.addEventListener('pagehide', () => App.flush());

  /* ---------- 键盘弹出时让弹层贴合可视区域 ---------- */
  const setupViewport = () => {
    const vv = window.visualViewport; if (!vv) return;
    const layer = document.getElementById('layer'); let raf = 0;
    const upd = () => {
      raf = 0;
      if (window.innerHeight - vv.height > 80) {
        layer.style.top = vv.offsetTop + 'px'; layer.style.height = vv.height + 'px'; layer.classList.add('kb');
      } else { layer.style.top = ''; layer.style.height = ''; layer.classList.remove('kb'); }
    };
    const sched = () => { if (!raf) raf = requestAnimationFrame(upd); };
    vv.addEventListener('resize', sched); vv.addEventListener('scroll', sched);
  };

  /* ---------- 启动 ---------- */
  const init = () => {
    App.load();
    App.applyTheme();
    setupViewport();
    if (App.S.settings.pin) App.lockNow();
    App.runRecurring();
    App.mood.decay(); App.flush();
    App.render(false);
    setTimeout(() => App.smart.run(), 500);
    setTimeout(() => { App.backup.run(); App.backup.remind(); App.remind.sync(true); }, 2500);
    setTimeout(() => App.budget.check(), 800);
    if (App.loadError) UI.toast('数据文件读取失败，已用新账本启动；原数据另存在「文件 → 晓米记账 → 自动备份」', 5000);
    else if (App.loadRecovered) UI.toast('主数据文件损坏，已从备用副本恢复账本', 4200);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

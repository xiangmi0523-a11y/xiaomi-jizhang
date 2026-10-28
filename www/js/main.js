/* 晓米记账 · 入口：路由、底部导航、密码锁、事件分发 */
(() => {
  'use strict';
  const App = window.App, U = App.U, UI = App.UI, esc = U.esc;
  const A = App.A;

  /* ---------- 底部导航 ---------- */
  // iOS 26 及以上用系统原生的液态玻璃标签栏（由原生层画），网页里的底栏只在旧系统上用
  const NTAB = !!window.__NATIVE_TABBAR__;   // 系统支持原生液态玻璃标签栏
  App.ntabAvailable = NTAB;
  // 系统支持就用原生液态玻璃底栏（旧系统自动用网页底栏）
  App.useNativeBar = () => NTAB;
  // 原生层更新了安全区高度（刘海、底部小黑条）后重新对齐底栏
  App.onSafeArea = () => { try { moveLens(false); } catch (e) { /* ignore */ } };
  App.applyTabStyle = () => {
    document.documentElement.classList.toggle('ntab', App.useNativeBar());
    if (App.syncNativeBar) App.syncNativeBar(true);
    requestAnimationFrame(() => moveLens(false));
  };
  App.nativeTab = key => { if (key !== App.tab && !(key === 'mine' && App.tab === 'assets')) A.tab({ dataset: { t: key } }); else if (key === 'mine' && App.tab === 'assets') A.tab({ dataset: { t: 'mine' } }); };
  // 网页里有全屏内容（记账面板、弹层、密码锁、启动动画…）时让原生底栏收起来，并把主题色告诉它
  let barState = '';
  App.syncNativeBar = force => {
    if (!NTAB) return;
    const lock = document.getElementById('lock');
    const covered = !App.useNativeBar() || !!(document.getElementById('splash') || (lock && !lock.hidden) || App.sheets.length ||
      document.querySelector('#auth-gate, .dlg-wrap, .sign-wrap, .rc-wrap, .gacha, .wn'));
    const cs = getComputedStyle(document.documentElement);
    const accent = cs.getPropertyValue('--accent-strong').trim(), plus = cs.getPropertyValue('--gb').trim();
    const key = covered + accent + plus;
    if (key === barState && !force) return;
    barState = key;
    App.native('tabbar', { hidden: covered, accent, plus });
  };
  if (NTAB) {
    let raf = 0;
    const kick = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; App.syncNativeBar(); }); };
    new MutationObserver(kick).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  }
  const TABS = [['home', '明细'], ['stats', '统计'], ['add', ''], ['inn', '客栈'], ['mine', '我的']];
  // 液态玻璃底栏：按钮只在切换页面时重画；选中格下面有一个会弹性滑动的玻璃泡
  let lensReady = false;
  const moveLens = jelly => {
    const bar = document.getElementById('tabbar'), lens = bar.querySelector('.tab-lens'), on = bar.querySelector('.tab.on');
    if (!lens || !on) { if (lens) lens.style.opacity = '0'; return; }
    const w = on.offsetWidth + 10, x = on.offsetLeft - 5;
    if (!lensReady) { lens.classList.add('still'); }
    lens.style.opacity = '1'; lens.style.width = w + 'px'; lens.style.transform = `translateX(${x}px)`;
    if (!lensReady) { void lens.offsetWidth; lens.classList.remove('still'); lensReady = true; }
    if (jelly) { lens.classList.remove('jelly'); void lens.offsetWidth; lens.classList.add('jelly'); }
  };
  const renderTabbar = () => {
    const bar = document.getElementById('tabbar');
    let row = bar.querySelector('.tab-row');
    if (!row) {
      bar.innerHTML = '<i class="tab-lens"></i><i class="tab-sheen"></i><div class="tab-row"></div>';
      row = bar.querySelector('.tab-row');
    }
    const cur = App.tab === 'assets' ? 'mine' : App.tab;
    if (NTAB && App.lastNativeTab !== cur) { App.lastNativeTab = cur; App.native('tab', { t: cur }); }
    if (row.dataset.k === cur) return;
    const jelly = !!row.dataset.k;
    row.dataset.k = cur;
    row.innerHTML = TABS.map(t => t[0] === 'add'
      ? `<button class="tab-add" data-act="add" aria-label="记一笔">${UI.icons.plus}</button>`
      : `<button class="tab${cur === t[0] ? ' on' : ''}" data-act="tab" data-t="${t[0]}">${UI.icons[t[0]]}<span>${t[1]}</span></button>`).join('');
    requestAnimationFrame(() => moveLens(jelly));
  };
  window.addEventListener('resize', () => moveLens(false));

  const TAB_ORDER = ['home', 'stats', 'inn', 'mine'];

  App.render = keep => {
    const page = document.getElementById('page');
    const top = page.scrollTop;
    const v = App.views[App.tab];
    page.innerHTML = v.render();
    page.scrollTop = keep === false ? 0 : top;
    renderTabbar();
    App.sheets.slice().forEach(h => { if (h.opt.autoRefresh && !h.closed) h.update(); });
  };

  A.tab = el => {
    const from = TAB_ORDER.indexOf(App.tab === 'assets' ? 'mine' : App.tab), to = TAB_ORDER.indexOf(el.dataset.t);
    if (from !== to && App.sound) App.sound.tap();   // 轻轻的「啵」
    if (el.dataset.t === 'inn' && App.inn && App.inn.onEnter) App.inn.onEnter();
    App.tab = el.dataset.t;
    document.getElementById('tabbar').classList.remove('mini');
    App.render(false);
    // 页面跟着方向滑进来：往右边的标签切就从右边滑入
    const page = document.getElementById('page');
    if (from >= 0 && to >= 0 && from !== to) {
      page.classList.remove('slide-l', 'slide-r'); void page.offsetWidth;
      page.classList.add(to > from ? 'slide-r' : 'slide-l');
    }
  };
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
      setTimeout(() => App.afterSplash(() => { if (Lock.active) App.native('auth', {}); }), 350);   // 等启动动画放完再弹面容 ID
    }
    el.onclick = e => {
      const b = e.target.closest('[data-lk]'); if (!b) return;
      const a = b.dataset.lk;
      if (a === 'cancel') { close(null); return; }
      if (a === 'bio') { App.native('auth', {}); return; }
      if (a === 'forgot') { mode = 'forgot'; paint(); return; }
      if (a === 'back') { mode = 'pad'; buf = ''; paint(); return; }
      if (a === 'reset') {
        // H4：重置前先退出云端登录。只清空本机账本、不退出的话，下次同步会把云端账本整个拉回来，等于绕过了密码锁
        const SB = App.supabase;
        if (SB && SB.signOutNow) SB.signOutNow();   // 立即在本机退出（内存 + localStorage），并在后台通知服务器作废令牌
        try { localStorage.removeItem('xm_supabase_session'); } catch (e) { /* ignore */ }
        if (App.restore) App.restore.clear();   // 没完成的备份恢复任务属于上一个登录，一起清掉
        App.replaceState(null); close(''); UI.toast('已重置');
        if (App.authGate && App.authGate.enabled()) App.authGate.show();   // App / 线上网页：回到登录页，要重新登录才能拿回云端账本
        return;
      }
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
  /* ---------- 启动动画：约 2 秒后淡出，点一下可以跳过 ---------- */
  const splashWait = [];
  let splashEl = null;
  App.afterSplash = fn => { if (splashEl) splashWait.push(fn); else fn(); };
  App.endSplash = fast => {
    const el = splashEl; if (!el) return;
    splashEl = null;
    el.classList.add('out');
    setTimeout(() => { el.remove(); splashWait.splice(0).forEach(fn => { try { fn(); } catch (e) { /* ignore */ } }); }, fast ? 160 : 420);
  };
  const startSplash = () => {
    splashEl = document.getElementById('splash');
    if (!splashEl) return;
    const cat = splashEl.querySelector('.sp-cat');
    if (cat && App.catArt) cat.innerHTML = App.catArt.svg('n1', { head: true, w: 130, mood: 'happy' });
    splashEl.addEventListener('click', () => App.endSplash(true));
    setTimeout(() => App.endSplash(), 2150);
  };

  const init = () => {
    startSplash();
    App.load();
    App.applyTabStyle();
    // v3.1：界面统一成设计稿的奶油黄配色，升级时切回一次（之后想换主题可以在「外观」里换）
    if (!App.S.settings.ui31) { App.S.settings.ui31 = 1; App.S.settings.theme = 'millet'; }
    App.applyTheme();
    setupViewport();
    if (App.S.settings.pin) App.lockNow();
    App.runRecurring();
    App.mood.decay(); App.flush();
    App.render(false);
    App.authGate.boot();   // 没登录 → 先进登录页
    setTimeout(() => App.smart.run(), 500);
    setTimeout(() => { App.backup.run(); App.backup.remind(); App.remind.sync(true); }, 2500);
    setTimeout(() => App.budget.check(), 800);
    if (App.loadError) UI.toast('数据文件读取失败，已用新账本启动；原数据另存在「文件 → 晓米记账 → 自动备份」', 5000);
    else if (App.loadRecovered) UI.toast('主数据文件损坏，已从备用副本恢复账本', 4200);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

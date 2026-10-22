/* 晓米记账 · 自动备份：选一个文件夹（推荐 iCloud 云盘），有改动就自动存一份；另在 App 内保留本地快照 */
(() => {
  'use strict';
  const App = window.App, U = App.U, UI = App.UI, A = App.A, esc = U.esc;
  const BK = App.backup = {};
  const KEEP_GAP = 2 * 3600 * 1000;   // 同一份数据最快 2 小时备份一次

  const st = () => {
    const s = App.S.settings;
    if (!s.backup || typeof s.backup !== 'object') s.backup = {};
    return s.backup;
  };
  BK.native = () => !!window.__NATIVE_APP__;
  BK.folder = () => window.__BACKUP_FOLDER__ || '';
  BK.fileName = () => `晓米记账自动备份-${U.today()}.json`;
  const sig = () => {
    let t = 0; App.S.records.forEach(r => { if ((r.ts || 0) > t) t = r.ts; });
    return [App.S.records.length, t, App.S.game.coins, App.S.accounts.length, Object.keys(App.S.game.cats).length].join(':');
  };
  const daysSince = d => (d ? Math.round((U.parse(U.today()) - U.parse(d)) / 86400000) : 9999);

  let busy = false;
  BK.run = force => {
    if (busy || !BK.native() || !App.S || (!App.S.records.length && !force)) return;
    const b = st(), s = sig(), now = Date.now();
    if (!force && b.sig === s) return;
    if (!force && b.at && now - b.at < KEEP_GAP) return;
    busy = true;
    b.sig = s; b.at = now;
    const content = JSON.stringify(App.S);
    App.native('snapshot', { filename: BK.fileName(), content });
    if (BK.folder()) App.native('autoBackup', { filename: BK.fileName(), content });
    busy = false;
  };

  // 原生层回调
  BK.onAuto = (ok, folder, err) => {
    const b = st();
    if (ok) { b.lastOk = U.today(); b.err = ''; } else { b.sig = ''; b.err = err || '写入失败'; }
    if (BK._manual) {
      UI.toast(ok ? `已备份到「${folder || BK.folder()}」` : `备份失败：${err || '无法写入文件夹，请重新选择'}`, 2800, ok ? 'gold' : '');
      BK._manual = false;
    }
    App.changed();
  };
  BK.onFolder = name => {
    window.__BACKUP_FOLDER__ = name;
    st().folder = name;
    BK._manual = true;
    BK.run(true);
    App.changed();
  };
  BK.onFolderFail = msg => UI.toast('没能使用这个文件夹：' + (msg || '请换一个试试'), 2600);

  BK.pick = () => {
    if (!BK.native()) { UI.toast('需要在 iPhone 上的晓米记账 App 里设置'); return; }
    App.native('pickBackupFolder', {});
  };
  BK.now = () => {
    if (!BK.folder()) { BK.pick(); return; }
    BK._manual = true;
    BK.run(true);
  };
  BK.status = () => {
    const b = st();
    if (!BK.folder()) return '未设置 · 选一个 iCloud 云盘文件夹，每天自动备份';
    if (b.err) return `文件夹「${BK.folder()}」· 上次失败：${b.err}`;
    return `已开启 · 文件夹「${BK.folder()}」${b.lastOk ? ' · 最近 ' + U.dayLabel(b.lastOk) : ''}`;
  };
  BK.markExport = () => { st().lastExport = U.today(); App.flush(); };

  // 没设置自动备份、也很久没手动导出时，每周温柔提醒一次
  BK.remind = () => {
    if (!BK.native() || BK.folder() || App.S.records.length < 5) return;
    const b = st();
    if (daysSince(b.lastExport) < 7 || daysSince(b.remind) < 7) return;
    b.remind = U.today(); App.flush();
    App.budget.enqueue(() => {
      const el = document.createElement('div');
      el.className = 'wn good';
      el.innerHTML = `<div class="wn-card"><div class="wn-cat">${App.catArt.svg(App.budget.catId(), { w: 170, mood: 'worried' })}</div>
        <div class="wn-title">该给账本做个备份啦</div>
        <p class="wn-msg">账本只存在这台手机里，删掉 App 或换手机就没了。设置一次「自动备份到 iCloud 云盘」，以后有改动就自动存一份～</p>
        <div class="wn-btns"><button data-wn="later">以后再说</button><button data-wn="go" class="ok">去设置</button></div></div>`;
      el.addEventListener('click', e => {
        const btn = e.target.closest('[data-wn]');
        if (!btn && e.target !== el) return;
        App.budget.closeCard(el);
        if (btn && btn.dataset.wn === 'go') setTimeout(BK.pick, 260);
      });
      return el;
    });
  };

  A.backupPick = () => BK.pick();
  A.backupNow = () => BK.now();
})();

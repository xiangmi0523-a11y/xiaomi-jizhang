/* 晓米记账 · 核心：工具函数、数据模型、存储 */
(() => {
  'use strict';
  const App = window.App = { A: {}, S: null, tab: 'home', views: {}, sheets: [] };
  const KEY = 'xiaomi_ledger_v1';

  /* ---------- 工具 ---------- */
  const U = App.U = {};
  U.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  U.uid = p => (p || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  U.pad = n => (n < 10 ? '0' : '') + n;
  U.ymd = d => d.getFullYear() + '-' + U.pad(d.getMonth() + 1) + '-' + U.pad(d.getDate());
  U.today = () => U.ymd(new Date());
  U.parse = s => { const p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); };
  U.addDays = (s, n) => { const d = U.parse(s); d.setDate(d.getDate() + n); return U.ymd(d); };
  U.dim = (y, m) => new Date(y, m, 0).getDate(); // m: 1-12
  U.ymAdd = (ym, n) => { const p = ym.split('-'); const d = new Date(+p[0], +p[1] - 1 + n, 1); return d.getFullYear() + '-' + U.pad(d.getMonth() + 1); };
  U.curYM = () => U.today().slice(0, 7);
  U.WD = ['日', '一', '二', '三', '四', '五', '六'];
  U.wd = s => U.parse(s).getDay();
  U.md = s => { const p = s.split('-'); return (+p[1]) + '月' + (+p[2]) + '日'; };
  U.ymLabel = ym => { const p = ym.split('-'); return p[0] + '年' + (+p[1]) + '月'; };
  U.dayLabel = s => {
    const t = U.today();
    if (s === t) return '今天';
    if (s === U.addDays(t, -1)) return '昨天';
    if (s === U.addDays(t, 1)) return '明天';
    return (s.slice(0, 4) !== t.slice(0, 4) ? s.slice(0, 4) + '年' : '') + U.md(s);
  };

  // 金额一律用整数「分」存储
  U.money = c => {
    const neg = c < 0; c = Math.abs(Math.round(c));
    const y = Math.floor(c / 100), f = c % 100;
    return (neg ? '-' : '') + String(y).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + U.pad(f);
  };
  U.cell = c => {
    const y = c / 100;
    if (y >= 10000) return (Math.round(y / 1000) / 10) + '万';
    if (y >= 1000) return String(Math.round(y));
    return String(Math.round(y * 10) / 10);
  };
  U.toCents = str => {
    str = String(str == null ? '' : str).trim();
    if (!/^\d*\.?\d*$/.test(str) || str === '' || str === '.') return 0;
    const p = str.split('.');
    return parseInt(p[0] || '0', 10) * 100 + parseInt(((p[1] || '') + '00').slice(0, 2), 10);
  };
  U.centsToStr = c => {
    if (c % 100 === 0) return String(c / 100);
    return (c / 100).toFixed(2).replace(/0$/, '');
  };
  U.evalExpr = expr => {
    const parts = String(expr).match(/[+-]?[^+-]+/g) || [];
    let total = 0;
    parts.forEach(t => {
      const sign = t[0] === '-' ? -1 : 1;
      total += sign * U.toCents(t.replace(/^[+-]/, ''));
    });
    return total;
  };
  // 简易哈希（仅用于密码锁，防旁人随手翻看）
  U.hash = str => {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };

  /* ---------- 默认数据 ---------- */
  App.ACC_TYPES = {
    cash: { n: '现金', i: '💵' },
    ewallet: { n: '电子钱包', i: '📲' },
    bank: { n: '储蓄卡', i: '🏦' },
    credit: { n: '信用卡', i: '💳' },
    invest: { n: '理财投资', i: '📈' },
    other: { n: '其他', i: '👛' }
  };
  const EXP = [
    ['e_food', '餐饮', '🍜'], ['e_veg', '买菜', '🥬'], ['e_fruit', '水果', '🍎'], ['e_snack', '零食', '🍪'],
    ['e_drink', '饮品', '🧋'], ['e_bus', '交通', '🚌'], ['e_taxi', '打车', '🚕'], ['e_shop', '购物', '🛍️'],
    ['e_daily', '日用', '🧻'], ['e_cloth', '服饰', '👗'], ['e_beauty', '美容', '💄'], ['e_digital', '数码', '📱'],
    ['e_fun', '娱乐', '🎮'], ['e_sport', '运动', '🏃'], ['e_travel', '旅行', '✈️'], ['e_home', '居家', '🏠'],
    ['e_rent', '房租', '🔑'], ['e_util', '水电燃气', '💡'], ['e_phone', '通讯', '📞'], ['e_med', '医疗', '💊'],
    ['e_study', '学习', '📚'], ['e_kid', '孩子', '🧸'], ['e_pet', '宠物', '🐱'], ['e_gift', '人情', '🧧'],
    ['e_car', '汽车', '🚗'], ['e_other', '其他', '📦']
  ];
  const INC = [
    ['i_salary', '工资', '💰'], ['i_bonus', '奖金', '🎁'], ['i_part', '兼职', '💼'], ['i_invest', '理财', '📈'],
    ['i_red', '红包', '🧧'], ['i_reim', '报销', '🧾'], ['i_refund', '退款', '↩️'], ['i_other', '其他', '📦']
  ];
  App.defaults = () => ({
    v: 1,
    created: Date.now(),
    accounts: [
      { id: 'a_cash', name: '现金', type: 'cash', init: 0 },
      { id: 'a_wx', name: '微信', type: 'ewallet', init: 0 },
      { id: 'a_ali', name: '支付宝', type: 'ewallet', init: 0 },
      { id: 'a_bank', name: '储蓄卡', type: 'bank', init: 0 },
      { id: 'a_credit', name: '信用卡', type: 'credit', init: 0 }
    ],
    cats: {
      expense: EXP.map(c => ({ id: c[0], name: c[1], icon: c[2] })),
      income: INC.map(c => ({ id: c[0], name: c[1], icon: c[2] }))
    },
    records: [],
    budget: { total: 0, cats: {} },
    recurring: [],
    game: { coins: 100, signed: [], progress: 0, cats: {}, inn: { slots: {}, owned: [] }, themes: [] },
    smart: { on: false, income: 0, fixed: 0, saving: 0, fixedCats: ['e_rent'], start: '', settled: '', closedYM: '', jar: 0, log: {}, flag: null },
    saving: { plans: [] },
    settings: { theme: 'millet', mode: 'auto', weekStart: 1, pin: '', lastAcc: '', bio: false, backup: {}, remind: { on: false, time: '21:00' } }
  });

  const DATE = /^\d{4}-\d{2}-\d{2}$/, TYPES = ['expense', 'income', 'transfer'];
  const toInt = v => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };
  const cleanRec = r => {
    if (!r || typeof r !== 'object' || !DATE.test(r.date || '') || !TYPES.includes(r.type)) return null;
    const amount = toInt(r.amount);
    if (amount <= 0) return null;
    return Object.assign({}, r, {
      id: r.id ? String(r.id) : U.uid('r'), amount, acc: String(r.acc || ''), to: r.to ? String(r.to) : '',
      cat: r.cat ? String(r.cat) : '', note: r.note == null ? '' : String(r.note).slice(0, 200), ts: Number.isFinite(+r.ts) ? +r.ts : 0
    });
  };
  U.cleanIcon = v => Array.from(String(v == null ? '' : v).replace(/[<>&"'`\\]/g, '').trim()).slice(0, 8).join('') || '📦';

  function normalize(s) {
    const d = App.defaults();
    s = s && typeof s === 'object' ? s : {};
    const out = Object.assign({}, d, s);
    out.settings = Object.assign({}, d.settings, s.settings || {});
    out.saving = s.saving && Array.isArray(s.saving.plans) ? s.saving : { plans: [] };
    out.smart = Object.assign({}, d.smart, s.smart && typeof s.smart === 'object' ? s.smart : {});
    if (!Array.isArray(out.smart.fixedCats)) out.smart.fixedCats = ['e_rent'];
    if (!out.smart.log || typeof out.smart.log !== 'object') out.smart.log = {};
    ['income', 'fixed', 'saving', 'jar'].forEach(k => { if (!Number.isFinite(out.smart[k])) out.smart[k] = 0; });
    out.budget = Object.assign({ total: 0, cats: {} }, s.budget || {});
    if (!out.budget.cats || typeof out.budget.cats !== 'object') out.budget.cats = {};
    out.game = Object.assign({}, d.game, s.game || {});
    if (!Array.isArray(out.game.signed)) out.game.signed = [];
    if (!out.game.cats || typeof out.game.cats !== 'object' || Array.isArray(out.game.cats)) out.game.cats = {};
    if (!Array.isArray(out.game.themes)) out.game.themes = [];
    const inn = out.game.inn && typeof out.game.inn === 'object' ? out.game.inn : {};
    out.game.inn = { slots: inn.slots && typeof inn.slots === 'object' && !Array.isArray(inn.slots) ? inn.slots : {}, owned: Array.isArray(inn.owned) ? inn.owned : [] };
    ['coins', 'progress'].forEach(k => { out.game[k] = Number.isFinite(out.game[k]) ? Math.max(0, Math.floor(out.game[k])) : d.game[k]; });
    out.cats = {
      expense: (s.cats && Array.isArray(s.cats.expense)) ? s.cats.expense : d.cats.expense,
      income: (s.cats && Array.isArray(s.cats.income)) ? s.cats.income : d.cats.income
    };
    ['accounts', 'records', 'recurring'].forEach(k => { if (!Array.isArray(out[k])) out[k] = d[k]; });
    // 逐条清洗：导入的备份或损坏的数据里有坏记录时，丢掉坏的、保留好的，避免金额变成字符串拼接、页面报错
    out.records = out.records.map(cleanRec).filter(Boolean);
    out.accounts = out.accounts.filter(a => a && typeof a === 'object' && a.id).map(a => Object.assign({}, a, {
      id: String(a.id), name: String(a.name == null ? '账户' : a.name).slice(0, 20), type: App.ACC_TYPES[a.type] ? a.type : 'other', init: toInt(a.init)
    }));
    if (!out.accounts.length) out.accounts = d.accounts;
    ['expense', 'income'].forEach(t => {
      out.cats[t] = out.cats[t].filter(c => c && typeof c === 'object' && c.id).map(c => Object.assign({}, c, { id: String(c.id), name: String(c.name == null ? '分类' : c.name).slice(0, 12), icon: U.cleanIcon(c.icon) }));
      if (!out.cats[t].length) out.cats[t] = d.cats[t];
    });
    out.recurring = out.recurring.filter(r => r && typeof r === 'object' && DATE.test(r.start || '') && App.FREQ[r.freq] && toInt(r.amount) > 0)
      .map(r => Object.assign({}, r, { amount: toInt(r.amount), last: DATE.test(r.last || '') ? r.last : '' }));
    return out;
  }
  App.normalize = normalize;

  /* ---------- 存储（原生文件 + localStorage 双保险） ---------- */
  App.native = (type, payload) => {
    try {
      const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native;
      if (h) { h.postMessage(Object.assign({ type }, payload || {})); return true; }
    } catch (e) { /* ignore */ }
    return false;
  };

  const tryParse = raw => { try { const o = JSON.parse(raw); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (e) { return null; } };
  App.load = () => {
    let nativeRaw = '', localRaw = '';
    try {
      if (window.__NATIVE_B64__) {
        const bin = atob(window.__NATIVE_B64__);
        nativeRaw = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
      }
    } catch (e) { nativeRaw = ''; }
    try { localRaw = localStorage.getItem(KEY) || ''; } catch (e) { localRaw = ''; }
    // 优先用原生文件；它坏了就退回网页里的备用副本；两份都坏才用新账本，并把坏数据另存一份，绝不直接丢掉
    let parsed = nativeRaw ? tryParse(nativeRaw) : null;
    const bad = [];
    if (nativeRaw && !parsed) bad.push(nativeRaw);
    if (!parsed && localRaw) { parsed = tryParse(localRaw); if (!parsed) bad.push(localRaw); else if (bad.length) App.loadRecovered = true; }
    if (bad.length) {
      const d = new Date(), tag = U.today() + '-' + U.pad(d.getHours()) + U.pad(d.getMinutes()) + U.pad(d.getSeconds());
      bad.forEach((raw, i) => {
        App.native('snapshot', { filename: `晓米记账-损坏的数据-${tag}-${i + 1}.json`, content: raw });
        try { localStorage.setItem(KEY + '_corrupt' + i, raw); } catch (e) { /* ignore */ }
      });
      if (!parsed) App.loadError = true;
    }
    App.S = normalize(parsed);
  };

  let saveTimer = null;
  App.flush = () => {
    clearTimeout(saveTimer); saveTimer = null;
    if (!App.S) return;
    const s = JSON.stringify(App.S);
    try { localStorage.setItem(KEY, s); } catch (e) { /* ignore */ }
    App.native('save', { data: s });
  };
  const schedSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(App.flush, 250); };
  App.changed = () => { schedSave(); if (App.render) App.render(); };
  // 覆盖/清空之前，先在 App 内存一份「操作前备份」（文件 App → 晓米记账 → 自动备份），手滑了也能找回
  App.safetyCopy = () => {
    if (!App.S || !App.S.records.length) return;
    const d = new Date();
    App.native('snapshot', { filename: `晓米记账-操作前备份-${U.today()}-${U.pad(d.getHours())}${U.pad(d.getMinutes())}${U.pad(d.getSeconds())}.json`, content: JSON.stringify(App.S) });
  };
  App.replaceState = obj => { App.safetyCopy(); App.S = normalize(obj); App.flush(); if (App.applyTheme) App.applyTheme(); if (App.render) App.render(); };

  App.shareFile = (filename, content, mime) => {
    if (App.native('export', { filename, content })) return;
    const blob = new Blob([content], { type: mime || 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  };

  /* ---------- 查询 ---------- */
  App.acc = id => App.S.accounts.find(a => a.id === id);
  App.accName = id => { const a = App.acc(id); return a ? a.name : '已删除账户'; };
  App.visibleAccounts = () => App.S.accounts.filter(a => !a.hidden);
  App.cat = id => {
    const S = App.S;
    return S.cats.expense.find(c => c.id === id) || S.cats.income.find(c => c.id === id) || { id, name: '未分类', icon: '❓' };
  };
  const cmpDesc = (a, b) => a.date === b.date ? (b.ts || 0) - (a.ts || 0) : (a.date < b.date ? 1 : -1);
  App.sortDesc = list => list.slice().sort(cmpDesc);
  App.recordsByMonth = ym => App.S.records.filter(r => r.date.slice(0, 7) === ym).sort(cmpDesc);
  App.sum = list => {
    const o = { expense: 0, income: 0 };
    list.forEach(r => { if (r.type === 'expense') o.expense += r.amount; else if (r.type === 'income') o.income += r.amount; });
    return o;
  };
  App.balance = id => {
    const a = App.acc(id); if (!a) return 0;
    let b = a.init || 0;
    App.S.records.forEach(r => {
      if (r.type === 'income' && r.acc === id) b += r.amount;
      else if (r.type === 'expense' && r.acc === id) b -= r.amount;
      else if (r.type === 'transfer') { if (r.acc === id) b -= r.amount; if (r.to === id) b += r.amount; }
    });
    return b;
  };
  App.accUsed = id => App.S.records.some(r => r.acc === id || r.to === id) || App.S.recurring.some(r => r.acc === id);
  App.catUsed = id => App.S.records.some(r => r.cat === id) || App.S.recurring.some(r => r.cat === id);
  App.recordDays = () => new Set(App.S.records.map(r => r.date)).size;

  /* ---------- 记录增删改 ---------- */
  App.addRecord = r => { r.id = U.uid('r'); r.ts = Date.now(); App.S.records.push(r); App.changed(); return r; };
  App.updateRecord = (id, patch) => {
    const r = App.S.records.find(x => x.id === id);
    if (r) { Object.assign(r, patch); App.changed(); }
  };
  App.deleteRecord = id => { App.S.records = App.S.records.filter(r => r.id !== id); App.changed(); };

  /* ---------- 周期记账 ---------- */
  App.FREQ = { daily: '每天', weekly: '每周', monthly: '每月', yearly: '每年' };
  App.occurrence = (item, k) => {
    const s = U.parse(item.start);
    if (item.freq === 'daily') return U.ymd(new Date(s.getFullYear(), s.getMonth(), s.getDate() + k));
    if (item.freq === 'weekly') return U.ymd(new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7 * k));
    if (item.freq === 'monthly') {
      let y = s.getFullYear(), m = s.getMonth() + k;
      y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
      return U.ymd(new Date(y, m, Math.min(s.getDate(), U.dim(y, m + 1))));
    }
    const yy = s.getFullYear() + k, mm = s.getMonth();
    return U.ymd(new Date(yy, mm, Math.min(s.getDate(), U.dim(yy, mm + 1))));
  };
  App.runRecurring = () => {
    const today = U.today(); let n = 0;
    App.S.recurring.forEach(it => {
      if (!it.enabled) return;
      let last = it.last || '';
      for (let k = 0; k < 4000; k++) {
        const d = App.occurrence(it, k);
        if (d > today) break;
        if (d > last) {
          if (n >= 500) return;
          App.S.records.push({
            id: U.uid('r'), ts: Date.now() + n, type: it.type, amount: it.amount, cat: it.cat, acc: it.acc,
            to: '', date: d, note: it.note || '', rec: it.id
          });
          last = d; it.last = d; n++;
        }
      }
    });
    if (n) App.changed();
    return n;
  };

  /* ---------- 导出 ---------- */
  App.csv = () => {
    // 文字列以 = + - @ 开头时加 ' 前缀，防止 Excel 把备注当成公式执行
    const q = v => { let t = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
    const rows = [['日期', '类型', '分类', '金额', '账户', '转入账户', '备注']];
    const label = { expense: '支出', income: '收入', transfer: '转账' };
    App.S.records.slice().sort((a, b) => a.date === b.date ? (a.ts || 0) - (b.ts || 0) : (a.date < b.date ? -1 : 1)).forEach(r => {
      rows.push([r.date, label[r.type] || r.type, r.type === 'transfer' ? '' : App.cat(r.cat).name,
        (r.amount / 100).toFixed(2), App.accName(r.acc), r.type === 'transfer' ? App.accName(r.to) : '', r.note || '']);
    });
    return '﻿' + rows.map(r => r.map(q).join(',')).join('\r\n');
  };

  /* ---------- 主题 ---------- */
  App.THEMES = {
    millet: { n: '小米黄', c: '#FFC53D' },
    peach: { n: '蜜桃橙', c: '#FF9F7A' },
    mint: { n: '薄荷绿', c: '#5CD6A0' },
    sky: { n: '天空蓝', c: '#6CB6FF' },
    grape: { n: '葡萄紫', c: '#A78BFA' }
  };
  App.applyTheme = () => {
    const st = App.S.settings, el = document.documentElement;
    el.setAttribute('data-theme', App.THEMES[st.theme] ? st.theme : 'millet');
    el.setAttribute('data-mode', ['auto', 'light', 'dark'].includes(st.mode) ? st.mode : 'auto');
    App.native('mode', { value: App.THEMES[st.theme] && App.THEMES[st.theme].dark ? 'dark' : st.mode });
  };
})();

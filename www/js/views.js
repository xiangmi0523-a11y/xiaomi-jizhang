/* 晓米记账 · 三个主页面：明细 / 统计 / 资产 */
(() => {
  'use strict';
  const App = window.App, U = App.U, UI = App.UI, esc = U.esc, money = U.money;
  const A = App.A;
  // 马卡龙色系
  const PALETTE = ['#FFB3C7', '#A8E6CF', '#FFD3A5', '#B5D8FF', '#D7BCFF', '#FFE89A', '#B8F0EA', '#FFC1A1', '#CFEFB0', '#F6C6EA', '#E5DCCF'];
  App.PALETTE = PALETTE;
  // 每个分类固定一个浅色圆底（按分类 id 取色，同一分类每次都一样）
  const ICO_BG = ['#FFE7C2', '#DDF1D5', '#FFE0DA', '#DCEBFF', '#EFE2FF', '#FFF0B8', '#D7F3EE', '#FFE2EF'];
  App.icoBg = id => { let h = 0; String(id || '').split('').forEach(c => { h = (h * 31 + c.charCodeAt(0)) | 0; }); return ICO_BG[Math.abs(h) % ICO_BG.length]; };

  /* ================= 公共：记录行 / 月份选择 ================= */
  App.recRow = (r, o = {}) => {
    let ico, title, amt, cls = '';
    const sub = [];
    if (o.showDate) sub.push(U.md(r.date));
    if (r.type === 'transfer') {
      ico = '🔁'; title = '转账'; amt = money(r.amount); cls = 'tr';
      if (r.note) sub.push(r.note);
      sub.push(App.accName(r.acc) + ' → ' + App.accName(r.to));
    } else {
      const c = App.cat(r.cat);
      ico = c.icon; title = c.name;
      amt = (r.type === 'income' ? '+' : '-') + money(r.amount);
      cls = r.type === 'income' ? 'in' : '';
      if (r.note) sub.push(r.note);
      sub.push(App.accName(r.acc));
    }
    return `<div class="rec" data-act="editRec" data-id="${esc(r.id)}"><div class="ico" style="--ib:${App.icoBg(r.type === 'transfer' ? 'tr' : r.cat)}">${ico}</div>` +
      `<div class="rec-main"><div class="rec-title">${esc(title)}${r.rec ? ' <i class="rec-flag">周期</i>' : ''}</div>` +
      `<div class="rec-sub">${esc(sub.join(' · '))}</div></div><div class="rec-amt ${cls}">${amt}</div></div>`;
  };

  const dayGroups = recs => {
    const groups = []; let cur = null;
    recs.forEach(r => {
      if (!cur || cur.date !== r.date) { cur = { date: r.date, list: [] }; groups.push(cur); }
      cur.list.push(r);
    });
    return groups;
  };
  const dayHead = (date, list) => {
    const s = App.sum(list);
    const bits = [];
    if (s.expense) bits.push('支出 ' + money(s.expense));
    if (s.income) bits.push('收入 ' + money(s.income));
    return `<div class="day-head"><span><i class="dh-dot"></i>${U.dayLabel(date)}<em>周${U.WD[U.wd(date)]}</em><button class="rc-day" data-act="openReceipt" data-d="${date}" aria-label="当日小票">${UI.icons.receipt}</button></span><span class="muted">${bits.join('　')}</span></div>`;
  };
  const listHTML = (recs, emptyMsg) => {
    if (!recs.length) return `<div class="empty"><div class="empty-cat">${App.catArt.svg('n1', { w: 130 })}</div><p>${emptyMsg || '这里还没有记录'}</p></div>`;
    return dayGroups(recs).map(g => dayHead(g.date, g.list) + `<div class="card list">${g.list.map(r => App.recRow(r)).join('')}</div>`).join('');
  };

  App.pickMonth = (cur, cb) => {
    let year = +cur.slice(0, 4);
    UI.sheet({
      title: '选择月份', cls: 'compact',
      render: () => {
        const nowYM = U.curYM();
        return `<div class="ym-bar"><button class="icon-btn" data-ym="prev">${UI.icons.back}</button><b>${year} 年</b><button class="icon-btn" data-ym="next">${UI.icons.chev}</button></div>` +
          `<div class="ym-grid">${Array.from({ length: 12 }, (_, i) => {
            const ym = year + '-' + U.pad(i + 1);
            return `<button class="ym${ym === cur ? ' on' : ''}${ym === nowYM ? ' now' : ''}" data-ym="${ym}">${i + 1}月</button>`;
          }).join('')}</div>`;
      },
      onMount: h => {
        h.body.addEventListener('click', e => {
          const b = e.target.closest('[data-ym]'); if (!b) return;
          const v = b.dataset.ym;
          if (v === 'prev') { year--; h.update(); } else if (v === 'next') { year++; h.update(); } else { h.close(); cb(v); }
        });
      }
    });
  };

  /* ================= 明细 ================= */
  const H = App.home = { ym: U.curYM(), mode: 'list', sel: U.today() };

  const homeRender = () => {
    const recs = App.recordsByMonth(H.ym);
    const sums = App.sum(recs);
    const budHTML = App.budget.heroHTML(sums.expense);
    const D = UI.deco, bal = sums.income - sums.expense;
    // 猫咪财务点评：只在看本月时出现（App.critic 只读数据）
    const ck = App.critic && H.ym === U.curYM() ? App.critic.now() : null;
    const hero = `<div class="hero home3">
      <div class="t3"><span class="t3-d l">${D.pawLine()}</span><h1 class="t3-title">晓米记账</h1><span class="t3-d r">${D.heart()}</span></div>
      <div class="hero-top">
        <button class="month-btn" data-act="homeMonth">${U.ymLabel(H.ym)}<span class="caret">${UI.icons.down}</span></button>
        <div class="hero-actions">
          ${App.game.pillHTML()}
          <button class="icon-btn" data-act="openReceipt" aria-label="今日小票">${UI.icons.receipt}</button>
          <button class="icon-btn" data-act="homeSearch" aria-label="搜索">${UI.icons.search}</button>
          <button class="icon-btn" data-act="homeMode" aria-label="切换视图">${H.mode === 'list' ? UI.icons.cal : UI.icons.list}</button>
        </div>
      </div>
      <section class="hm-card">
        <div class="hm-top">
          <div class="hm-l">
            <span class="hm-tag">本月支出${D.paw()}</span>
            <div class="hm-big"><small>¥</small>${money(sums.expense)}</div>
            <div class="hm-n">共 ${recs.length} 笔${recs.length ? ' · 最近一笔 ' + U.dayLabel(recs[0].date) : ''}</div>
            ${ck ? App.critic.bubbleHTML(ck) : ''}
          </div>
          <div class="hm-cat"><span class="hm-heart">${D.heart()}</span>${App.catArt.svg(App.budget.catId(), { w: 112, mood: ck ? App.critic.mood(ck) : 'happy' })}<span class="hm-purse">${D.purse()}</span></div>
        </div>
        <div class="hm-foot">${D.wave('hm-wave')}
          <div class="hm-f"><i>${D.coins()}</i><span><small>收入</small><b>¥${money(sums.income)}</b></span></div>
          <div class="hm-f"><i>${D.piggy()}</i><span><small>结余</small><b class="${bal < 0 ? 'neg' : ''}">${bal < 0 ? '-' : ''}¥${money(Math.abs(bal))}</b></span></div>
        </div>
      </section>
      ${budHTML}</div>`;
    return hero + `<div class="body">${App.cats.boxCardHTML()}${H.mode === 'list' ? listHTML(recs, '这个月还没有记录<br>点下面的 ＋ 记第一笔吧') : calHTML(recs)}</div>` + App.game.signFabHTML();
  };

  const calHTML = recs => {
    const [y, m] = H.ym.split('-').map(Number);
    const ws = App.S.settings.weekStart;
    const lead = (new Date(y, m - 1, 1).getDay() - ws + 7) % 7;
    const dim = U.dim(y, m);
    const by = {};
    recs.forEach(r => {
      const o = by[r.date] || (by[r.date] = { e: 0, i: 0 });
      if (r.type === 'expense') o.e += r.amount; else if (r.type === 'income') o.i += r.amount;
    });
    const today = U.today();
    let cells = '';
    for (let i = 0; i < lead; i++) cells += '<div class="cd blank"></div>';
    for (let d = 1; d <= dim; d++) {
      const ds = H.ym + '-' + U.pad(d), o = by[ds];
      cells += `<div class="cd${ds === H.sel ? ' sel' : ''}${ds === today ? ' today' : ''}" data-act="calDay" data-d="${ds}"><b>${d}</b>` +
        `<i class="ce">${o && o.e ? U.cell(o.e) : ''}</i><i class="ci2">${o && o.i ? '+' + U.cell(o.i) : ''}</i></div>`;
    }
    const heads = Array.from({ length: 7 }, (_, k) => `<div>${U.WD[(ws + k) % 7]}</div>`).join('');
    const dayRecs = recs.filter(r => r.date === H.sel);
    return `<div class="card cal"><div class="cal-head">${heads}</div><div class="cal-grid">${cells}</div></div>` +
      `<div class="day-head"><span><i class="dh-dot"></i>${U.dayLabel(H.sel)}<em>周${U.WD[U.wd(H.sel)]}</em><button class="rc-day" data-act="openReceipt" data-d="${H.sel}" aria-label="当日小票">${UI.icons.receipt}</button></span><span class="muted">${dayRecs.length ? dayRecs.length + ' 笔' : ''}</span></div>` +
      (dayRecs.length ? `<div class="card list">${dayRecs.map(r => App.recRow(r)).join('')}</div>` : '<div class="empty small"><p>这一天没有记录</p></div>');
  };

  A.homeMonth = () => App.pickMonth(H.ym, v => { H.ym = v; H.sel = v === U.curYM() ? U.today() : v + '-01'; App.render(false); });
  A.homeMode = () => { H.mode = H.mode === 'list' ? 'cal' : 'list'; if (H.sel.slice(0, 7) !== H.ym) H.sel = H.ym + '-01'; App.render(false); };
  A.calDay = el => { H.sel = el.dataset.d; App.render(true); };
  A.editRec = el => App.openEditor({ id: el.dataset.id });

  A.homeSearch = () => {
    let q = '';
    UI.sheet({
      title: '搜索', full: true,
      render: () => `<div class="search-box"><input id="sq" type="text" placeholder="搜备注、分类、账户或金额" autocomplete="off"></div><div id="sres"></div>`,
      onMount: h => {
        const input = h.body.querySelector('#sq'), res = h.body.querySelector('#sres');
        const run = () => {
          q = input.value.trim().toLowerCase();
          if (!q) { res.innerHTML = '<div class="empty small"><p>输入关键词开始搜索</p></div>'; return; }
          const list = App.sortDesc(App.S.records.filter(r => {
            const c = r.type === 'transfer' ? '转账' : App.cat(r.cat).name;
            const hay = [r.note || '', c, App.accName(r.acc), r.to ? App.accName(r.to) : '', U.money(r.amount), U.centsToStr(r.amount), r.date].join(' ').toLowerCase();
            return hay.includes(q);
          }));
          if (!list.length) { res.innerHTML = '<div class="empty small"><p>没有找到相关记录</p></div>'; return; }
          const s = App.sum(list);
          res.innerHTML = `<div class="day-head"><span>共 ${list.length} 笔</span><span class="muted">支出 ${money(s.expense)}　收入 ${money(s.income)}</span></div>` +
            `<div class="card list">${list.slice(0, 200).map(r => App.recRow(r, { showDate: true })).join('')}</div>` +
            (list.length > 200 ? '<p class="muted center pad">只显示最近 200 条，请缩小关键词</p>' : '');
        };
        input.addEventListener('input', run); run();
      }
    });
  };

  App.views.home = { render: homeRender };

  /* ================= 统计 ================= */
  const T = App.statsState = { scope: 'month', ym: U.curYM(), year: new Date().getFullYear(), type: 'expense', focus: -1 };

  const statsData = () => {
    const S = App.S, type = T.type;
    let recs, bars, labels, basis, names;
    if (T.scope === 'month') {
      const [y, m] = T.ym.split('-').map(Number), dim = U.dim(y, m);
      recs = App.recordsByMonth(T.ym).filter(r => r.type === type);
      bars = new Array(dim).fill(0);
      recs.forEach(r => { bars[+r.date.slice(8, 10) - 1] += r.amount; });
      labels = bars.map((_, i) => String(i + 1));
      names = bars.map((_, i) => m + '月' + (i + 1) + '日');
      basis = T.ym === U.curYM() ? +U.today().slice(8, 10) : (T.ym > U.curYM() ? dim : dim);
    } else {
      recs = S.records.filter(r => r.type === type && r.date.slice(0, 4) === String(T.year));
      bars = new Array(12).fill(0);
      recs.forEach(r => { bars[+r.date.slice(5, 7) - 1] += r.amount; });
      labels = bars.map((_, i) => String(i + 1));
      names = bars.map((_, i) => T.year + '年' + (i + 1) + '月');
      basis = T.year === new Date().getFullYear() ? new Date().getMonth() + 1 : 12;
    }
    const total = recs.reduce((a, r) => a + r.amount, 0);
    const map = {};
    recs.forEach(r => { const o = map[r.cat] || (map[r.cat] = { id: r.cat, sum: 0, n: 0 }); o.sum += r.amount; o.n++; });
    const cats = Object.values(map).sort((a, b) => b.sum - a.sum);
    const max = recs.reduce((a, r) => (!a || r.amount > a.amount ? r : a), null);
    return { recs, bars, labels, names, total, cats, max, avg: basis ? Math.round(total / basis) : 0 };
  };

  const barChart = (d) => {
    const W = 340, Hh = 132, pt = 10, pb = 20, n = d.bars.length;
    const max = Math.max(1, ...d.bars), bw = W / n, step = n > 12 ? 5 : 1;
    let s = `<svg class="chart" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none">`;
    s += `<line x1="0" x2="${W}" y1="${Hh - pb}" y2="${Hh - pb}" class="axis"/>`;
    d.bars.forEach((v, i) => {
      const h = v / max * (Hh - pt - pb), x = i * bw + bw * 0.2, w = bw * 0.6, y = Hh - pb - h;
      s += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(v ? 2 : 0, h).toFixed(1)}" rx="2" class="col${i === T.focus ? ' on' : ''}"/>`;
      if (i % step === 0 || i === n - 1 && step === 1) s += `<text x="${(i * bw + bw / 2).toFixed(1)}" y="${Hh - 5}" class="lab">${d.labels[i]}</text>`;
      s += `<rect x="${(i * bw).toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${Hh - pb}" fill="transparent" data-act="barFocus" data-i="${i}"/>`;
    });
    return s + '</svg>';
  };

  const donut = (d) => {
    const R = 42, C = 2 * Math.PI * R;
    let off = 0, segs = '';
    if (!d.total) segs = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="var(--line)" stroke-width="16"/>`;
    else d.cats.forEach((c, i) => {
      const len = C * c.sum / d.total, gap = d.cats.length > 1 ? Math.min(1.5, len) : 0, vis = Math.max(0, len - gap);
      segs += `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${PALETTE[i] || '#C9C2B4'}" stroke-width="16" stroke-dasharray="${vis.toFixed(2)} ${(C - vis).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 60 60)"/>`;
      off += len;
    });
    const unit = T.type === 'expense' ? '支出' : '收入';
    const rings = d.total ? '<circle cx="60" cy="60" r="50" fill="none" stroke="#3B2A00" stroke-width="1.6" opacity=".55"/><circle cx="60" cy="60" r="34" fill="none" stroke="#3B2A00" stroke-width="1.6" opacity=".55"/>' : '';
    return `<svg class="donut" viewBox="0 0 120 120">${segs}${rings}<text x="60" y="55" class="dl">总${unit}</text><text x="60" y="71" class="dv">${U.cell(d.total)}</text></svg>`;
  };

  // 分类预算进度（只在看「月 · 支出」时显示）
  const catBud = c => {
    const b = App.S.budget.cats[c.id];
    if (!b || T.type !== 'expense' || T.scope !== 'month') return '';
    const lv = App.budget.level(c.sum, b), pct = Math.round(c.sum / b * 100);
    return `<div class="rank-bud lv${lv}"><span>预算 ¥${money(b)} · 已用 ${pct}%</span><span>${c.sum > b ? '超支 ¥' + money(c.sum - b) : '还剩 ¥' + money(b - c.sum)}</span></div><div class="bd-bar slim ${App.budget.COLORS[lv]}"><i style="width:${Math.min(100, pct)}%"></i></div>`;
  };

  const statsRender = () => {
    const d = statsData();
    const unit = T.type === 'expense' ? '支出' : '收入';
    const nav = T.scope === 'month' ? U.ymLabel(T.ym) : T.year + '年';
    const hero = `<div class="hero slim">
      <div class="hero-top"><h2 class="hero-title">统计</h2>
        <div class="seg on-accent"><button data-act="statScope" data-v="month" class="${T.scope === 'month' ? 'on' : ''}">月</button><button data-act="statScope" data-v="year" class="${T.scope === 'year' ? 'on' : ''}">年</button></div>
      </div>
      <div class="period"><button class="icon-btn" data-act="statNav" data-v="-1">${UI.icons.back}</button><button class="period-label" data-act="statPick">${nav}<span class="caret">${UI.icons.down}</span></button><button class="icon-btn" data-act="statNav" data-v="1">${UI.icons.chev}</button></div>
    </div>`;
    const types = `<div class="seg wide"><button data-act="statType" data-v="expense" class="${T.type === 'expense' ? 'on' : ''}">支出</button><button data-act="statType" data-v="income" class="${T.type === 'income' ? 'on' : ''}">收入</button></div>`;
    const tiles = `<div class="tiles"><div><span>总${unit}</span><b>${money(d.total)}</b></div><div><span>${T.scope === 'month' ? '日均' : '月均'}</span><b>${money(d.avg)}</b></div><div><span>笔数</span><b>${d.recs.length}</b></div></div>`;
    const focusTxt = T.focus >= 0 && d.bars[T.focus] !== undefined
      ? `${d.names[T.focus]}　${unit} ${money(d.bars[T.focus])}`
      : (d.max ? `最大一笔：${App.cat(d.max.cat).name} ${money(d.max.amount)}` : '点一下柱子可以看当天/当月金额');
    const trend = `<div class="card pad"><div class="card-title">${T.scope === 'month' ? '每日' : '每月'}${unit}</div><div class="focus-txt">${esc(focusTxt)}</div>${barChart(d)}</div>`;
    let rank;
    if (!d.cats.length) rank = '<div class="empty small"><p>这段时间没有' + unit + '记录</p></div>';
    else {
      const top = d.cats[0].sum;
      rank = d.cats.map((c, i) => {
        const cat = App.cat(c.id);
        return `<div class="rank" data-act="statCat" data-id="${esc(c.id)}"><div class="ico" style="--ib:${App.icoBg(c.id)}">${cat.icon}</div><div class="rank-main">` +
          `<div class="rank-row"><span>${esc(cat.name)} <em>${(c.sum / d.total * 100).toFixed(1)}%</em></span><b>${money(c.sum)}</b></div>` +
          `<div class="bar thin"><i style="width:${Math.max(3, Math.round(c.sum / top * 100))}%;background:${PALETTE[i] || '#C9C2B4'}"></i></div>${catBud(c)}</div></div>`;
      }).join('');
    }
    const nativeBtn = window.__NATIVE_APP__ && d.cats.length ? '<button class="mini-btn" data-act="nativeChart">✨ 立体饼图</button>' : '';
    const cats = `<div class="card pad"><div class="card-title row">分类占比${nativeBtn}</div>${d.cats.length ? `<div class="donut-wrap">${donut(d)}</div>` : ''}${rank}</div>`;
    const ring = T.scope === 'month' && T.ym === U.curYM() ? App.smart.ringHTML() : '';
    return hero + `<div class="body">${ring}${types}${tiles}${trend}${cats}</div>`;
  };

  // 打开 Swift Charts 原生饼图（马卡龙色）
  A.nativeChart = () => {
    const d = statsData(), unit = T.type === 'expense' ? '支出' : '收入';
    const period = T.scope === 'month' ? U.ymLabel(T.ym) : T.year + '年';
    const items = d.cats.map((c, i) => ({ id: c.id, name: App.cat(c.id).name, amount: c.sum / 100, color: PALETTE[i] || '#E5DCCF' }));
    App.native('chart', { data: JSON.stringify({ title: period + ' ' + unit + '分类', total: d.total / 100, unit, items }) });
  };

  A.statScope = el => { T.scope = el.dataset.v; T.focus = -1; App.render(false); };
  A.statType = el => { T.type = el.dataset.v; T.focus = -1; App.render(true); };
  A.statNav = el => {
    const n = +el.dataset.v;
    if (T.scope === 'month') T.ym = U.ymAdd(T.ym, n); else T.year += n;
    T.focus = -1; App.render(true);
  };
  A.statPick = () => {
    if (T.scope === 'month') App.pickMonth(T.ym, v => { T.ym = v; T.focus = -1; App.render(true); });
    else {
      const cy = new Date().getFullYear();
      UI.pick({
        title: '选择年份', selected: T.year,
        items: Array.from({ length: 8 }, (_, i) => cy + 1 - i).map(y => ({ value: y, label: y + '年' })),
        onPick: v => { T.year = v; T.focus = -1; App.render(true); }
      });
    }
  };
  A.barFocus = el => { const i = +el.dataset.i; T.focus = T.focus === i ? -1 : i; App.render(true); };
  A.statCat = el => {
    const id = el.dataset.id, d = statsData();
    const list = App.sortDesc(d.recs.filter(r => r.cat === id));
    const cat = App.cat(id);
    UI.sheet({
      title: cat.icon + ' ' + cat.name, full: true, autoRefresh: true,
      render: () => {
        const cur = App.sortDesc(App.S.records.filter(r => r.cat === id && list.some(x => x.id === r.id)));
        const sum = cur.reduce((a, r) => a + r.amount, 0);
        if (!cur.length) return '<div class="empty small"><p>这里的记录都已经删除或改到别的分类了</p></div>';
        return `<div class="day-head"><span>共 ${cur.length} 笔</span><span class="muted">合计 ${money(sum)}</span></div><div class="card list">${cur.map(r => App.recRow(r, { showDate: true })).join('')}</div>`;
      }
    });
  };

  App.views.stats = { render: statsRender };

  /* ================= 资产 ================= */
  const assetsRender = () => {
    const S = App.S;
    let assets = 0, debt = 0;
    S.accounts.filter(a => !a.hidden).forEach(a => { const b = App.balance(a.id); if (b >= 0) assets += b; else debt += -b; });
    const hero = `<div class="hero slim"><div class="hero-top"><div class="hero-back"><button class="icon-btn" data-act="tab" data-t="mine" aria-label="返回">${UI.icons.back}</button><h2 class="hero-title">资产</h2></div></div>
      <div class="hero-main"><div class="lbl">净资产</div><div class="big"><small>¥</small>${money(assets - debt)}</div></div>
      <div class="hero-row two"><div><span>总资产</span><b>${money(assets)}</b></div><div><span>总负债</span><b>${money(debt)}</b></div></div></div>`;
    const order = ['cash', 'ewallet', 'bank', 'credit', 'invest', 'other'];
    const row = a => {
      const b = App.balance(a.id), t = App.ACC_TYPES[a.type] || App.ACC_TYPES.other;
      return `<div class="rec${a.hidden ? ' dim' : ''}" data-act="accDetail" data-id="${esc(a.id)}"><div class="ico">${t.i}</div><div class="rec-main"><div class="rec-title">${esc(a.name)}${a.hidden ? ' <i class="rec-flag">已隐藏</i>' : ''}</div><div class="rec-sub">${t.n}</div></div><div class="rec-amt ${b < 0 ? 'neg' : ''}">${money(b)}</div></div>`;
    };
    let groups = '';
    order.forEach(t => {
      const list = S.accounts.filter(a => a.type === t && !a.hidden);
      if (list.length) groups += `<div class="day-head"><span>${App.ACC_TYPES[t].n}</span></div><div class="card list">${list.map(row).join('')}</div>`;
    });
    const hid = S.accounts.filter(a => a.hidden);
    if (hid.length) groups += `<div class="day-head"><span>已隐藏</span></div><div class="card list">${hid.map(row).join('')}</div>`;
    return hero + `<div class="body">${groups}<button class="btn wide" data-act="accAdd">＋ 添加账户</button><p class="muted center pad">点账户可以查看流水、修改初始余额<br>在「＋」里选「转账」可以在账户间挪钱</p></div>`;
  };
  App.views.assets = { render: assetsRender };

  A.accAdd = () => App.openAccountForm();
  A.accDetail = el => {
    const id = el.dataset.id;
    UI.sheet({
      title: App.accName(id), full: true, autoRefresh: true,
      right: `<button class="icon-btn" data-act="accEdit" data-id="${esc(id)}" aria-label="编辑">✎</button>`,
      render: () => {
        const a = App.acc(id); if (!a) return '<div class="empty"><p>账户不存在</p></div>';
        const list = App.sortDesc(App.S.records.filter(r => r.acc === id || r.to === id));
        const b = App.balance(id);
        return `<div class="acc-sum"><span>当前余额</span><b class="${b < 0 ? 'neg' : ''}">¥${money(b)}</b></div>` +
          (list.length ? dayGroups(list.slice(0, 100)).map(g => dayHead(g.date, g.list) + `<div class="card list">${g.list.map(r => App.recRow(r)).join('')}</div>`).join('') : '<div class="empty small"><p>这个账户还没有流水</p></div>') +
          (list.length > 100 ? '<p class="muted center pad">只显示最近 100 条</p>' : '');
      }
    });
  };
  A.accEdit = el => App.openAccountForm(el.dataset.id);

  App.openAccountForm = id => {
    const S = App.S, a = id ? App.acc(id) : null;
    const st = { type: a ? a.type : 'cash' };
    UI.sheet({
      title: a ? '编辑账户' : '添加账户',
      render: () => {
        // 信用卡填「欠款」（存成负数）；其他账户按原样显示，负数前面带 -
        const iv = a ? (a.type === 'credit' ? -(a.init || 0) : (a.init || 0)) : 0;
        const initStr = iv ? (iv < 0 ? '-' : '') + U.centsToStr(Math.abs(iv)) : '';
        return `<div class="form">
          <label class="field"><span>名称</span><input id="af-name" type="text" maxlength="12" placeholder="例如：招商银行卡" value="${esc(a ? a.name : '')}"></label>
          <label class="field"><span>类型</span><select id="af-type">${Object.keys(App.ACC_TYPES).map(k => `<option value="${k}"${k === st.type ? ' selected' : ''}>${App.ACC_TYPES[k].i} ${App.ACC_TYPES[k].n}</option>`).join('')}</select></label>
          <label class="field"><span id="af-init-lbl">${st.type === 'credit' ? '当前欠款' : '初始余额'}</span><input id="af-init" type="text" inputmode="decimal" placeholder="0.00" value="${initStr}"></label>
          <p class="hint">初始余额是「开始记账那一刻」账户里的钱，之后的收支会自动加减。</p>
          <button class="btn primary wide" data-af="save">保存</button>
          ${a ? `<button class="btn ghost wide" data-af="hide">${a.hidden ? '取消隐藏' : '隐藏此账户'}</button><button class="btn danger wide" data-af="del">删除账户</button>` : ''}
        </div>`;
      },
      onMount: h => {
        const b = h.body;
        b.querySelector('#af-type').addEventListener('change', e => {
          st.type = e.target.value; b.querySelector('#af-init-lbl').textContent = st.type === 'credit' ? '当前欠款' : '初始余额';
        });
        b.addEventListener('click', e => {
          const btn = e.target.closest('[data-af]'); if (!btn) return;
          const act = btn.dataset.af;
          if (act === 'save') {
            const name = b.querySelector('#af-name').value.trim();
            if (!name) { UI.toast('请填写账户名称'); return; }
            if (S.accounts.some(x => x.name === name && (!a || x.id !== a.id))) { UI.toast('已经有同名账户了'); return; }
            const raw = b.querySelector('#af-init').value.trim().replace(/[,，\s]/g, '');
            let init = U.toCents(raw.replace(/^-/, ''));
            if (raw && !init && !/^-?0*\.?0*$/.test(raw)) { UI.toast('金额格式不对，只能填数字'); return; }
            if (raw.startsWith('-')) init = -init;
            if (st.type === 'credit') init = -init;
            if (a) { a.name = name; a.type = st.type; a.init = init; }
            else S.accounts.push({ id: U.uid('a'), name, type: st.type, init });
            App.changed(); h.close(); UI.toast('已保存');
          } else if (act === 'hide') {
            if (!a.hidden && App.visibleAccounts().length <= 1) { UI.toast('至少要保留一个账户'); return; }
            a.hidden = !a.hidden; App.changed(); h.close();
          } else if (act === 'del') {
            if (App.visibleAccounts().length <= 1 && !a.hidden) { UI.toast('至少要保留一个账户'); return; }
            if (App.accUsed(a.id)) { UI.toast('这个账户已有记录，不能删除，可以选择隐藏'); return; }
            UI.confirm({ title: '删除账户「' + a.name + '」？', ok: '删除', danger: true }).then(ok => {
              if (ok) { S.accounts = S.accounts.filter(x => x.id !== a.id); App.changed(); h.close(); UI.closeAll(); UI.toast('已删除'); }
            });
          }
        });
      }
    });
  };
})();

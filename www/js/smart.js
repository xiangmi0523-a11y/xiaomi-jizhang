/* 晓米记账 · 智能预算：收入 - 固定支出 - 期望储蓄 = 弹性额度，每天动态平摊，月底结余存进储蓄罐 */
(() => {
  'use strict';
  const App = window.App, U = App.U, UI = App.UI, A = App.A, esc = U.esc, money = U.money;
  const SB = App.smart = {};

  SB.REWARD = 10;      // 每个没超标的日子奖励金币
  SB.LOVE = 5;         // 猫咪好感 +5
  SB.SEVERE = 1.5;     // 当天花费超过额度 1.5 倍算严重超支

  const st = () => App.S.smart;
  const dim = ym => U.dim(+ym.slice(0, 4), +ym.slice(5, 7));
  const yuanInput = c => (c ? U.centsToStr(c) : '');

  SB.quota = (s = st()) => (s ? s.income - s.fixed - s.saving : 0);
  SB.on = () => !!(st() && st().on && SB.quota() > 0);

  const isFlex = fixedCats => r => r.type === 'expense' && !fixedCats.includes(r.cat);

  // 某月每天的弹性消费（下标 = 几号）
  SB.monthDays = (ym, fixedCats = st().fixedCats) => {
    const arr = new Array(dim(ym) + 1).fill(0), f = isFlex(fixedCats);
    App.S.records.forEach(r => { if (r.date.slice(0, 7) === ym && f(r)) arr[+r.date.slice(8, 10)] += r.amount; });
    return arr;
  };
  SB.flexSpent = (ym, fixedCats) => SB.monthDays(ym, fixedCats).reduce((a, b) => a + b, 0);

  // 某一天的额度 =（本月弹性额度 - 这天之前已花）÷ 从这天起剩下的天数
  SB.dayInfo = ds => {
    const ym = ds.slice(0, 7), d = +ds.slice(8, 10), days = SB.monthDays(ym), n = dim(ym);
    let before = 0;
    for (let i = 1; i < d; i++) before += days[i];
    const daysLeft = n - d + 1;
    const allow = Math.max(0, Math.floor((SB.quota() - before) / daysLeft));
    return { date: ds, allow, spent: days[d], left: allow - days[d], before, daysLeft };
  };
  SB.today = () => SB.dayInfo(U.today());
  SB.tomorrowAllow = () => {
    const t = SB.today(), n = dim(U.curYM()), d = +U.today().slice(8, 10);
    if (d >= n) return null;
    return Math.max(0, Math.floor((SB.quota() - t.before - t.spent) / (n - d)));
  };
  SB.month = () => {
    const ym = U.curYM(), quota = SB.quota(), spent = SB.flexSpent(ym), remain = quota - spent;
    return { ym, quota, spent, remain, pct: quota ? spent / quota : 0, expectSave: st().saving + remain };
  };

  // 严重超支：今天花了额度的 1.5 倍以上，或者本月弹性额度已经用超
  SB.stressed = () => {
    if (!SB.on()) return false;
    const t = SB.today();
    return SB.month().remain < 0 || (t.spent > 0 && t.spent > t.allow * SB.SEVERE);
  };

  /* ---------- 往月消费对比 ---------- */
  SB.history = fixedCats => {
    const cur = U.curYM(), out = [];
    for (let k = 1; k <= 6 && out.length < 3; k++) {
      const ym = U.ymAdd(cur, -k);
      if (App.S.records.some(r => r.type === 'expense' && r.date.slice(0, 7) === ym)) out.push(SB.flexSpent(ym, fixedCats));
    }
    if (!out.length) return null;
    return { n: out.length, avg: Math.round(out.reduce((a, b) => a + b, 0) / out.length) };
  };
  SB.hint = (quota, fixedCats) => {
    if (quota <= 0) return { tone: 'bad', text: '收入不够覆盖固定支出和期望储蓄，把储蓄目标调低一点试试～' };
    const h = SB.history(fixedCats);
    if (!h) return { tone: 'info', text: '还没有往月的记账数据，先按这个额度试一个月，下个月就能对照你的真实消费给建议啦～' };
    if (h.avg > quota * 1.05) {
      const diff = h.avg - quota;
      return { tone: 'warn', text: `你前 ${h.n} 个月平均每月弹性消费 ¥${money(h.avg)}，比建议额度多 ¥${money(diff)}，相当于每天要少花约 ¥${money(Math.round(diff / 30))}。可以先从奶茶、零食这类小开销省起～` };
    }
    if (h.avg < quota * 0.8) {
      return { tone: 'good', text: `你前 ${h.n} 个月平均每月只花了 ¥${money(h.avg)}，这个额度很宽裕，可以考虑把期望储蓄再提高 ¥${money(quota - h.avg)}。` };
    }
    return { tone: 'ok', text: `和你平时的消费水平差不多（前 ${h.n} 个月平均每月 ¥${money(h.avg)}），这个额度很合理，坚持住就能存下钱 👍` };
  };

  /* ---------- 环形图卡片（客栈 / 统计 / 详情页） ---------- */
  SB.ringHTML = (opts = {}) => {
    const tag = opts.static ? 'div' : 'button';
    if (!SB.on()) {
      return `<${tag} class="sb-card setup" data-act="openSmart"><span class="sb-cat">${App.catArt.svg(App.budget.catId(), { head: true, w: 48 })}</span>
        <span class="sb-main"><b>开启智能预算</b><span class="sb-l2">填收入和固定开销，帮你算出每天能花多少，省下的钱自动存进储蓄罐</span></span><span class="sb-go">›</span></${tag}>`;
    }
    const m = SB.month(), t = SB.today(), lv = App.budget.level(m.spent, m.quota);
    const R = 34, C = 2 * Math.PI * R, dash = C * Math.min(1, m.pct);
    return `<${tag} class="sb-card lv${lv}${opts.big ? ' big' : ''}" data-act="openSmart">
      <svg class="sb-ring" viewBox="0 0 90 90" aria-hidden="true">
        <circle cx="45" cy="45" r="${R}" class="trk"/>
        <circle cx="45" cy="45" r="${R}" class="val" stroke-dasharray="${dash.toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 45 45)"/>
        <text x="45" y="45" class="p">${Math.round(m.pct * 100)}%</text><text x="45" y="60" class="l">本月已花</text>
      </svg>
      <span class="sb-main">
        <span class="sb-l1">本月已花 <b>¥${money(m.spent)}</b> / 可用 ¥${money(m.quota)}</span>
        <span class="sb-l2">${t.left >= 0 ? `今天还能花 <b class="g">¥${money(t.left)}</b>` : `今天超出 <b class="r">¥${money(-t.left)}</b>`} · 今日额度 ¥${money(t.allow)}</span>
        <span class="sb-l3">${m.remain >= 0 ? `月底预计存下 ¥${money(m.expectSave)}（含计划储蓄）` : `弹性额度已超支 ¥${money(-m.remain)}，会动用储蓄`}</span>
      </span></${tag}>`;
  };

  /* ---------- 首次设置 / 修改计划 ---------- */
  SB.openSetup = () => {
    const s = st(), wasOn = SB.on();
    let fixedCats = s.fixedCats.slice();
    const cats = App.S.cats.expense.filter(c => !c.hidden);
    UI.sheet({
      title: wasOn ? '修改预算计划' : '智能预算 · 初次设置', full: true,
      render: () => `<div class="form sb-form">
        <div class="sb-intro">${App.catArt.svg(App.budget.catId(), { head: true, w: 58, mood: 'happy' })}<p>告诉我你每个月的收入和固定开销，我来帮你算出<b>每天能花多少</b>。没花完的钱，月底自动存进储蓄罐～</p></div>
        <label class="field"><span>月总收入</span><input id="sb-inc" type="text" inputmode="decimal" placeholder="例如 8000" value="${yuanInput(s.income)}"></label>
        <label class="field"><span>固定支出</span><input id="sb-fix" type="text" inputmode="decimal" placeholder="房租 / 房贷 / 话费等" value="${yuanInput(s.fixed)}"></label>
        <label class="field"><span>每月期望储蓄</span><input id="sb-sav" type="text" inputmode="decimal" placeholder="例如 2000" value="${yuanInput(s.saving)}"></label>
        <div class="sb-calc" id="sb-calc"></div>
        <div class="card-title pad-t">这些分类算「固定支出」</div>
        <p class="hint">记到这些分类的账，已经包含在上面的固定支出里，不会再占用每天的弹性额度。</p>
        <div class="sb-chips">${cats.map(c => `<button class="sb-chip${fixedCats.includes(c.id) ? ' on' : ''}" data-fc="${esc(c.id)}">${c.icon} ${esc(c.name)}</button>`).join('')}</div>
        <button class="btn primary wide" data-sb="save">${wasOn ? '保存修改' : '开始智能预算'}</button>
      </div>`,
      onMount: h => {
        const $ = id => h.body.querySelector(id);
        const vals = () => ({ income: U.toCents($('#sb-inc').value), fixed: U.toCents($('#sb-fix').value), saving: U.toCents($('#sb-sav').value) });
        const calc = () => {
          const v = vals(), q = SB.quota(v), hint = SB.hint(q, fixedCats);
          const n = dim(U.curYM()), d = +U.today().slice(8, 10);
          $('#sb-calc').innerHTML = v.income > 0
            ? `<div class="sb-formula">¥${money(v.income)} − ¥${money(v.fixed)} − ¥${money(v.saving)} =</div>
               <div class="sb-quota${q > 0 ? '' : ' bad'}"><span>建议每月弹性消费额度</span><b>¥${money(Math.max(0, q))}</b></div>
               ${q > 0 ? `<div class="sb-perday">平均每天约 ¥${money(Math.floor(q / n))}${d > 1 ? ` · 本月还剩 ${n - d + 1} 天` : ''}</div>` : ''}
               <div class="sb-hint ${hint.tone}">${esc(hint.text)}</div>`
            : '<div class="sb-hint info">先填一下月总收入吧～</div>';
        };
        calc();
        h.body.addEventListener('input', calc);
        h.body.addEventListener('click', e => {
          const chip = e.target.closest('[data-fc]');
          if (chip) {
            const id = chip.dataset.fc;
            fixedCats = fixedCats.includes(id) ? fixedCats.filter(x => x !== id) : fixedCats.concat(id);
            chip.classList.toggle('on', fixedCats.includes(id));
            calc(); return;
          }
          if (!e.target.closest('[data-sb="save"]')) return;
          const v = vals();
          if (v.income <= 0) { UI.toast('请先填写月总收入'); return; }
          if (SB.quota(v) <= 0) { UI.toast('收入不够覆盖固定支出和期望储蓄，调整一下吧', 2400); return; }
          Object.assign(s, v, { on: true, fixedCats });
          if (!wasOn) {   // 刚开启：从今天开始算，之前的日子不补发奖励
            if (!s.start) s.start = U.today();
            s.settled = U.addDays(U.today(), -1);
            s.closedYM = U.curYM();
          }
          App.changed(); h.close();
          UI.toast(wasOn ? '预算计划已更新' : '智能预算已开启！', 2000, 'gold');
          setTimeout(() => { SB.openDetail(); App.budget.check(); }, 260);
        });
      }
    });
  };

  /* ---------- 详情页 ---------- */
  SB.openDetail = () => {
    UI.sheet({
      title: '智能预算', full: true, autoRefresh: true,
      render: () => {
        if (!SB.on()) return '<div class="empty"><p>智能预算已关闭</p></div>';
        const s = st(), m = SB.month(), t = SB.today(), tm = SB.tomorrowAllow(), hint = SB.hint(m.quota, s.fixedCats);
        const days = [];
        for (let i = 6; i >= 0; i--) {
          const d = U.addDays(U.today(), -i);
          if (d < s.start) continue;
          days.push(SB.dayInfo(d));
        }
        const rows = days.map(x => {
          const isToday = x.date === U.today();
          const stt = isToday ? '<span class="sb-tag ing">进行中</span>' : x.spent <= x.allow ? '<span class="sb-tag ok">达标</span>' : x.spent > x.allow * SB.SEVERE ? '<span class="sb-tag bad">严重超支</span>' : '<span class="sb-tag warn">超出</span>';
          return `<div class="sb-day"><span>${U.dayLabel(x.date)}</span><span>额度 ¥${money(x.allow)}</span><span>已花 ¥${money(x.spent)}</span>${stt}</div>`;
        }).join('');
        const logs = Object.keys(s.log).sort().reverse().slice(0, 3).map(ym => {
          const L = s.log[ym];
          return `<div class="sb-day"><span>${U.ymLabel(ym)}</span><span>${L.leftover >= 0 ? '省下' : '超支'} ¥${money(Math.abs(L.leftover))}</span><span>存入 ¥${money(L.add)}</span></div>`;
        }).join('');
        return `<div class="sb-detail">
          ${SB.ringHTML({ static: true, big: true })}
          <div class="card pad sb-today">
            <div class="card-title">今天</div>
            <div class="sb-tri"><div><span>今日额度</span><b>¥${money(t.allow)}</b></div><div><span>已花</span><b>¥${money(t.spent)}</b></div><div><span>${t.left >= 0 ? '还能花' : '超出'}</span><b class="${t.left >= 0 ? 'g' : 'r'}">¥${money(Math.abs(t.left))}</b></div></div>
            <p class="hint">剩下的额度会平摊到本月剩余的 ${t.daysLeft} 天里${tm != null ? `；照现在的情况，明天起每天约 ¥${money(tm)}` : ''}。今天多花了，明天的额度就会自动调低。</p>
          </div>
          <div class="card pad">
            <div class="card-title">本月计划</div>
            <div class="sb-plan"><span>月总收入</span><b>¥${money(s.income)}</b></div>
            <div class="sb-plan"><span>− 固定支出</span><b>¥${money(s.fixed)}</b></div>
            <div class="sb-plan"><span>− 期望储蓄</span><b>¥${money(s.saving)}</b></div>
            <div class="sb-plan total"><span>= 弹性消费额度</span><b>¥${money(m.quota)}</b></div>
            <div class="sb-hint ${hint.tone}">${esc(hint.text)}</div>
          </div>
          <div class="card pad sb-jar">
            <div class="card-title">🐷 储蓄罐</div>
            <div class="sb-jar-row"><div><span>累计存下</span><b>¥${money(s.jar)}</b></div><div><span>本月预计存入</span><b class="${m.expectSave >= 0 ? 'g' : 'r'}">¥${money(m.expectSave)}</b></div></div>
            <p class="hint">每月结束时：计划储蓄 + 没花完的弹性额度，自动存进储蓄罐。${m.remain >= 0 ? `这个月目前还剩 ¥${money(m.remain)} 没花。` : `这个月已经超支 ¥${money(-m.remain)}，会从储蓄里扣。`}</p>
            ${logs ? `<div class="sb-days">${logs}</div>` : ''}
          </div>
          ${rows ? `<div class="card pad"><div class="card-title">最近几天</div><div class="sb-days">${rows}</div></div>` : ''}
          <div class="card pad sb-rules"><div class="card-title">🐾 和客栈的联动</div>
            <p>· 当天记了账、而且没超出当日额度：第二天打开 App 奖励 <b>${SB.REWARD} 金币</b>，猫咪好感 <b>+${SB.LOVE}</b>。</p>
            <p>· 当天花费超过额度 ${SB.SEVERE} 倍，或者本月弹性额度用超：客栈的猫咪会饿得没精神，还会提醒你少花点。</p></div>
          <button class="btn primary wide" data-sb="edit">修改预算计划</button>
          <button class="btn danger wide" data-sb="off">关闭智能预算</button>
        </div>`;
      },
      onMount: h => {
        h.body.addEventListener('click', e => {
          const b = e.target.closest('[data-sb]'); if (!b) return;
          if (b.dataset.sb === 'edit') { h.close(); setTimeout(SB.openSetup, 240); }
          if (b.dataset.sb === 'off') {
            UI.confirm({ title: '关闭智能预算？', msg: '储蓄罐和计划会保留，随时可以重新开启。', ok: '关闭', danger: true }).then(ok => {
              if (!ok) return;
              st().on = false; App.changed(); h.close(); UI.toast('智能预算已关闭');
            });
          }
        });
      }
    });
  };

  A.openSmart = () => (SB.on() ? SB.openDetail() : SB.openSetup());

  /* ---------- 小猫冒泡提醒（任何页面都能弹） ---------- */
  SB.nudge = (text, mood = 'worried') => {
    document.querySelectorAll('.cat-nudge').forEach(x => x.remove());
    const el = document.createElement('div');
    el.className = 'cat-nudge';
    el.innerHTML = `<span class="cn-cat">${App.catArt.svg(App.budget.catId(), { head: true, w: 58, mood })}</span><span class="cn-bubble">${esc(text)}</span>`;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('out'), 3600);
    setTimeout(() => el.remove(), 4000);
  };

  // 记完一笔后：今天超出额度 / 严重超支各提醒一次
  SB.check = () => {
    if (!SB.on()) return;
    const t = SB.today(), today = U.today();
    const lv = t.spent > 0 && t.spent > t.allow * SB.SEVERE ? 2 : t.spent > t.allow ? 1 : 0;
    const f = st().flag && st().flag.d === today ? st().flag.lv : 0;
    if (lv === f) return;
    st().flag = { d: today, lv };
    App.flush();
    if (lv === 2 && f < 2) SB.nudge('喵呜，客栈要破产啦，今天少花点钱吧！');
    else if (lv === 1 && f < 1) UI.toast(`今天已经超出额度 ¥${money(-t.left)} 啦，明天的额度会自动调低`, 2600);
  };

  /* ---------- 每日 / 每月结算（打开 App、回到前台、跨天时） ---------- */
  SB.settle = () => {
    if (!SB.on()) return null;
    const s = st(), today = U.today(), yest = U.addDays(today, -1), cur = U.curYM();
    const out = { days: 0, good: 0, bad: 0, coins: 0, months: [] };
    // 月结：上个月没花完的弹性额度 + 计划储蓄 → 储蓄罐
    if (s.closedYM && s.closedYM < cur) {
      for (let ym = s.closedYM; ym < cur; ym = U.ymAdd(ym, 1)) {
        if (ym < s.start.slice(0, 7)) continue;
        const quota = SB.quota(), spent = SB.flexSpent(ym), leftover = quota - spent, add = s.saving + leftover;
        s.jar += add;
        s.log[ym] = { quota, spent, leftover, add };
        out.months.push(Object.assign({ ym }, s.log[ym]));
      }
      s.closedYM = cur;
    }
    // 日结：当天记了账、且没超出当日额度 → 奖励
    let d = s.settled ? U.addDays(s.settled, 1) : s.start;
    if (d < s.start) d = s.start;
    for (let guard = 0; d <= yest && guard < 62; d = U.addDays(d, 1), guard++) {
      if (!App.S.records.some(r => r.date === d)) continue;
      const x = SB.dayInfo(d);
      out.days++;
      if (x.spent <= x.allow) out.good++;
      else if (x.spent > x.allow * SB.SEVERE) out.bad++;
    }
    if (!s.settled || s.settled < yest) s.settled = yest;
    if (out.good) {
      const n = Math.min(out.good, 7);
      out.coins = n * SB.REWARD;
      App.S.game.coins += out.coins;
      App.game.shown = null;
      if (App.mood && App.mood.bump) App.mood.bump(n * SB.LOVE);
    }
    return out;
  };

  const card = (mood, title, msg, cls) => () => {
    const el = document.createElement('div');
    el.className = 'wn good ' + (cls || '');
    el.innerHTML = `<div class="wn-card"><div class="wn-cat">${App.catArt.svg(App.budget.catId(), { w: 170, mood })}</div>
      <div class="wn-title">${title}</div><p class="wn-msg">${msg}</p>
      <div class="wn-btns"><button data-wn="ok" class="ok">好的喵～</button></div></div>`;
    el.addEventListener('click', e => { if (e.target.closest('[data-wn]') || e.target === el) App.budget.closeCard(el); });
    return el;
  };

  SB.run = () => {
    const r = SB.settle();
    if (!r) return;
    App.changed();
    r.months.forEach(L => {
      const msg = L.leftover >= 0
        ? `弹性额度还剩 ¥${money(L.leftover)} 没花，加上计划储蓄 ¥${money(L.add - L.leftover)}，一共存进储蓄罐 <b>¥${money(L.add)}</b>。<br>储蓄罐累计 ¥${money(st().jar)}`
        : `弹性额度超支了 ¥${money(-L.leftover)}，从计划储蓄里扣掉后，实际存进储蓄罐 <b>¥${money(L.add)}</b>。<br>储蓄罐累计 ¥${money(st().jar)}`;
      App.budget.enqueue(card(L.leftover >= 0 ? 'happy' : 'worried', `${U.ymLabel(L.ym)}结算完成`, msg));
    });
    if (r.good) {
      const title = r.days === 1 ? '昨天没有超出额度！' : `过去 ${r.days} 天有 ${r.good} 天没超出额度！`;
      App.budget.enqueue(card('happy', title, `奖励 <b>${r.coins} 金币</b>，客栈的猫咪们好感 +${Math.min(r.good, 7) * SB.LOVE}，今天也要继续加油喵～`));
    } else if (r.bad) {
      App.budget.enqueue(card('worried', '喵呜，客栈要破产啦…', `${r.days === 1 ? '昨天' : '最近'}花得有点多，超出了当日额度。今天少花点钱吧，猫咪们都饿了～`));
    }
  };
})();

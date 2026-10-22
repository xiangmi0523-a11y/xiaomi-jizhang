/* 晓米记账 · 存钱计划：365天 / 52周 / 12月 / 定额 / 自由存钱，打卡格子 + 进度 + 金币奖励 */
(() => {
  'use strict';
  const App = window.App, U = App.U, UI = App.UI, A = App.A, esc = U.esc, money = U.money;
  const SV = App.savings = {};
  SV.REWARD = 5;          // 每次打卡 +5 金币
  SV.DAILY_CAP = 5;       // 每天最多奖励 5 次
  SV.FINISH_BONUS = 100;  // 完成整个计划 +100 金币

  const st = () => App.S.saving;
  const short = c => { const y = c / 100; return y % 1 ? y.toFixed(1) : String(y); };

  SV.TPL = {
    d365: { name: '365天存钱', icon: '📅', color: '#FFB3C7', desc: '每天挑一个 1~365 的数字存进去，一年攒下一大笔', period: 'day',
      baseOpts: [[100, '1 元起，一年存 ¥66,795'], [10, '0.1 元起，一年存 ¥6,679.5']], cells: b => Array.from({ length: 365 }, (_, i) => (i + 1) * b), cellLabel: (i, a) => short(a) },
    w52: { name: '52周存钱', icon: '🗓️', color: '#FFE89A', desc: '第 n 周存 n 份，金额一周比一周多', period: 'week',
      baseOpts: [[1000, '每周递增 ¥10，一年存 ¥13,780'], [2000, '每周递增 ¥20，一年存 ¥27,560'], [5000, '每周递增 ¥50，一年存 ¥68,900']], cells: b => Array.from({ length: 52 }, (_, i) => (i + 1) * b), cellLabel: (i, a) => `第${i + 1}周<br>¥${short(a)}` },
    m12: { name: '12月存钱', icon: '🌙', color: '#A8E6CF', desc: '第 n 个月存 n 份，一年轻松攒一笔', period: 'month',
      baseOpts: [[10000, '每月递增 ¥100，一年存 ¥7,800'], [20000, '每月递增 ¥200，一年存 ¥15,600'], [50000, '每月递增 ¥500，一年存 ¥39,000']], cells: b => Array.from({ length: 12 }, (_, i) => (i + 1) * b), cellLabel: (i, a) => `${i + 1}月<br>¥${short(a)}` },
    fixed: { name: '定额存钱', icon: '🎯', color: '#B5D8FF', desc: '定一个目标，每次存固定的金额', cellLabel: (i, a) => `第${i + 1}次<br>¥${short(a)}` },
    free: { name: '自由存钱', icon: '🐷', color: '#FFC1A1', desc: '想存多少存多少，攒够目标为止' }
  };
  const FREQ = { day: '每天', week: '每周', month: '每月' };

  /* ---------- 计算 ---------- */
  SV.saved = p => p.log.reduce((a, l) => a + l.amt, 0);
  SV.target = p => (p.cells ? p.cells.reduce((a, b) => a + b, 0) : p.target);
  SV.period = p => (p.type === 'free' ? null : p.type === 'fixed' ? p.freq : SV.TPL[p.type].period);
  const weekStart = d => { const x = U.parse(d), ws = App.S.settings.weekStart; const back = (x.getDay() - ws + 7) % 7; return U.addDays(d, -back); };
  const samePeriod = (a, b, per) => (per === 'day' ? a === b : per === 'week' ? weekStart(a) === weekStart(b) : a.slice(0, 7) === b.slice(0, 7));
  SV.checkedNow = p => { const per = SV.period(p), t = U.today(); return !!per && p.log.some(l => samePeriod(l.d, t, per)); };
  SV.pending = p => !p.finishedAt && !!SV.period(p) && !SV.checkedNow(p);
  SV.active = () => st().plans.filter(p => !p.finishedAt);
  SV.pendingCount = () => SV.active().filter(SV.pending).length;
  const rewardedToday = () => st().plans.reduce((n, p) => n + p.log.filter(l => l.rw && l.d === U.today()).length, 0);

  /* ---------- 打卡 / 撤销 ---------- */
  const afterDeposit = (p, entry) => {
    let msg = `存入 ¥${money(entry.amt)}`;
    if (rewardedToday() < SV.DAILY_CAP) {
      entry.rw = 1; App.S.game.coins += SV.REWARD; App.game.shown = null; msg += `，奖励 ${SV.REWARD} 金币`;
    }
    if (!p.finishedAt && SV.saved(p) >= SV.target(p)) {
      p.finishedAt = U.today();
      if (!p.bonus) { p.bonus = 1; App.S.game.coins += SV.FINISH_BONUS; }
      App.changed();
      App.budget.enqueue(() => {
        const el = document.createElement('div');
        el.className = 'wn good';
        el.innerHTML = `<div class="wn-card"><div class="wn-cat">${App.catArt.svg(App.budget.catId(), { w: 170, mood: 'happy' })}</div>
          <div class="wn-title">存钱计划完成啦！🎉</div>
          <p class="wn-msg">「${esc(p.name)}」一共存下 <b>¥${money(SV.saved(p))}</b>，太厉害了！奖励 <b>${SV.FINISH_BONUS} 金币</b>，猫咪们为你骄傲喵～</p>
          <div class="wn-btns"><button data-wn="ok" class="ok">好耶！</button></div></div>`;
        el.addEventListener('click', e => { if (e.target.closest('[data-wn]') || e.target === el) App.budget.closeCard(el); });
        return el;
      });
      return;
    }
    App.changed();
    UI.toast(msg, 2000, 'gold');
    if (App.remind) App.remind.sync();
  };

  SV.depositCell = (p, idx) => {
    if (p.done[idx]) return;
    p.done[idx] = U.today();
    const entry = { d: U.today(), amt: p.cells[idx], idx };
    p.log.push(entry);
    afterDeposit(p, entry);
  };
  SV.depositFree = (p, amt) => {
    const entry = { d: U.today(), amt };
    p.log.push(entry);
    afterDeposit(p, entry);
  };
  SV.undo = (p, entry) => {
    p.log = p.log.filter(l => l !== entry);
    if (entry.idx != null) delete p.done[entry.idx];
    if (entry.rw) App.S.game.coins = Math.max(0, App.S.game.coins - SV.REWARD);
    if (p.finishedAt && SV.saved(p) < SV.target(p)) {
      p.finishedAt = null;
      if (p.bonus) { p.bonus = 0; App.S.game.coins = Math.max(0, App.S.game.coins - SV.FINISH_BONUS); }
    }
    App.game.shown = null;
    App.changed();
  };

  /* ---------- 「我的」页入口卡片 ---------- */
  SV.cardHTML = () => {
    const act = SV.active(), pend = SV.pendingCount();
    const total = st().plans.reduce((a, p) => a + SV.saved(p), 0);
    return `<button class="card sv-entry" data-act="openSavings"><span class="sv-pig">🐷</span>
      <span class="sv-entry-main"><b>存钱计划</b><small>${act.length ? `进行中 ${act.length} 项 · 已存 ¥${money(total)}` : '365天、52周、12月存钱…选一个开始吧'}</small></span>
      ${pend ? `<span class="sv-tag pend">${pend} 项待打卡</span>` : ''}<span class="mr">${UI.icons.chev}</span></button>`;
  };

  const planCard = p => {
    const t = SV.TPL[p.type], saved = SV.saved(p), target = SV.target(p), pct = target ? Math.min(100, Math.floor(saved / target * 100)) : 0;
    const tag = p.finishedAt ? '<span class="sv-tag done">已完成</span>' : SV.pending(p) ? '<span class="sv-tag pend">待打卡</span>' : SV.period(p) ? '<span class="sv-tag ok">已打卡</span>' : '';
    return `<button class="sv-plan" data-sv-open="${p.id}">${tag}
      <span class="sv-ic" style="background:${t.color}">${t.icon}</span>
      <span class="sv-plan-main"><b>${esc(p.name)}</b><span class="sv-target">¥${money(target)}</span></span>
      <span class="sv-pct">${pct}%</span>
      <span class="sv-bar"><i style="width:${pct}%"></i></span>
      <span class="sv-row"><span>已存入：¥${money(saved)}</span><span>剩余：¥${money(Math.max(0, target - saved))}</span></span>
    </button>`;
  };

  /* ---------- 存钱计划主页 ---------- */
  A.openSavings = () => {
    UI.sheet({
      title: '存钱计划', full: true, autoRefresh: true,
      render: () => {
        const act = SV.active(), done = st().plans.filter(p => p.finishedAt);
        return `<div class="sv-home">
          <div class="sv-hello">${App.catArt.svg(App.budget.catId(), { head: true, w: 54, mood: 'happy' })}<span class="sv-bubble">选择你的存钱计划吧喵～</span></div>
          <div class="sv-tpls">${Object.keys(SV.TPL).map(k => `<button class="sv-tpl" data-sv-new="${k}"><span class="sv-ic big" style="background:${SV.TPL[k].color}">${SV.TPL[k].icon}</span><b>${SV.TPL[k].name}</b></button>`).join('')}</div>
          <div class="sv-sec"><b>进行中</b><em>${act.length}项</em></div>
          ${act.length ? act.map(planCard).join('') : '<div class="empty small"><p>还没有进行中的计划，点上面挑一个开始存钱吧</p></div>'}
          ${done.length ? `<div class="sv-sec"><b>已完成</b><em>${done.length}项</em></div>${done.map(planCard).join('')}` : ''}
        </div>`;
      },
      onMount: h => {
        h.body.addEventListener('click', e => {
          const n = e.target.closest('[data-sv-new]'); if (n) { SV.openCreate(n.dataset.svNew); return; }
          const o = e.target.closest('[data-sv-open]'); if (o) SV.openDetail(o.dataset.svOpen);
        });
      }
    });
  };

  /* ---------- 新建计划 ---------- */
  SV.openCreate = type => {
    const t = SV.TPL[type];
    let base = t.baseOpts ? t.baseOpts[0][0] : 0, freq = 'day';
    UI.sheet({
      title: '新建 · ' + t.name, cls: 'tall',
      render: () => `<div class="form">
        <div class="sv-newhead"><span class="sv-ic big" style="background:${t.color}">${t.icon}</span><p>${esc(t.desc)}</p></div>
        <label class="field"><span>计划名称</span><input id="sv-name" type="text" maxlength="14" value="${esc(t.name)}"></label>
        ${t.baseOpts ? `<div class="card-title pad-t">金额档位</div><div class="sv-opts">${t.baseOpts.map(o => `<button class="sv-opt${o[0] === base ? ' on' : ''}" data-base="${o[0]}">${o[1]}</button>`).join('')}</div>` : ''}
        ${type === 'fixed' || type === 'free' ? '<label class="field"><span>目标金额</span><input id="sv-target" type="text" inputmode="decimal" placeholder="例如 5000"></label>' : ''}
        ${type === 'fixed' ? `<label class="field"><span>每次存</span><input id="sv-amount" type="text" inputmode="decimal" placeholder="例如 100"></label>
          <div class="seg wide">${Object.keys(FREQ).map(k => `<button data-freq="${k}" class="${k === freq ? 'on' : ''}">${FREQ[k]}</button>`).join('')}</div>` : ''}
        <button class="btn primary wide" data-sv="create">开始存钱</button>
      </div>`,
      onMount: h => {
        h.body.addEventListener('click', e => {
          const bo = e.target.closest('[data-base]');
          if (bo) { base = +bo.dataset.base; h.body.querySelectorAll('[data-base]').forEach(x => x.classList.toggle('on', x === bo)); return; }
          const fr = e.target.closest('[data-freq]');
          if (fr) { freq = fr.dataset.freq; h.body.querySelectorAll('[data-freq]').forEach(x => x.classList.toggle('on', x === fr)); return; }
          if (!e.target.closest('[data-sv="create"]')) return;
          const name = h.body.querySelector('#sv-name').value.trim() || t.name;
          const p = { id: U.uid('sv'), type, name, created: U.today(), done: {}, log: [], finishedAt: null, bonus: 0 };
          if (t.cells) { p.base = base; p.cells = t.cells(base); }
          if (type === 'fixed' || type === 'free') {
            const target = U.toCents(h.body.querySelector('#sv-target').value);
            if (target <= 0) { UI.toast('请填写目标金额'); return; }
            p.target = target;
          }
          if (type === 'fixed') {
            const amount = U.toCents(h.body.querySelector('#sv-amount').value);
            if (amount <= 0) { UI.toast('请填写每次存多少'); return; }
            if (amount > p.target) { UI.toast('每次存的钱不能比目标还多'); return; }
            const n = Math.ceil(p.target / amount);
            if (n > 1000) { UI.toast('次数太多啦，把每次的金额调大一点'); return; }
            p.amount = amount; p.freq = freq;
            p.cells = Array.from({ length: n }, (_, i) => (i < n - 1 ? amount : p.target - amount * (n - 1)));
            delete p.target;
          }
          st().plans.push(p);
          App.changed(); h.close();
          UI.toast('存钱计划已创建，今天就开始吧！', 2000, 'gold');
          setTimeout(() => SV.openDetail(p.id), 260);
        });
      }
    });
  };

  /* ---------- 计划详情：打卡 ---------- */
  SV.openDetail = id => {
    UI.sheet({
      title: '存钱计划', full: true, autoRefresh: true,
      render: () => {
        const p = st().plans.find(x => x.id === id);
        if (!p) return '<div class="empty"><p>这个计划已经删除了</p></div>';
        const t = SV.TPL[p.type], saved = SV.saved(p), target = SV.target(p), pct = target ? Math.min(100, saved / target * 100) : 0;
        const days = new Set(p.log.map(l => l.d)).size;
        const per = SV.period(p);
        const R = 40, C = 2 * Math.PI * R;
        let body = '';
        if (p.cells) {
          const count = Object.keys(p.done).length;
          body = `<div class="card-title row">点格子打卡存钱<em class="muted">${count}/${p.cells.length}</em></div>
            <div class="sv-grid ${p.type}">${p.cells.map((a, i) => `<button class="sv-cell${p.done[i] ? ' on' : ''}" data-cell="${i}">${p.type === 'd365' ? short(a) : t.cellLabel(i, a)}</button>`).join('')}</div>
            <p class="hint center">${p.type === 'd365' ? '每天挑一个数字，存对应的金额；点亮的格子再点一下可以撤销' : '按顺序或随意挑都可以；点亮的格子再点一下可以撤销'}</p>`;
        } else {
          body = `<button class="btn primary wide" data-sv="free">🐷 存一笔</button>`;
        }
        const logs = p.log.slice().reverse().slice(0, 8).map(l => `<div class="sv-log"><span>${U.dayLabel(l.d)}</span><b>+¥${money(l.amt)}</b></div>`).join('');
        return `<div class="sv-detail">
          <div class="card pad sv-head">
            <svg class="sv-ring" viewBox="0 0 100 100"><circle cx="50" cy="50" r="${R}" class="trk"/><circle cx="50" cy="50" r="${R}" class="val" stroke="${t.color}" stroke-dasharray="${(C * pct / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 50 50)"/><text x="50" y="48" class="p">${Math.floor(pct)}%</text><text x="50" y="64" class="l">${p.finishedAt ? '已完成' : '进度'}</text></svg>
            <div class="sv-head-main"><b>${t.icon} ${esc(p.name)}</b>
              <span>目标 ¥${money(target)}${per ? ' · ' + (p.type === 'fixed' ? FREQ[per] + '存 ¥' + money(p.amount) : FREQ[per] + '打卡') : ''}</span>
              <span>已存 <b class="g">¥${money(saved)}</b> · 还差 ¥${money(Math.max(0, target - saved))}</span>
              <span>坚持了 ${days} 天 · ${p.finishedAt ? U.dayLabel(p.finishedAt) + '完成' : SV.pending(p) ? '<em class="r">本' + ({ day: '天', week: '周', month: '月' }[per]) + '还没打卡</em>' : per ? '本期已打卡 ✓' : '随时都可以存'}</span>
            </div>
          </div>
          ${body}
          ${logs ? `<div class="card pad"><div class="card-title">最近存入</div>${logs}</div>` : ''}
          <p class="hint center">每次打卡奖励 ${SV.REWARD} 金币（每天最多 ${SV.DAILY_CAP} 次），完成计划再奖励 ${SV.FINISH_BONUS} 金币</p>
          <button class="btn danger wide" data-sv="del">删除这个计划</button>
        </div>`;
      },
      onMount: h => {
        h.body.addEventListener('click', e => {
          const p = st().plans.find(x => x.id === id); if (!p) return;
          const cell = e.target.closest('[data-cell]');
          if (cell) {
            const i = +cell.dataset.cell;
            if (p.done[i]) {
              const entry = p.log.find(l => l.idx === i);
              UI.confirm({ title: '撤销这次打卡？', msg: `会扣掉这次存入的 ¥${money(p.cells[i])}${entry && entry.rw ? '，并收回奖励的金币' : ''}`, ok: '撤销', danger: true })
                .then(ok => { if (ok && entry) SV.undo(p, entry); });
            } else {
              SV.depositCell(p, i);
              requestAnimationFrame(() => { const c = h.body.querySelector(`[data-cell="${i}"]`); if (c) c.classList.add('pop'); });
            }
            return;
          }
          const b = e.target.closest('[data-sv]'); if (!b) return;
          if (b.dataset.sv === 'free') {
            UI.prompt({ title: '存一笔', placeholder: '金额，比如 50', ok: '存入', max: 10 }).then(v => {
              if (v == null) return;
              const amt = U.toCents(v);
              if (amt <= 0) { UI.toast('请输入正确的金额'); return; }
              SV.depositFree(p, amt);
            });
          } else if (b.dataset.sv === 'del') {
            UI.confirm({ title: `删除「${p.name}」？`, msg: '打卡记录会一起删掉，已经领的金币不会收回', ok: '删除', danger: true }).then(ok => {
              if (!ok) return;
              st().plans = st().plans.filter(x => x.id !== id);
              App.changed(); h.close(); UI.toast('已删除');
            });
          }
        });
      }
    });
  };
})();

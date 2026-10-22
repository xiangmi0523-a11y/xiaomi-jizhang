/* 晓米记账 · 每晚记账提醒：到点还没记账才提醒，记过就不打扰；点通知直接弹记账面板 */
(() => {
  'use strict';
  const App = window.App, U = App.U, UI = App.UI, A = App.A, money = U.money;
  const R = App.remind = {};
  R.DAYS = 14;   // 预排未来 14 天（每次打开 App 都会续上）

  R.cfg = () => {
    const s = App.S.settings;
    if (!s.remind || typeof s.remind !== 'object') s.remind = { on: false, time: '21:00' };
    if (!/^\d{1,2}:\d{2}$/.test(s.remind.time || '')) s.remind.time = '21:00';
    return s.remind;
  };
  R.native = () => !!window.__NATIVE_APP__;

  // 今天有没有自己动手记过账（周期记账自动生成的不算）
  R.recordedToday = () => {
    const t = U.today();
    return App.S.records.some(r => !r.rec && U.ymd(new Date(r.ts || 0)) === t);
  };

  R.LINES = [
    '今天还没记账哦，花了什么记一笔吧～',
    '喵～今天的账还没记，猫咪在客栈等你呢',
    '睡前记一笔，明天的你会感谢今天的自己',
    '小钱也是钱，今天的开销记下来了吗？',
    '记完今天的账，猫咪就能安心睡觉啦',
    '连续 3 天不记账，客栈的猫咪会饿得睡着哦',
    '今天也辛苦啦，花一分钟记个账吧'
  ];
  R.body = (d, isToday) => {
    const day = Math.round(U.parse(d) / 86400000);
    let s = R.LINES[((day % R.LINES.length) + R.LINES.length) % R.LINES.length];
    if (isToday && App.smart && App.smart.on()) {
      const t = App.smart.today();
      s = t.left >= 0 ? `今天还能花 ¥${money(t.left)}，记一下今天的开销吧～` : `今天已经超出额度 ¥${money(-t.left)} 啦，记得把账补上哦`;
    }
    if (isToday && App.savings && App.savings.pendingCount() > 0) s += '（存钱计划也还没打卡）';
    return s;
  };

  R.build = () => {
    const c = R.cfg(), [hh, mm] = c.time.split(':').map(Number);
    const today = U.today(), now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
    const items = [];
    for (let i = 0; i < R.DAYS; i++) {
      const d = U.addDays(today, i);
      if (i === 0 && (R.recordedToday() || nowMin >= hh * 60 + mm)) continue;   // 今天记过 / 已过点 → 不提醒
      items.push({ id: 'xm-remind-' + d, date: d, hour: hh, minute: mm, title: '晓米记账', body: R.body(d, i === 0) });
    }
    return items;
  };

  let last = '';
  R.sync = force => {
    if (!R.native() || !App.S) return;
    const c = R.cfg();
    if (!c.on) { if (last !== 'off' || force) { App.native('notifyClear', {}); last = 'off'; } return; }
    const items = R.build();
    const key = items.map(i => i.id + i.hour + ':' + i.minute + i.body).join('|');
    if (key === last && !force) return;
    last = key;
    App.native('notifySchedule', { items });
  };

  // 原生层回调：通知权限
  R.onPerm = granted => {
    if (granted) {
      R.cfg().on = true; App.changed(); R.sync(true);
      UI.toast(`已开启，每天 ${R.cfg().time} 没记账会提醒你`, 2400, 'gold');
    } else {
      R.cfg().on = false; App.changed();
      UI.toast('通知被关掉了，请到 设置 → 通知 → 晓米记账 里打开', 3200);
    }
  };

  A.openRemind = () => {
    UI.sheet({
      title: '记账提醒', cls: 'compact', autoRefresh: true,
      render: () => {
        const c = R.cfg();
        return `<div class="form">
          <button class="field rm-toggle" data-rm="toggle"><span>每晚提醒我记账</span><span class="switch${c.on ? ' on' : ''}"><i></i></span></button>
          <label class="field"><span>提醒时间</span><input id="rm-time" type="time" value="${c.time}"></label>
          <p class="hint">到了这个时间，如果今天还没记账，猫咪会发通知提醒你；今天已经记过就不打扰。点通知会直接打开记账面板。</p>
          ${c.on ? '<button class="btn ghost wide" data-rm="test">发一条测试通知（5 秒后）</button>' : ''}
          ${R.native() ? '' : '<p class="hint">需要在 iPhone 上的晓米记账 App 里才能收到通知。</p>'}
        </div>`;
      },
      onMount: h => {
        h.body.addEventListener('change', e => {
          if (e.target.id !== 'rm-time' || !e.target.value) return;
          const v = e.target.value.slice(0, 5);   // 有的系统会给出 21:00:00，只取到分钟
          if (!/^\d{2}:\d{2}$/.test(v)) return;
          e.target.value = v;
          R.cfg().time = v; App.changed(); R.sync(true);
          UI.toast('提醒时间改成 ' + v);
        });
        h.body.addEventListener('click', e => {
          const b = e.target.closest('[data-rm]'); if (!b) return;
          if (b.dataset.rm === 'toggle') {
            if (R.cfg().on) { R.cfg().on = false; App.changed(); R.sync(true); UI.toast('已关闭记账提醒'); }
            else if (R.native()) App.native('notifyAuth', {});
            else UI.toast('需要在 iPhone 上的晓米记账 App 里开启');
          } else if (b.dataset.rm === 'test') {
            App.native('notifyTest', { title: '晓米记账', body: '测试成功！以后到点没记账，猫咪就会这样提醒你～' });
            UI.toast('5 秒后会收到一条测试通知，可以先回到桌面看看', 2600);
          }
        });
      }
    });
  };
})();

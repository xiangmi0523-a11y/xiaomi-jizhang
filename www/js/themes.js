/* 晓米记账 · 阶段七：主题商店（在客栈里用金币解锁，全局配色 + 客栈装修一起换） */
(() => {
  'use strict';
  const App = window.App, U = App.U, UI = App.UI, A = App.A, esc = U.esc;
  const T = App.themes = {};

  // pv：预览色 [顶栏, 页面底色, 客栈墙纸]
  const PV = {
    millet: ['#FFC53D', '#FFF9EC', '#FCE5C6'], peach: ['#FF9F7A', '#FFF4EE', '#FBE1D3'], mint: ['#5CD6A0', '#F1FBF6', '#DDF3E8'],
    sky: ['#6CB6FF', '#F1F7FF', '#DCEBFB'], grape: ['#A78BFA', '#F6F3FF', '#E7E0FB']
  };
  Object.keys(PV).forEach(k => { if (App.THEMES[k]) App.THEMES[k].pv = PV[k]; });
  Object.assign(App.THEMES, {
    sakura: { n: '樱花', c: '#FF8FB1', price: 200, premium: true, desc: '粉色樱花墙纸，窗外飘着花瓣', pv: ['#FF8FB1', '#FFF3F6', '#FFDCE6'] },
    matcha: { n: '抹茶', c: '#9BCB6E', price: 200, premium: true, desc: '清新的抹茶绿，像刚泡好的一杯茶', pv: ['#9BCB6E', '#F3F8EC', '#E1EED2'] },
    caramel: { n: '焦糖', c: '#E0A06A', price: 250, premium: true, desc: '暖暖的焦糖色，咖啡馆的味道', pv: ['#E0A06A', '#FBF3EA', '#F1DCC4'] },
    starry: { n: '星空', c: '#7C6CF0', price: 300, premium: true, dark: true, desc: '深色夜空主题，窗外有月亮和星星', pv: ['#4B3FB5', '#15172F', '#252A5C'] }
  });

  T.owned = k => !!App.THEMES[k] && (!App.THEMES[k].premium || App.S.game.themes.includes(k));

  T.apply = k => {
    App.S.settings.theme = k;
    App.applyTheme();
    App.changed();
  };

  T.storeHTML = () => {
    const cur = App.S.settings.theme, coins = App.game.coins();
    const card = k => {
      const t = App.THEMES[k], own = T.owned(k), using = cur === k;
      const tag = using ? '<span class="th-tag on">使用中</span>'
        : own ? '<span class="th-tag own">换上</span>'
          : `<span class="sp-price${coins < t.price ? ' poor' : ''}">${App.game.coinHTML(15)}${t.price}</span>`;
      return `<button class="th-card${using ? ' cur' : ''}${!own ? ' locked' : ''}" data-act="themePick" data-k="${k}">
        <span class="th-pv" style="background:${t.pv[1]}"><i class="pv-hero" style="background:${t.pv[0]}"></i><i class="pv-room" style="background:${t.pv[2]}"></i><i class="pv-card"></i>${t.dark ? '<i class="pv-star"></i>' : ''}${!own ? '<i class="pv-lock">🔒</i>' : ''}</span>
        <b>${esc(t.n)}${t.premium ? '' : ' <small>免费</small>'}</b>${t.desc ? `<small class="th-desc">${esc(t.desc)}</small>` : ''}${tag}</button>`;
    };
    const free = Object.keys(App.THEMES).filter(k => !App.THEMES[k].premium);
    const paid = Object.keys(App.THEMES).filter(k => App.THEMES[k].premium);
    return `<div class="shop-coins">我的金币 ${App.game.coinHTML(18)}<b>${coins}</b></div>
      <div class="card-title">限定主题</div><div class="th-grid">${paid.map(card).join('')}</div>
      <div class="card-title pad-t">基础主题</div><div class="th-grid">${free.map(card).join('')}</div>
      <p class="muted center pad">解锁后整个 App 的配色和客栈的装修都会跟着换<br>随时可以在这里或「我的 → 外观」切换</p>`;
  };

  A.themePick = el => {
    const k = el.dataset.k, t = App.THEMES[k];
    if (!t) return;
    if (App.S.settings.theme === k) { UI.toast('正在使用「' + t.n + '」'); return; }
    if (T.owned(k)) { T.apply(k); UI.toast('已换上「' + t.n + '」主题'); return; }
    if (App.game.coins() < t.price) { UI.toast(`金币不足（还差 ${t.price - App.game.coins()}），多记账、签到就能攒到哦`, 2400); return; }
    App.S.game.coins -= t.price;
    App.game.shown = null;
    App.S.game.themes.push(k);
    T.apply(k);
    UI.toast(`解锁成功！已换上「${t.n}」主题`, 2200, 'gold');
  };
})();

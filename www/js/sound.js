/* 晓米记账 · 全局音效（全部用 Web Audio API 现场合成，不需要任何音频文件，也不联网）
 *
 * 有哪些声音：
 *   meow  猫叫（每次音高、长短、腔调都随机，每只猫还有自己的嗓音）
 *   purr  呼噜声（猫在睡觉 / 吃到罐头）
 *   coin  记账保存：收银机「咔」一声 + 两声清脆的金币「叮叮」
 *   tap   底部导航切换：小水滴「啵」（很轻）
 *   warn  今天超出额度 / 本月超预算：两声低沉的「咚——咚」
 *
 * iOS 自动播放限制：声音引擎在第一次点屏幕（包括登录页的点按）时创建并「解锁」，
 * 从后台回来、来电打断后，下一次点按会自动恢复。
 * 设置（开关 / 音量 / 静音模式下是否发声）只存在这台设备上，不同步到云端。
 */
(() => {
  'use strict';
  const App = window.App, UI = App.UI, A = App.A;
  const SND = App.sound = {};
  const AC = window.AudioContext || window.webkitAudioContext;
  SND.supported = !!AC;

  /* ---------------- 设置 ---------------- */
  const cfg = () => {
    const st = App.S && App.S.settings;
    if (!st) return { on: true, vol: 0.8, loud: false };
    if (!st.sound || typeof st.sound !== 'object') st.sound = { on: true, vol: 0.8, loud: false };
    const s = st.sound;
    if (typeof s.on !== 'boolean') s.on = true;
    if (!(s.vol >= 0 && s.vol <= 1)) s.vol = 0.8;
    s.loud = !!s.loud;
    return s;
  };
  SND.on = () => SND.supported && cfg().on;

  /* ---------------- 引擎 + iOS 解锁 ---------------- */
  let ctx = null, master = null, out = null, noiseBuf = null, unlocked = false;
  const setSession = () => {
    const loud = cfg().loud;
    // Safari / iOS 16.4+：ambient = 跟随静音拨片、不打断后台音乐；playback = 静音模式下也响
    try { if (navigator.audioSession) navigator.audioSession.type = loud ? 'playback' : 'ambient'; } catch (e) { /* ignore */ }
    App.native('audioSession', { loud });
  };
  const ensure = () => {
    if (!AC) return null;
    if (!ctx) {
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { try { ctx = new AC(); } catch (e2) { return null; } }
      out = ctx.createDynamicsCompressor();          // 防止几个声音叠在一起时爆音
      out.threshold.value = -14; out.knee.value = 12; out.ratio.value = 6; out.attack.value = 0.002; out.release.value = 0.18;
      master = ctx.createGain(); master.gain.value = cfg().vol;
      master.connect(out); out.connect(ctx.destination);
      // 一段白噪声，给收银机、呼噜、气声用
      noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.6), ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      setSession();
    }
    return ctx;
  };
  const unlock = () => {
    const c = ensure(); if (!c) return;
    if (c.state !== 'running') { try { const p = c.resume(); if (p && p.catch) p.catch(() => { }); } catch (e) { /* ignore */ } }
    if (!unlocked) {
      // 老版本 iOS 需要在手势里真正「播放」一次才算解锁：放一个 1 帧的静音片段
      try { const b = c.createBuffer(1, 1, 22050), s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0); } catch (e) { /* ignore */ }
      if (c.state === 'running') unlocked = true;
      else setTimeout(() => { if (c.state === 'running') unlocked = true; }, 60);
    }
  };
  SND.unlock = unlock;
  SND.state = () => ctx ? ctx.state : 'none';
  // 每次点按都顺手检查一下（来电、切后台后 iOS 会把声音挂起成 interrupted / suspended）
  ['pointerdown', 'touchend', 'mousedown', 'keydown', 'click'].forEach(ev =>
    document.addEventListener(ev, () => { if (!ctx || ctx.state !== 'running') unlock(); }, { capture: true, passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !ctx) return;
    if (ctx.state !== 'running') { try { ctx.resume().catch(() => { }); } catch (e) { /* ignore */ } }
  });

  /* ---------------- 合成小工具 ---------------- */
  const R = (a, b) => a + Math.random() * (b - a);
  const env = (g, t, peak, a, hold, rel) => {    // 包络：起音 a 秒 → 保持 → 指数衰减
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    if (hold > 0) g.gain.setValueAtTime(peak, t + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + rel);
    return t + a + hold + rel;
  };
  const gainNode = (v, dest) => { const g = ctx.createGain(); g.gain.value = v; g.connect(dest || master); return g; };
  const osc = (type, f, dest) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.connect(dest); return o; };
  const noise = dest => { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.connect(dest); return s; };
  const filt = (type, f, q, dest) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.connect(dest); return b; };
  const stopAt = (nodes, t) => nodes.forEach(n => { try { n.stop(t + 0.05); } catch (e) { /* ignore */ } });

  // 金属感的「叮」：基频 + 两个不成倍数的泛音（像小铃铛 / 硬币）
  const bell = (t, f, vol, dur) => {
    const parts = [[1, 1], [2.76, 0.42], [5.4, 0.18], [8.93, 0.07]];
    const nodes = parts.map(([r, a]) => {
      const g = gainNode(0, master), o = osc(r === 1 ? 'triangle' : 'sine', f * r, g);
      env(g, t, vol * a, 0.002, 0, dur / (r === 1 ? 1 : r * 0.55));
      o.start(t); return o;
    });
    stopAt(nodes, t + dur);
  };

  /* ---------------- 各个声音 ---------------- */
  const SYN = {};
  const def = (name, gap, fn) => { SYN[name] = fn; return (...a) => play(name, t => fn(t, ...a), gap); };
  const last = {};
  const play = (name, fn, gap = 0.04) => {
    if (!SND.on()) return;
    const c = ensure(); if (!c) return;
    if (c.state !== 'running') { try { c.resume().catch(() => { }); } catch (e) { /* ignore */ } }
    const now = c.currentTime;
    if (last[name] && now - last[name] < gap) return;   // 连点时别叠成一团
    last[name] = now;
    master.gain.value = cfg().vol;
    try { fn(now + 0.012); } catch (e) { /* 声音出错不影响记账 */ }
  };

  // 水滴「啵」：正弦波音高快速上扬，很短、很轻
  SND.tap = def('tap', 0.05, (t) => {
    const g = gainNode(0, master), f0 = R(360, 430);
    const o = osc('sine', f0, g);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 3.1, t + 0.075);
    const end = env(g, t, 0.22, 0.004, 0.012, 0.09);
    const g2 = gainNode(0, master), o2 = osc('sine', f0 * 2, g2);   // 一点点泛音，听起来更「湿」
    o2.frequency.setValueAtTime(f0 * 2, t); o2.frequency.exponentialRampToValueAtTime(f0 * 5.6, t + 0.06);
    env(g2, t, 0.03, 0.003, 0, 0.05);
    o.start(t); o2.start(t); stopAt([o, o2], end);
  });

  // 收银机 + 金币：先一声「咔哒」，再两声上行的「叮——叮」，最后一点闪光
  SND.coin = def('coin', 0.12, (t, big) => {
    const nf = filt('bandpass', 3200, 1.4, gainNode(0.5, master)), ng = ctx.createGain(); ng.connect(nf);
    const n = noise(ng); env(ng, t, 0.55, 0.001, 0.008, 0.035); n.start(t); stopAt([n], t + 0.08);
    const lowG = gainNode(0, master), low = osc('square', 190, filt('lowpass', 900, 0.7, lowG));   // 抽屉弹出的「咔」
    env(lowG, t, 0.11, 0.001, 0, 0.05); low.start(t); stopAt([low], t + 0.08);
    const k = R(0.985, 1.02);
    bell(t + 0.05, 1568 * k, 0.32, 0.42);        // G6
    bell(t + 0.15, 2093 * k, 0.3, 0.7);          // C7
    if (big) bell(t + 0.25, 2637 * k, 0.2, 0.8); // E7：大额多一声
    for (let i = 0; i < 4; i++) bell(t + 0.2 + i * 0.045 + R(0, 0.02), R(4200, 6200), 0.035, 0.12);   // 闪光
  });

  // 低沉提示：两声往下走的「咚——咚」，柔和、不刺耳
  SND.warn = def('warn', 0.6, (t) => {
    const lp = filt('lowpass', 1500, 0.8, gainNode(1, master));
    [[0, 392, 0.16], [0.2, 294, 0.34]].forEach(([dt, f, len]) => {   // G4 → D4，手机喇叭也听得清，又不刺耳
      const g = ctx.createGain(); g.gain.value = 0; g.connect(lp);
      const sub = ctx.createGain(); sub.gain.value = 0.45; sub.connect(g);
      const buzz = ctx.createGain(); buzz.gain.value = 0.22; buzz.connect(g);
      const o1 = osc('triangle', f, g), o2 = osc('sine', f / 2, sub), o3 = osc('sawtooth', f, buzz);
      o1.frequency.setValueAtTime(f, t + dt); o1.frequency.linearRampToValueAtTime(f * 0.97, t + dt + len);
      const end = env(g, t + dt, 0.42, 0.012, len * 0.4, len);
      o1.start(t + dt); o2.start(t + dt); o3.start(t + dt); stopAt([o1, o2, o3], end);
    });
  });

  // 呼噜：带通噪声 + 25Hz 左右的起伏，两口气
  SND.purr = def('purr', 0.8, (t, len = 1.3) => {
    const bp = filt('bandpass', 480, 0.9, gainNode(1.5, master)), lp = filt('lowpass', 1300, 0.5, bp);   // 手机喇叭放不出 300Hz 以下，颗粒感放在 400~900Hz
    const amp = ctx.createGain(); amp.gain.value = 0; amp.connect(lp);
    const trem = ctx.createGain(); trem.gain.value = 0.5; trem.connect(amp.gain);
    const lfo = osc('sine', R(22, 27), trem);
    const src = noise(amp);
    const body = gainNode(0, lp), hum = osc('sawtooth', R(70, 82), body);   // 一点点「嗡」的喉音
    const half = len / 2;
    [0, half].forEach((dt, i) => {
      amp.gain.setValueAtTime(0.0001, t + dt);
      amp.gain.linearRampToValueAtTime(i ? 0.5 : 0.62, t + dt + 0.12);
      amp.gain.linearRampToValueAtTime(0.0001, t + dt + half - 0.04);
      body.gain.setValueAtTime(0.0001, t + dt); body.gain.linearRampToValueAtTime(0.18, t + dt + 0.12); body.gain.linearRampToValueAtTime(0.0001, t + dt + half - 0.04);
    });
    src.start(t); lfo.start(t); hum.start(t); stopAt([src, lfo, hum], t + len);
  });

  // 猫叫：锯齿波（声带）→ 两个会移动的共振峰（嘴型 i → a → u），加颤音和一点气声
  const voiceOf = id => { let h = 7; String(id || '').split('').forEach(ch => { h = (h * 31 + ch.charCodeAt(0)) % 997; }); return 0.86 + (h % 29) / 100; };
  const KINDS = ['mew', 'meow', 'meow', 'mrrp', 'mew2', 'long'];
  SND.meow = def('meow', 0.18, (t, o = {}) => {
    const kind = o.kind || KINDS[Math.floor(Math.random() * KINDS.length)];
    const base = R(520, 700) * voiceOf(o.id) * (o.sad ? 0.82 : 1);
    const len = { mew: R(0.2, 0.28), mew2: R(0.32, 0.4), meow: R(0.48, 0.62), long: R(0.7, 0.86), mrrp: R(0.4, 0.5) }[kind];
    const peak = { mew: 1.28, mew2: 1.18, meow: 1.32, long: 1.38, mrrp: 1.22 }[kind];
    const endF = o.sad ? 0.7 : { mew: 1.05, mew2: 0.9, meow: 0.78, long: 0.72, mrrp: 1.12 }[kind];

    const outG = gainNode(0, master);
    const f1 = filt('bandpass', 700, 5, outG), f2 = filt('bandpass', 1900, 7, outG), f3 = filt('bandpass', 3300, 9, outG);
    const mix = ctx.createGain(); mix.gain.value = 1;
    const g1 = gainNode(1.0, f1), g2 = gainNode(0.75, f2), g3 = gainNode(0.25, f3);
    [g1, g2, g3].forEach(g => mix.connect(g));
    const src = osc('sawtooth', base, mix);
    const src2 = osc('sawtooth', base * 1.004, mix);   // 两个略微错开的声源，更「肉」
    // 音高曲线：先上扬（喵），再往下滑（呜）
    [src, src2].forEach((s, i) => {
      const k = i ? 1.004 : 1;
      s.frequency.setValueAtTime(base * k * (kind === 'mrrp' ? 0.92 : 0.96), t);
      s.frequency.linearRampToValueAtTime(base * peak * k, t + len * (kind === 'mew' ? 0.55 : 0.32));
      s.frequency.linearRampToValueAtTime(base * endF * k, t + len);
    });
    // 颤音
    const vib = osc('sine', R(5.5, 7.5), gainNode(base * 0.018, src.frequency)); vib.start(t);
    // 嘴型：共振峰从「咪」(高 F2) 到「啊」再到「呜」(低 F2)
    f1.frequency.setValueAtTime(420, t); f1.frequency.linearRampToValueAtTime(980, t + len * 0.4); f1.frequency.linearRampToValueAtTime(o.sad ? 520 : 620, t + len);
    f2.frequency.setValueAtTime(2300, t); f2.frequency.linearRampToValueAtTime(1600, t + len * 0.45); f2.frequency.linearRampToValueAtTime(950, t + len);
    // 音量：「嗯」的鼻音起头，结尾慢慢收
    outG.gain.setValueAtTime(0.0001, t);
    outG.gain.linearRampToValueAtTime(0.5, t + 0.035);
    outG.gain.linearRampToValueAtTime(0.62, t + len * 0.35);
    outG.gain.linearRampToValueAtTime(0.4, t + len * 0.8);
    outG.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.06);
    // 「咕噜」的颤舌开头
    if (kind === 'mrrp') {
      const trill = ctx.createGain(); trill.gain.value = 0.45; trill.connect(outG.gain);
      const tl = osc('sine', 26, trill); tl.start(t); tl.stop(t + len * 0.45);
    }
    // 一点气声
    const bh = filt('highpass', 2500, 0.7, outG), ng = ctx.createGain(); ng.gain.value = 0.05; ng.connect(bh);
    const nz = noise(ng);
    src.start(t); src2.start(t); nz.start(t);
    stopAt([src, src2, vib, nz], t + len + 0.1);
  });

  // 离线渲染（测试 / 导出试听用）：把某个声音合成成一段 PCM，不经过扬声器
  SND._render = async (name, arg, secs = 1.6, rate = 44100) => {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const save = [ctx, master, out, noiseBuf];
    const oc = new OAC(1, Math.ceil(secs * rate), rate);
    ctx = oc; out = oc.createDynamicsCompressor();
    out.threshold.value = -14; out.knee.value = 12; out.ratio.value = 6; out.attack.value = 0.002; out.release.value = 0.18;
    master = oc.createGain(); master.gain.value = 0.8; master.connect(out); out.connect(oc.destination);
    noiseBuf = oc.createBuffer(1, Math.floor(rate * 1.6), rate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    try { SYN[name](0.01, arg); } finally { [ctx, master, out, noiseBuf] = save; }
    const buf = await oc.startRendering();
    return Array.from(buf.getChannelData(0));
  };

  /* ---------------- 设置面板 ---------------- */
  SND.label = () => !SND.supported ? '这台设备不支持' : (cfg().on ? '已开启 · 音量 ' + Math.round(cfg().vol * 100) : '已关闭');
  A.openSound = () => {
    unlock();
    UI.sheet({
      title: '音效', cls: 'compact', autoRefresh: true,
      render: () => {
        const s = cfg();
        return `<div class="form snd-form">
          <button class="field snd-row" data-snd="on"><span>开启音效</span><span class="switch${s.on ? ' on' : ''}"><i></i></span></button>
          <div class="snd-vol${s.on ? '' : ' off'}"><span>🔈</span><input type="range" min="0" max="100" step="5" value="${Math.round(s.vol * 100)}" data-snd="vol" aria-label="音量"><span>🔊</span></div>
          <button class="field snd-row" data-snd="loud"><span>静音模式下也有声音<small>关闭时跟随手机侧边的静音键，不会打断你正在听的音乐</small></span><span class="switch${s.loud ? ' on' : ''}"><i></i></span></button>
          <div class="card-title pad-t">试听</div>
          <div class="snd-try">
            <button data-snd="meow">🐱<span>喵呜</span></button><button data-snd="purr">😽<span>呼噜</span></button>
            <button data-snd="coin">🪙<span>记账</span></button><button data-snd="tap">💧<span>切换</span></button><button data-snd="warn">⚠️<span>超支</span></button>
          </div>
          <p class="hint">所有声音都是用代码现场合成的，不占空间、不用联网。点客栈里的猫会喵喵叫，保存一笔账会听到金币声，今天超出额度时会有一声低沉的提醒。</p>
        </div>`;
      },
      onMount: h => {
        h.body.addEventListener('click', e => {
          const b = e.target.closest('[data-snd]'); if (!b || b.tagName === 'INPUT') return;
          const s = cfg(), a = b.dataset.snd;
          if (a === 'on') { s.on = !s.on; App.flush(); h.update(); if (s.on) SND.tap(); return; }
          if (a === 'loud') { s.loud = !s.loud; App.flush(); setSession(); h.update(); return; }
          if (!s.on) { UI.toast('先打开音效再试听'); return; }
          if (a === 'meow') SND.meow({ id: App.budget && App.budget.catId && App.budget.catId() });
          else if (SND[a]) SND[a]();
        });
        h.body.addEventListener('input', e => {
          if (e.target.dataset.snd !== 'vol') return;
          cfg().vol = Math.max(0, Math.min(1, e.target.value / 100));
          if (master) master.gain.value = cfg().vol;
        });
        h.body.addEventListener('change', e => { if (e.target.dataset.snd === 'vol') { App.flush(); SND.tap(); } });
      }
    });
  };
})();

/* 晓米记账 · SVG 手绘猫咪（扁平粗描边画风 + 明暗立体感，配合 CSS 动画） */
(() => {
  'use strict';
  const App = window.App;
  const K = App.catArt = {};
  let uid = 0;

  // 每只猫的外观：底色 / 花纹色 / 白色部分 / 描边 / 花纹类型 / 眼睛 / 配饰
  K.LOOKS = {
    n1: { base: '#F3A65A', stripe: '#E2762A', white: '#FFF6E6', ol: '#5A2E1A', pattern: 'tabby' },                                  // 橘子：橘色虎斑
    n2: { base: '#F7D9A6', stripe: '#E7B977', white: '#FFF9EE', ol: '#6B4320', pattern: 'tabby', eye: 'smile' },                    // 豆包：奶油色，笑眯眯
    n3: { base: '#FCF8F2', stripe: '#EADFD2', white: '#FFFFFF', ol: '#6B5B53', pattern: 'none', nose: '#FF9FB0', spot: '#F4C48F' }, // 糯米：白色米团
    n4: { base: '#ADADB4', stripe: '#86868E', white: '#FAFAFA', ol: '#2A2A30', pattern: 'tabby' },                                   // 灰灰：灰白
    n5: { base: '#FFFAF2', stripe: '#E9DCCB', white: '#FFFFFF', ol: '#4A3426', pattern: 'calico', p1: '#F0A04B', p2: '#3D3232' },    // 麻薯：三花
    r1: { base: '#A3958A', stripe: '#7E6F62', white: '#F4EEE7', ol: '#2E241C', pattern: 'tabby', acc: 'glasses' },                  // 墨镜：戴墨镜的狸花
    r2: { base: '#36363E', stripe: '#2A2A31', white: '#36363E', ol: '#121216', pattern: 'none', eye: 'gold', nose: '#7A5C68', ear: '#6E5560' }, // 煤球：黑猫金瞳
    r3: { base: '#F8E2D8', stripe: '#EFC7B5', white: '#FFFFFF', ol: '#6B3B3B', pattern: 'none', acc: 'collar', blush: 0.8, spot: '#F2B4A2' }, // 桃桃：粉白 + 铃铛
    s1: { base: '#F4BE52', stripe: '#DD9A2C', white: '#FFF4D6', ol: '#5A3510', pattern: 'none', acc: 'mane', mane: '#C9822A' },     // 金鬃：狮子猫
    s2: { base: '#F6993A', stripe: '#3B2A1F', white: '#FFF5E8', ol: '#3B2A1F', pattern: 'tiger' }                                    // 虎妞：大老虎纹
  };

  const darken = (hex, k) => {
    const n = parseInt(hex.slice(1), 16);
    const f = c => Math.max(0, Math.round(c * (1 - k)));
    return '#' + [f(n >> 16), f((n >> 8) & 255), f(n & 255)].map(v => v.toString(16).padStart(2, '0')).join('');
  };

  const SW = 4.5;   // 描边粗细

  /* ---------- 部件 ---------- */
  const leg = (L, x, top, len, pair, far) => {
    const fill = far ? darken(L.base, 0.13) : L.base;
    const paw = far ? darken(L.white, 0.1) : L.white;
    return `<g class="xc-leg xc-leg-${pair}" style="transform-origin:${x + 10}px ${top}px">
      <path d="M${x} ${top}h20v${len - 10}a10 10 0 0 1-20 0z" fill="${fill}" stroke="${L.ol}" stroke-width="${SW}" stroke-linejoin="round"/>
      <ellipse cx="${x + 10}" cy="${top + len - 2}" rx="13" ry="8" fill="${paw}" stroke="${L.ol}" stroke-width="${SW}"/>
      <path d="M${x + 6} ${top + len - 4}v4.5M${x + 14} ${top + len - 4}v4.5" stroke="${L.ol}" stroke-width="2" stroke-linecap="round"/>
    </g>`;
  };

  const BODY = 'M74 96C72 78 104 74 138 76C170 78 188 92 184 120C181 144 160 150 132 150L98 150C76 150 68 128 74 96Z';
  const TAIL = 'M176 104C200 96 206 62 192 44C182 30 194 16 208 24';

  const tail = L => {
    let rings = '';
    if (L.pattern === 'tabby') rings = `<path d="${TAIL}" fill="none" stroke="${L.stripe}" stroke-width="12.5" stroke-linecap="butt" stroke-dasharray="5 10" stroke-dashoffset="-6"/>`;
    if (L.pattern === 'tiger') rings = `<path d="${TAIL}" fill="none" stroke="${L.stripe}" stroke-width="12.5" stroke-linecap="butt" stroke-dasharray="6 8" stroke-dashoffset="-4"/>`;
    if (L.pattern === 'calico') rings = `<path d="${TAIL}" fill="none" stroke="${L.p1}" stroke-width="12.5" stroke-dasharray="26 200" stroke-dashoffset="-34"/>`;
    const tuft = L.acc === 'mane' ? `<circle cx="208" cy="24" r="10" fill="${L.mane}" stroke="${L.ol}" stroke-width="${SW}"/>` : '';
    return `<g class="xc-tail">
      <path d="${TAIL}" fill="none" stroke="${L.ol}" stroke-width="21" stroke-linecap="round"/>
      <path d="${TAIL}" fill="none" stroke="${L.base}" stroke-width="12.5" stroke-linecap="round"/>
      ${rings}${tuft}
    </g>`;
  };

  const bodyPattern = L => {
    if (L.pattern === 'tabby') return [116, 132, 148, 164].map(x => `<path d="M${x} 72q-5 14 0 28" stroke="${L.stripe}" stroke-width="6" stroke-linecap="round" fill="none"/>`).join('');
    if (L.pattern === 'tiger') return [100, 114, 128, 142, 156, 170].map((x, i) => `<path d="M${x} 70q-7 ${16 + (i % 2) * 6} 2 ${34 + (i % 2) * 8}" stroke="${L.stripe}" stroke-width="7.5" stroke-linecap="round" fill="none"/>`).join('');
    if (L.pattern === 'calico') return `<ellipse cx="142" cy="90" rx="28" ry="19" fill="${L.p1}"/><ellipse cx="172" cy="112" rx="15" ry="13" fill="${L.p2}"/>`;
    return '';
  };

  const headPattern = L => {
    let s = '';
    if (L.spot) s += `<ellipse cx="84" cy="44" rx="11" ry="8" fill="${L.spot}"/>`;
    if (L.pattern === 'tabby') {
      s += `<path d="M58 34v11M66 32v13M74 34v11" stroke="${L.stripe}" stroke-width="4.5" stroke-linecap="round"/>`;
      s += `<path d="M24 64h11M25 72h8M108 64h-11M107 72h-8" stroke="${L.stripe}" stroke-width="4.5" stroke-linecap="round"/>`;
    }
    if (L.pattern === 'tiger') {
      s += `<path d="M55 38h22M57 45h18M55 52h22M66 36v18" stroke="${L.stripe}" stroke-width="4" stroke-linecap="round"/>`;
      s += `<path d="M23 60l13 4M23 70l11 2M109 60l-13 4M109 70l-11 2" stroke="${L.stripe}" stroke-width="5" stroke-linecap="round"/>`;
    }
    if (L.pattern === 'calico') s += `<ellipse cx="42" cy="48" rx="20" ry="17" fill="${L.p1}"/><ellipse cx="90" cy="44" rx="15" ry="12" fill="${L.p2}"/>`;
    return s;
  };

  const eyesOpen = L => {
    if (L.eye === 'gold') {
      return `<g class="xc-eyes">${[51, 81].map(x => `<ellipse cx="${x}" cy="70" rx="7.2" ry="8.2" fill="#F5D64A" stroke="${L.ol}" stroke-width="2"/><ellipse cx="${x}" cy="70.5" rx="2.4" ry="6.2" fill="#111"/><circle cx="${x + 2.4}" cy="66.6" r="1.8" fill="#fff"/>`).join('')}</g>`;
    }
    return `<g class="xc-eyes">${[51, 81].map(x => `<ellipse cx="${x}" cy="70" rx="5.8" ry="7" fill="#3A2216"/><circle cx="${x + 2}" cy="67.2" r="2.1" fill="#fff"/><circle cx="${x - 1.8}" cy="72.6" r="1" fill="#fff" opacity=".7"/>`).join('')}</g>`;
  };
  const eyesSmile = L => `<path d="M44 72q7-9 14 0M74 72q7-9 14 0" fill="none" stroke="${L.ol}" stroke-width="3.6" stroke-linecap="round"/>`;

  const mane = L => {
    const pts = [];
    for (let i = 0; i < 32; i++) {
      const a = i / 32 * Math.PI * 2, r = i % 2 ? 50 : 60;
      pts.push((66 + Math.cos(a) * r * 1.05).toFixed(1) + ' ' + (70 + Math.sin(a) * r * 0.95).toFixed(1));
    }
    return `<path d="M${pts.join('L')}Z" fill="${L.mane}" stroke="${L.ol}" stroke-width="${SW}" stroke-linejoin="round"/>`;
  };

  const head = (L, u, mood) => {
    const inner = L.ear || '#F6B0A2';
    const nose = L.nose || '#F28C8C';
    const blush = L.blush == null ? 0.5 : L.blush;
    const sad = mood === 'worried', mad = mood === 'angry';
    let face = '';
    // 眼睛：普通睁眼（会眨）/ 笑眯眯；点一下会临时变成笑眼
    if (L.eye === 'smile') face += eyesSmile(L);
    else face += `<g class="eo">${eyesOpen(L)}</g><g class="es">${eyesSmile(L)}</g>`;
    // 眉毛
    if (sad) face += `<path d="M42 58l13-4M77 54l13 4" stroke="${L.ol}" stroke-width="3.2" stroke-linecap="round"/>`;
    if (mad) face += `<path d="M42 54l14 6M76 60l14-6" stroke="${L.ol}" stroke-width="3.6" stroke-linecap="round"/>`;
    // 鼻子嘴巴
    face += `<path d="M61.5 79.5h9l-4.5 5.2z" fill="${nose}" stroke="${L.ol}" stroke-width="1.6" stroke-linejoin="round"/>`;
    if (sad) face += `<path d="M59 92q7-6 14 0" fill="none" stroke="${L.ol}" stroke-width="3" stroke-linecap="round"/>`;
    else if (mad) face += `<path d="M58 93l4-4 4 4 4-4 4 4" fill="none" stroke="${L.ol}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`;
    else face += `<path d="M58 86q4 5 8 0q4 5 8 0" fill="none" stroke="${L.ol}" stroke-width="2.8" stroke-linecap="round"/>`;
    // 腮红
    face += `<ellipse cx="35" cy="84" rx="8" ry="5" fill="#FF8C9E" opacity="${mad ? 0.85 : blush}"/><ellipse cx="97" cy="84" rx="8" ry="5" fill="#FF8C9E" opacity="${mad ? 0.85 : blush}"/>`;
    // 胡须
    face += `<path d="M28 82L5 77M28 88L7 94M104 82L127 77M104 88L125 94" stroke="${L.ol}" stroke-width="2" stroke-linecap="round"/>`;
    // 配饰
    if (L.acc === 'glasses') face += `<g><rect x="37" y="62" width="27" height="17" rx="7" fill="#1E1E26" stroke="${L.ol}" stroke-width="2.5"/><rect x="68" y="62" width="27" height="17" rx="7" fill="#1E1E26" stroke="${L.ol}" stroke-width="2.5"/><path d="M64 68h4" stroke="${L.ol}" stroke-width="3"/><path d="M42 67l7-3M73 67l7-3" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".55"/></g>`;
    if (L.acc === 'collar') face += `<path d="M38 99Q66 113 94 99" fill="none" stroke="${L.ol}" stroke-width="10" stroke-linecap="round"/><path d="M38 99Q66 113 94 99" fill="none" stroke="#FF6F91" stroke-width="6" stroke-linecap="round"/><circle cx="66" cy="108" r="6" fill="#FFD34D" stroke="${L.ol}" stroke-width="2.2"/><path d="M63 108h6" stroke="${L.ol}" stroke-width="1.6"/>`;
    // 心情标记
    if (sad) face += `<path d="M40 79q-3 6 0 8q3-2 0-8z" fill="#7CC3FF" stroke="#3E8BD6" stroke-width="1.4" class="xc-tear"/>`;
    if (mad) face += `<g class="xc-anger" transform="translate(104 30)"><path d="M-9-3q6 0 6-6M3-9q0 6 6 6M9 3q-6 0-6 6M-3 9q0-6-6-6" fill="none" stroke="#E8344A" stroke-width="3.4" stroke-linecap="round"/></g>`;

    return `<g class="xc-head">
      ${L.acc === 'mane' ? mane(L) : ''}
      <g class="xc-ear-l"><path d="M30 54L34 12L64 32Z" fill="${L.pattern === 'calico' ? L.p1 : L.base}" stroke="${L.ol}" stroke-width="${SW}" stroke-linejoin="round"/><path d="M39 44L41 24L55 34Z" fill="${inner}"/></g>
      <g class="xc-ear-r"><path d="M68 32L98 12L102 54Z" fill="${L.pattern === 'calico' ? L.p2 : L.base}" stroke="${L.ol}" stroke-width="${SW}" stroke-linejoin="round"/><path d="M77 34L91 24L93 44Z" fill="${inner}"/></g>
      <ellipse cx="66" cy="68" rx="42" ry="36" fill="${L.base}"/>
      <g clip-path="url(#h${u})">${headPattern(L)}<ellipse cx="66" cy="90" rx="27" ry="16" fill="${L.white}"/><ellipse cx="66" cy="68" rx="42" ry="36" fill="url(#g${u})"/></g>
      <ellipse cx="66" cy="68" rx="42" ry="36" fill="none" stroke="${L.ol}" stroke-width="${SW}"/>
      ${face}
    </g>`;
  };

  /* ---------- 组装 ----------
     opts: { mood: 'normal'|'happy'|'worried'|'angry', head: 只画头, cls: 额外 class, w: 宽度(px) } */
  K.svg = (id, o = {}) => {
    const L = Object.assign({ pattern: 'tabby', eye: 'dot' }, K.LOOKS[id] || K.LOOKS.n1);
    const u = 'xc' + (++uid);
    const mood = o.mood || 'normal';
    const defs = `<defs>
      <clipPath id="b${u}"><path d="${BODY}"/></clipPath>
      <clipPath id="h${u}"><ellipse cx="66" cy="68" rx="42" ry="36"/></clipPath>
      <radialGradient id="g${u}" cx="34%" cy="26%" r="80%"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".42" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".2"/></radialGradient>
    </defs>`;
    const delay = o.delay != null ? o.delay : -(Math.random() * 4).toFixed(2);
    const style = `--dl:${delay}s;${o.w ? `width:${o.w}px;` : ''}`;
    const cls = `xc mood-${mood}${mood === 'happy' ? ' happy' : ''}${o.cls ? ' ' + o.cls : ''}`;
    if (o.head) {
      return `<span class="${cls} xc-headonly" style="${style}"><svg viewBox="0 -6 132 132" aria-hidden="true">${defs}${head(L, u, mood)}</svg></span>`;
    }
    const body = `<g class="xc-body">
      <path d="${BODY}" fill="${L.base}"/>
      <g clip-path="url(#b${u})">${bodyPattern(L)}<ellipse cx="86" cy="118" rx="22" ry="30" fill="${L.white}"/><ellipse cx="132" cy="154" rx="54" ry="16" fill="${L.white}"/><path d="${BODY}" fill="url(#g${u})"/></g>
      <path d="${BODY}" fill="none" stroke="${L.ol}" stroke-width="${SW}" stroke-linejoin="round"/>
    </g>`;
    return `<span class="${cls}" style="${style}"><svg viewBox="0 0 220 178" aria-hidden="true">${defs}
      <ellipse class="xc-shadow" cx="124" cy="167" rx="70" ry="7.5" fill="#3B2A00" opacity=".16"/>
      <g class="xc-all">
        ${tail(L)}
        ${leg(L, 90, 116, 46, 'b', true)}${leg(L, 143, 116, 46, 'a', true)}
        ${body}
        ${leg(L, 67, 118, 46, 'a', false)}${leg(L, 157, 118, 46, 'b', false)}
        ${head(L, u, mood)}
      </g></svg></span>`;
  };

  // 预算心情：0 正常 / 1 担心 / 2 生气
  K.moodFor = level => (level >= 2 ? 'angry' : level === 1 ? 'worried' : 'normal');
})();

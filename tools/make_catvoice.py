"""把 assets-src/sounds/raw 里的 CC0 真猫录音剪成短片段、统一响度，编码成 mp3 后内嵌到 www/js/catvoice.js
（内嵌成 base64：App 里、网页里、离线时都能直接用，不需要额外的音频文件）
运行：python3 tools/make_catvoice.py
"""
import base64, os, subprocess, tempfile, numpy as np
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
RAW = os.path.join(ROOT, 'assets-src', 'sounds', 'raw')
SR = 44100
# (文件, 开始秒, 结束秒, 目标响度 dBFS RMS)
CLIPS = {
    'mew': [
        ('bsb_0098.mp3', 0.10, 0.76, -15), ('bsb_0098.mp3', 1.08, 1.80, -15),
        ('bsb_0098.mp3', 2.16, 2.78, -15), ('bsb_0098.mp3', 3.20, 4.02, -15),
        ('cat_mewfood.wav', 0.55, 0.88, -15), ('cat_mewpurr.wav', 0.00, 1.10, -16),
        ('cat_softmew.wav', 0.35, 1.10, -16), ('cat_softmew.wav', 1.36, 2.06, -16),
    ],
    # mew 里第 6、7 段是轻柔的「咪」，心情差的猫用它们；第 5 段带呼噜
    'happy': [('cat_mewpurr2.wav', 0.12, 1.98, -16)],
    'purr': [('cat_purrsleepy_loop.wav', 0.00, 2.20, -19)],
    'purrActive': [('cat_purractive_loop.wav', 0.00, 1.55, -18)],
}
def load(f):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', os.path.join(RAW, f), '-ac', '1', '-ar', str(SR), '-af', 'highpass=f=140', '-f', 's16le', '-'], capture_output=True).stdout
    return np.frombuffer(raw, '<i2').astype(np.float32) / 32768
cache = {}
out = {}
prev_dir = os.path.join(ROOT, 'assets-src', 'sounds', 'clips'); os.makedirs(prev_dir, exist_ok=True)
for group, items in CLIPS.items():
    out[group] = []
    for k, (f, a, b, db) in enumerate(items):
        x = cache.setdefault(f, load(f))[int(a * SR):int(b * SR)].copy()
        fi, fo = int(0.012 * SR), int(0.08 * SR)
        x[:fi] *= np.linspace(0, 1, fi); x[-fo:] *= np.linspace(1, 0, fo) ** 1.5
        act = x[np.abs(x) > 0.01] if (np.abs(x) > 0.01).sum() > 100 else x
        rms = np.sqrt(np.mean(act ** 2)) + 1e-9
        x *= 10 ** (db / 20) / rms
        pk = np.abs(x).max()
        if pk > 0.89: x *= 0.89 / pk                     # 峰值 -1dB 以内
        with tempfile.NamedTemporaryFile(suffix='.raw', delete=False) as t: t.write((x * 32767).astype('<i2').tobytes())
        mp3 = os.path.join(prev_dir, f'{group}{k}.mp3')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 's16le', '-ar', str(SR), '-ac', '1', '-i', t.name, '-c:a', 'libmp3lame', '-b:a', '96k', mp3], check=True)
        os.unlink(t.name)
        out[group].append(base64.b64encode(open(mp3, 'rb').read()).decode())
        print(f'{group}{k}: {f} {a}-{b}s  {len(x)/SR:.2f}s  {os.path.getsize(mp3)//1024}KB  peak {np.abs(x).max():.2f}')
js = ['/* 晓米记账 · 真猫录音（自动生成，别手改：python3 tools/make_catvoice.py）',
      ' * 录音来源（都是 CC0 公共领域，可自由使用）：',
      ' *   BigSoundBank「Small mewing of a cat」Joseph SARDIN  https://bigsoundbank.com/small-mewing-of-a-cat-s0098.html',
      ' *   OpenGameArt「Cat purr / meow」Kerzoven            https://opengameart.org/content/cat-purr-meow',
      ' */',
      'window.XM_CATVOICE = {']
for g, arr in out.items():
    js.append(f'  {g}: [' + ', '.join(f'"{s}"' for s in arr) + '],')
js.append('};\n')
p = os.path.join(ROOT, 'www', 'js', 'catvoice.js'); open(p, 'w').write('\n'.join(js))
print('catvoice.js', os.path.getsize(p) // 1024, 'KB')

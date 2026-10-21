"""把 tools/icon.svg 渲染成 1024 PNG，并生成 iOS 各尺寸 AppIcon（无透明通道）。
用法: python3 tools/make_icons.py  （需要 playwright + chromium 和 Pillow）"""
import json, os, subprocess, sys
from PIL import Image

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
svg = os.path.join(root, 'tools', 'icon.svg')
out_dir = os.path.join(root, 'ios', 'Assets.xcassets', 'AppIcon.appiconset')
big = os.path.join(root, 'tools', 'icon-1024.png')

from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1024, 'height': 1024})
    pg.goto('file://' + svg)
    pg.screenshot(path=big)
    b.close()

base = Image.open(big).convert('RGB')
specs = [('20', 2), ('20', 3), ('29', 2), ('29', 3), ('40', 2), ('40', 3), ('60', 2), ('60', 3)]
images, done = [], set()
for size, scale in specs:
    px = int(round(float(size) * scale))
    name = f'icon-{px}.png'
    if name not in done:
        base.resize((px, px), Image.LANCZOS).save(os.path.join(out_dir, name))
        done.add(name)
    images.append({'idiom': 'iphone', 'scale': f'{scale}x', 'size': f'{size}x{size}', 'filename': name})
base.save(os.path.join(out_dir, 'icon-1024.png'))
images.append({'idiom': 'ios-marketing', 'scale': '1x', 'size': '1024x1024', 'filename': 'icon-1024.png'})
with open(os.path.join(out_dir, 'Contents.json'), 'w') as f:
    json.dump({'images': images, 'info': {'author': 'xcode', 'version': 1}}, f, indent=2)
print('icons ok', sorted(done))

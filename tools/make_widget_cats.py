"""把 www/js/catart.js 里的 SVG 猫渲染成 PNG，给桌面小组件用（WidgetKit 不能直接显示 SVG）。
用法: python3 tools/make_widget_cats.py   （需要 playwright + chromium）"""
import json, os, http.server, socketserver, threading, functools
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
www = os.path.join(root, 'www')
out = os.path.join(root, 'ios', 'Widget', 'Assets.xcassets')
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=www); H.log_message = lambda *a: None
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(('127.0.0.1', 8799), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
html = '''<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="http://127.0.0.1:8799/css/style.css">
<style>html,body{background:transparent!important;position:static;overflow:visible;margin:0}*{animation-play-state:paused!important;animation-delay:0s!important}
.c{display:inline-block;padding:4px}</style></head><body><script>window.App={};</script>
<script src="http://127.0.0.1:8799/js/catart.js"></script><div id="r"></div></body></html>'''
from playwright.sync_api import sync_playwright
ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'r1', 'r2', 'r3', 's1', 's2']
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(device_scale_factor=3)
    pg.set_content(html); pg.wait_for_timeout(300)
    for cid in ids:
        for sleep in (False, True):
            name = f'cat_{cid}' + ('_sleep' if sleep else '')
            pg.evaluate(f"document.getElementById('r').innerHTML='<span class=\"c\" id=\"t\">'+App.catArt.svg('{cid}',{{w:220,delay:0,sleep:{str(sleep).lower()}}})+'</span>'")
            pg.wait_for_timeout(60)
            d = os.path.join(out, name + '.imageset'); os.makedirs(d, exist_ok=True)
            pg.locator('#t').screenshot(path=os.path.join(d, name + '.png'), omit_background=True)
            json.dump({'images': [{'filename': name + '.png', 'idiom': 'universal', 'scale': '3x'}], 'info': {'author': 'xcode', 'version': 1}}, open(os.path.join(d, 'Contents.json'), 'w'), indent=2)
    b.close()
json.dump({'info': {'author': 'xcode', 'version': 1}}, open(os.path.join(out, 'Contents.json'), 'w'))
print('ok', len(ids) * 2)

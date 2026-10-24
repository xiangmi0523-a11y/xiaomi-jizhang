"""重新生成 www/sw.js 里的离线缓存清单（加了新文件或发新版时运行：python3 tools/gen_sw.py 4.5-2）"""
import os, sys
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'www')
ver = sys.argv[1] if len(sys.argv) > 1 else '4.5-1'
files = ['index.html', 'manifest.json']
for d in ('css', 'js', 'icons'):
    files += [d + '/' + f for f in sorted(os.listdir(os.path.join(ROOT, d)))]
p = os.path.join(ROOT, 'sw.js'); s = open(p, encoding='utf-8').read()
head, rest = s.split('const PRECACHE = [', 1)
tail = rest.split('];', 1)[1]
lst = "\n  '/',\n  " + ',\n  '.join("'/" + f + "'" for f in files) + "\n"
import re
head = re.sub(r"const VERSION = '[^']*';", f"const VERSION = 'xm-v{ver}';", head)
open(p, 'w', encoding='utf-8').write(head + 'const PRECACHE = [' + lst + '];' + tail)
print(len(files), 'files, version', ver)

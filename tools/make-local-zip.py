import os, sys, zipfile, time

root = sys.argv[1]
out = sys.argv[2]
top = 'parking-local-0.2.0'
dirs = ['src', 'tools', 'harness', 'contract']
files = ['tests/helpers.js', 'package.json']
skip_dirs = {'local-dist', 'node_modules', '__pycache__'}


def add(z, arc, data, mode=0o644):
    zi = zipfile.ZipInfo(top + '/' + arc, date_time=time.localtime()[:6])
    zi.compress_type = zipfile.ZIP_DEFLATED
    zi.external_attr = (0o100000 | mode) << 16
    z.writestr(zi, data)


os.makedirs(os.path.dirname(out), exist_ok=True)
n = 0
with zipfile.ZipFile(out, 'w') as z:
    for d in dirs:
        for base, ds, fs in os.walk(os.path.join(root, d)):
            ds[:] = [x for x in ds if x not in skip_dirs]
            for f in fs:
                p = os.path.join(base, f)
                arc = os.path.relpath(p, root).replace('\\', '/')
                add(z, arc, open(p, 'rb').read()); n += 1
    for f in files:
        add(z, f, open(os.path.join(root, f), 'rb').read()); n += 1
    ld = os.path.join(root, 'tools', 'local-dist')
    bat = open(os.path.join(ld, 'start.bat'), encoding='utf-8').read().replace('\r\n', '\n').replace('\n', '\r\n')
    add(z, 'start.bat', bat.encode('utf-8'))
    readme = open(os.path.join(ld, 'README.txt'), encoding='utf-8').read().replace('\r\n', '\n').replace('\n', '\r\n')
    add(z, 'README.txt', b'\xef\xbb\xbf' + readme.encode('utf-8'))
    mac = open(os.path.join(ld, 'start-mac.command'), encoding='utf-8').read().replace('\r\n', '\n')
    add(z, 'start-mac.command', mac.encode('utf-8'), 0o755)
    n += 3
print(out, n, 'files', os.path.getsize(out), 'bytes')

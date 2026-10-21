#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把扩展的可运行文件收敛到 dist/，并打出版本 zip。

用法: python _dev/build.py
产物: dist/  (Edge「加载解压缩的扩展」直接选这个目录)
      VideoFetch-<version>.zip  (dist 的压缩副本)
"""
import json
import os
import shutil
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')

# 运行期必需，构建产物只包含这些
DIRS = ['background', 'content', 'lib', 'offscreen', 'popup', 'settings', 'vendor', 'icons', '_locales']
FILES = ['manifest.json', 'README.md']

# 打包时剔除的杂项
SKIP_EXT = {'.map', '.DS_Store'}
# logo.png 是设计源图（235KB），运行期用不到，不进包
SKIP_NAME = {'.DS_Store', 'Thumbs.db', 'logo.png'}


def clean_dist():
    """清空 dist。逐个删文件比 rmtree 稳：某些环境里删「目录本身」会被回收站接口拒掉。"""
    if not os.path.isdir(DIST):
        os.makedirs(DIST)
        return
    for cur, dirs, names in os.walk(DIST, topdown=False):
        for n in names:
            try:
                os.remove(os.path.join(cur, n))
            except OSError as e:
                raise SystemExit('无法删除 %s：%s' % (os.path.join(cur, n), e))
        for d in dirs:
            try:
                os.rmdir(os.path.join(cur, d))
            except OSError:
                pass
    os.makedirs(DIST, exist_ok=True)


def keep(name):
    return name not in SKIP_NAME and os.path.splitext(name)[1] not in SKIP_EXT


def copy_payload():
    count = 0
    for f in FILES:
        src = os.path.join(ROOT, f)
        if not os.path.isfile(src):
            raise SystemExit('缺少必需文件: ' + f)
        shutil.copy2(src, os.path.join(DIST, f))
        count += 1
    for d in DIRS:
        src_dir = os.path.join(ROOT, d)
        if not os.path.isdir(src_dir):
            raise SystemExit('缺少必需目录: ' + d)
        for cur, _, names in os.walk(src_dir):
            rel = os.path.relpath(cur, ROOT)
            os.makedirs(os.path.join(DIST, rel), exist_ok=True)
            for n in names:
                if not keep(n):
                    continue
                shutil.copy2(os.path.join(cur, n), os.path.join(DIST, rel, n))
                count += 1
    return count


def verify_manifest():
    """校验 manifest 里引用的每个文件都在 dist 内，避免装了跑不起来。"""
    with open(os.path.join(DIST, 'manifest.json'), encoding='utf-8') as fh:
        m = json.load(fh)

    refs = []

    def add(p):
        if p:
            refs.append(p.lstrip('/'))

    bg = m.get('background') or {}
    add(bg.get('service_worker'))
    for s in bg.get('scripts') or []:
        add(s)
    for cs in m.get('content_scripts') or []:
        for s in cs.get('js') or []:
            add(s)
        for s in cs.get('css') or []:
            add(s)
    add((m.get('action') or {}).get('default_popup'))
    for k in ((m.get('icons') or {}).values()):
        add(k)
    for k in ((m.get('action') or {}).get('default_icon') or {}).values() if isinstance(
            (m.get('action') or {}).get('default_icon'), dict) else []:
        add(k)
    for k in ((m.get('web_accessible_resources') or [])):
        for r in k.get('resources') or []:
            if '*' not in r:
                add(r)

    missing = [r for r in refs if not os.path.isfile(os.path.join(DIST, r))]
    if missing:
        raise SystemExit('manifest 引用了 dist 中不存在的文件: ' + ', '.join(missing))
    return m.get('version', '0.0.0'), len(refs)


def make_zip(version):
    """zip 根目录直接是 manifest.json，方便第三方渠道直接安装。"""
    out = os.path.join(ROOT, 'VideoFetch-%s.zip' % version)
    if os.path.exists(out):
        os.remove(out)
    n = 0
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for cur, _, names in os.walk(DIST):
            for fname in sorted(names):
                full = os.path.join(cur, fname)
                rel = os.path.relpath(full, DIST).replace('\\', '/')
                z.write(full, rel)
                n += 1
    return out, n


def walk_size(path):
    total = 0
    files = 0
    for cur, _, names in os.walk(path):
        for n in names:
            total += os.path.getsize(os.path.join(cur, n))
            files += 1
    return files, total


LOCALE_LIMITS = {'extName': 45, 'extDesc': 132}


def verify_locales():
    """商店对名称与描述有长度上限，超了在 Partner Center 上传时直接被拒。"""
    bad = []
    checked = 0
    loc_dir = os.path.join(DIST, '_locales')
    for loc in sorted(os.listdir(loc_dir)):
        fp = os.path.join(loc_dir, loc, 'messages.json')
        if not os.path.isfile(fp):
            continue
        with open(fp, encoding='utf-8') as fh:
            data = json.load(fh)
        for key, limit in LOCALE_LIMITS.items():
            msg = (data.get(key) or {}).get('message') or ''
            checked += 1
            if len(msg) > limit:
                bad.append('%s/%s %d > %d' % (loc, key, len(msg), limit))
    if bad:
        raise SystemExit('locale 文案超长: ' + '; '.join(bad))
    return checked


def main():
    clean_dist()
    copied = copy_payload()
    version, refs = verify_manifest()
    loc_n = verify_locales()
    zip_path, zip_n = make_zip(version)
    files, total = walk_size(DIST)

    print('dist/ 就绪: %d 个文件, %.1f KB' % (files, total / 1024.0))
    print('manifest 引用校验: %d 处，全部存在' % refs)
    print('locale 文案校验: %d 项在商店长度上限内' % loc_n)
    print('zip: %s (%d 个文件, %.1f KB)' % (os.path.basename(zip_path), zip_n,
                                           os.path.getsize(zip_path) / 1024.0))
    print()
    print('加载方式: edge://extensions -> 开发人员模式 -> 加载解压缩的扩展 -> 选 %s' % DIST)


if __name__ == '__main__':
    main()

#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成微软 Edge Add-ons 商店素材。

用法:
  python _dev/make-store-art.py            # 出全套（图标 / 截图 / 宣传图）
  python _dev/make-store-art.py --icon     # 只出 300x300 图标
  python _dev/make-store-art.py --shots    # 只出截图
  python _dev/make-store-art.py --promo    # 只出两张宣传图

产物（store/）:
  icon-300.png                300x300  商店图标
  screenshot-1-sources-en.png 1280x800 源列表（英文界面）
  screenshot-2-tasks-zh.png   1280x800 下载任务（中文界面）
  screenshot-3-settings-en.png 1280x800 设置页（英文界面）
  promo-small-440x280.png     440x280  小型宣传图块
  promo-large-1400x560.png    1400x560 大型宣传图块

截图不是画的：_shots/ 下那几个页面直接引用 popup / settings 的 CSS 与脚本，
只把后台换成一小组固定数据，所以图里的界面和装好扩展后看到的是同一套样式。
需要 Pillow（生成图标）与 Chrome。
"""
import os
import shutil
import socket
import subprocess
import sys
import threading
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.path.join(ROOT, 'store')
SHOTS = os.path.join(ROOT, '_shots')
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'

SS = 8  # 超采样

if not shutil.which(CHROME) and not os.path.isfile(CHROME):
    raise SystemExit('找不到 Chrome: ' + CHROME)


# ---------------------------------------------------------------- 服务器

def serve():
    """截 frame.html 时要读 out/ 下的图，file:// 下 module 与相对路径都不稳，起个临时服务器。"""
    os.chdir(ROOT)

    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(('127.0.0.1', 0), Quiet)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, port


def shoot(url, out, w, h, budget=6000, scale=1):
    args = [
        CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars',
        '--force-device-scale-factor=%d' % scale, '--virtual-time-budget=%d' % budget,
        '--screenshot=%s' % out.replace('/', '\\'), '--window-size=%d,%d' % (w, h), url
    ]
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not os.path.isfile(out):
        raise SystemExit('截图失败: ' + out)
    im = Image.open(out)
    if im.size != (w * scale, h * scale):
        print('  警告: %s 实际尺寸 %s，期望 %dx%d' % (os.path.basename(out), im.size, w * scale, h * scale))


# ---------------------------------------------------------------- 图标

def ink_bbox(im):
    """只取上方图形区域（logo 下方那行字不属于标记）。"""
    g = im.convert('RGB')
    w, h = g.size
    px = g.load()

    def ink(x, y):
        r, gg, b = px[x, y]
        return (255 - min(r, gg, b)) > 28

    rows = []
    for y in range(h):
        c = sum(1 for x in range(0, w, 2) if ink(x, y))
        rows.append(c)

    segs, st = [], None
    for y, c in enumerate(rows):
        if c and st is None:
            st = y
        elif not c and st is not None:
            segs.append((st, y - 1))
            st = None
    if st is not None:
        segs.append((st, h - 1))
    if not segs:
        raise SystemExit('logo.png 里找不到内容')
    top, bot = segs[0]
    xs = [x for x in range(w) if any(ink(x, y) for y in range(top, bot + 1, 2))]
    return g, (min(xs), top, max(xs) + 1, bot + 1)


def to_alpha(rgb):
    w, h = rgb.size
    src = rgb.load()
    out = Image.new('RGBA', (w, h))
    dst = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b = src[x, y]
            a = 255 - min(r, g, b)
            if a <= 0:
                dst[x, y] = (0, 0, 0, 0)
                continue
            k = a / 255.0
            f = tuple(max(0, min(255, int(round((c - (1 - k) * 255) / k)))) for c in (r, g, b))
            dst[x, y] = (f[0], f[1], f[2], a)
    return out


def icon_300():
    src = Image.open(os.path.join(ROOT, 'icons', 'logo.png'))
    rgb, bbox = ink_bbox(src)
    mark = to_alpha(rgb.crop(bbox))
    size = 300
    big = size * SS
    plate = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(plate).rounded_rectangle([0, 0, big - 1, big - 1], radius=int(big * 0.22), fill=(255, 255, 255, 255))
    inner = int(round(big * 0.84))
    mw, mh = mark.size
    k = min(inner / mw, inner / mh)
    box = (max(1, int(mw * k)), max(1, int(mh * k)))
    canvas = Image.new('RGBA', (big, big), (255, 255, 255, 0))
    canvas.alpha_composite(plate)
    canvas.alpha_composite(mark.resize(box, Image.LANCZOS), ((big - box[0]) // 2, (big - box[1]) // 2))
    out = canvas.resize((size, size), Image.LANCZOS)
    p = os.path.join(STORE, 'icon-300.png')
    out.save(p, 'PNG', optimize=True)
    print('  %-30s %dx%d  %d B' % ('icon-300.png', size, size, os.path.getsize(p)))


# ---------------------------------------------------------------- 截图

SHOT_PAGES = [
    # (模板, 图片, 输出名)
    ('_shots/src-en.html', None, 'screenshot-src-raw.png'),
    ('_shots/tasks-zh.html', None, 'screenshot-tasks-raw.png'),
    ('_shots/settings-en.html', None, 'screenshot-settings-raw.png'),
]


def trim(src, dst, pad=0):
    im = Image.open(src).convert('RGB')
    w, h = im.size
    bg = im.getpixel((w // 2, h - 8))
    last = 0
    for y in range(h - 1, -1, -1):
        row = [im.getpixel((x, y)) for x in range(0, w, 4)]
        if any(sum(abs(a - b) for a, b in zip(c, bg)) > 10 for c in row):
            last = y
            break
    out = im.crop((0, 0, w, min(h, last + 1 + pad)))
    out.save(dst)
    return out.size


FRAMES = [
    dict(
        file='screenshot-1-sources-en.png',
        img='sources-en.png',
        eyebrow='Edge extension',
        t='Grab the video, not the wrapper',
        d='VideoFetch finds the stream a page is actually playing — HLS playlists, live feeds, plain MP4, even players that only expose a blob.',
        b='One card per video, quality picker built in|Eight connections at once, merged into a single file|Separate audio tracks are put back together',
        foot='VideoFetch · Manifest V3 · no tracking, everything stays on your machine',
    ),
    dict(
        file='screenshot-2-tasks-zh.png',
        img='tasks-zh.png',
        eyebrow='下载任务',
        t='暂停不丢进度，接着下',
        d='点暂停当场停下，已经下好的分片留在原地；「保存」把此刻的进度另存一份，任务不结束，还能继续下完。',
        b='断点续存，继续时不必从头再来|每 4MB 一块，八路并发|直播也能录，随时停下并保存',
        foot='VideoFetch · Manifest V3 · 数据只留在本机，不对外发送',
    ),
    dict(
        file='screenshot-3-settings-en.png',
        img='settings-en.png',
        wide=True,
        eyebrow='Save location',
        t='Pick where files go',
        d='Keep the browser download folder, or point VideoFetch at any folder on the disk and it writes straight there.',
        b='Subfolder inside the download folder|Custom folder, one-time permission|English default, Chinese follows the browser',
        foot='VideoFetch · Manifest V3 · no tracking, everything stays on your machine',
    ),
]


def shots(port):
    raw_dir = os.path.join(SHOTS, 'raw')
    os.makedirs(raw_dir, exist_ok=True)
    out_dir = os.path.join(SHOTS, 'out')
    os.makedirs(out_dir, exist_ok=True)

    # 1) 截 popup / settings 本体
    plan = [
        ('src-en.html', 420, 600, 'sources-en.png', 0),
        ('tasks-zh.html', 420, 600, 'tasks-zh.png', 0),
        ('settings-en.html', 780, 700, 'settings-en.png', 24),
    ]
    for page, w, h, name, pad in plan:
        raw = os.path.join(raw_dir, name)
        # 面板按 2 倍像素截，合成图上放大后不至于发虚
        shoot('http://127.0.0.1:%d/_shots/%s' % (port, page), raw, w, h, scale=2)
        size = trim(raw, os.path.join(out_dir, name), pad)
        print('  %-30s 面板 %dx%d' % (name, size[0], size[1]))

    # 2) 合成 1280x800
    for f in FRAMES:
        q = urllib.parse.urlencode({
            'img': 'out/' + f['img'],
            'eyebrow': f['eyebrow'],
            't': f['t'],
            'd': f['d'],
            'b': f['b'],
            'foot': f['foot'],
            'wide': '1' if f.get('wide') else '',
        }, quote_via=urllib.parse.quote)
        out = os.path.join(STORE, f['file'])
        shoot('http://127.0.0.1:%d/_shots/frame.html?%s' % (port, q), out, 1280, 800)
        im = Image.open(out).convert('RGB')
        p = os.path.join(STORE, f['file'])
        im.save(p, 'PNG', optimize=True)
        print('  %-30s %dx%d  %d B' % (f['file'], im.size[0], im.size[1], os.path.getsize(p)))


# ---------------------------------------------------------------- 宣传图

PROMO = [
    dict(file='promo-small-440x280.png', w=440, h=280, title='VideoFetch', sub='Download what the page is playing.', size=34, sub_size=13.5),
    dict(file='promo-large-1400x560.png', w=1400, h=560, title='VideoFetch', sub='HLS, live streams, MP4 — saved as one file, on your machine.', size=64, sub_size=22, img='out/sources-en.png'),
]


def promo():
    """宣传图用 HTML 渲：渐变、字距、阴影手绘不好对齐。"""
    srv, port = serve()
    try:
        for cfg in PROMO:
            out = os.path.join(STORE, cfg['file'])
            q = urllib.parse.urlencode(dict(w=cfg['w'], h=cfg['h'], t=cfg['title'], s=cfg['sub'],
                                            ts=cfg['size'], ss=cfg['sub_size'], img=cfg.get('img', '')))
            shoot('http://127.0.0.1:%d/_shots/promo.html?%s' % (port, q), out, cfg['w'], cfg['h'], budget=2000)
            print('  %-30s %dx%d  %d B' % (cfg['file'], cfg['w'], cfg['h'], os.path.getsize(out)))
    finally:
        srv.shutdown()


def main():
    os.makedirs(STORE, exist_ok=True)
    todo = sys.argv[1:]
    only = lambda flag: (not todo) or flag in todo
    if only('--icon'):
        icon_300()
    if only('--shots'):
        srv, port = serve()
        try:
            shots(port)
        finally:
            srv.shutdown()
    if only('--promo'):
        # 宣传图里嵌了面板截图，单独跑 --promo 时先补一次
        if not os.path.isfile(os.path.join(SHOTS, 'out', 'sources-en.png')):
            print('  缺少面板图，先出截图')
            srv, port = serve()
            try:
                shots(port)
            finally:
                srv.shutdown()
        promo()


if __name__ == '__main__':
    main()

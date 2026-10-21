#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从 icons/logo.png 裁出图形标记（去掉下方文字），生成扩展各尺寸图标。

用法:
  python _dev/make-icons.py            # 生成 icons/*.png
  python _dev/make-icons.py --preview  # 只出一张对比图 _dev/icon-preview.png

产物:
  icons/16.png 32.png 48.png 128.png  白底圆角方块 + 标记（工具栏/扩展页，亮暗主题都看得清）
  icons/mark.png                      透明底标记 64px（popup 顶栏用）
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'icons', 'logo.png')
OUT = os.path.join(ROOT, 'icons')

SS = 8  # 超采样倍数，先在大图上画再缩，边缘才干净


def ink_bbox(im):
    """只取上方图形区域：按行找出非白内容，返回 (图形块, (l,t,r,b))。"""
    g = im.convert('RGB')
    w, h = g.size
    px = g.load()

    def ink(x, y):
        r, gg, b = px[x, y]
        return (255 - min(r, gg, b)) > 28

    rows = []
    for y in range(h):
        c = 0
        for x in range(0, w, 2):
            if ink(x, y):
                c += 1
        rows.append(c)

    segs = []
    st = None
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
    # 第一段是图形，第二段是文字
    top, bot = segs[0]
    xs = [x for x in range(w) if any(ink(x, y) for y in range(top, bot + 1, 2))]
    return g, (min(xs), top, max(xs) + 1, bot + 1)


def to_alpha(rgb):
    """白底转透明：按暗度反推 alpha，再反解原色，避免白边。"""
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


def rounded_plate(size, radius_ratio=0.22):
    big = size * SS
    plate = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(plate)
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=int(big * radius_ratio), fill=(255, 255, 255, 255))
    return plate


def compose(mark, size, pad_ratio, plate):
    """把透明标记按比例放进 size×size 画布。"""
    inner = int(round(size * (1 - 2 * pad_ratio)))
    mw, mh = mark.size
    k = min(inner / mw, inner / mh)
    box = (max(1, int(mw * k)), max(1, int(mh * k)))
    m = mark.resize(box, Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    if plate:
        canvas.alpha_composite(plate)
    canvas.alpha_composite(m, ((size - box[0]) // 2, (size - box[1]) // 2))
    return canvas


def main():
    if not os.path.isfile(SRC):
        raise SystemExit('缺少源文件: ' + SRC)
    src = Image.open(SRC)
    rgb, bbox = ink_bbox(src)
    mark = to_alpha(rgb.crop(bbox))
    print('源图 %s，图形块 %s，裁出 %dx%d' % (src.size, bbox, *mark.size))

    if '--preview' in sys.argv:
        return preview(mark)

    # 工具栏/扩展页：白底圆角，暗色主题下也不会糊成一团深色
    # 小尺寸几乎不留边，否则 16px 全耗在留白上
    for size, pad in ((16, 0.02), (32, 0.02), (48, 0.05), (128, 0.08)):
        big = compose(mark, size * SS, pad, rounded_plate(size))
        out = big.resize((size, size), Image.LANCZOS)
        p = os.path.join(OUT, '%d.png' % size)
        out.save(p, 'PNG', optimize=True)
        print('  %-24s %dx%d  %d B' % ('icons/%d.png' % size, size, size, os.path.getsize(p)))

    # popup 顶栏：透明底，跟面板同色
    mp = os.path.join(OUT, 'mark.png')
    compose(mark, 64 * SS, 0.02, None).resize((64, 64), Image.LANCZOS).save(mp, 'PNG', optimize=True)
    print('  %-24s 64x64  %d B' % ('icons/mark.png', os.path.getsize(mp)))


def preview(mark):
    """亮/暗两种底色 × 白板/透明两种方案，各尺寸实拍，人工看一眼有没有糊掉。"""
    sizes = [16, 32, 48, 128]
    scale = 3
    pad = 12
    rows = [(v, bgc) for v in ('plate', 'alpha') for bgc in ((245, 246, 248), (30, 32, 36))]
    w = sum(s * scale + pad for s in sizes) + pad
    row_h = 128 * scale + pad * 2
    sheet = Image.new('RGB', (w, row_h * len(rows)), (245, 246, 248))
    d = ImageDraw.Draw(sheet)
    y = 0
    for v, bgc in rows:
        d.rectangle([0, y, w, y + row_h], fill=bgc)
        for i, size in enumerate(sizes):
            p = 0.05 if size <= 32 else (0.06 if size == 48 else 0.08)
            plate = rounded_plate(size) if v == 'plate' else None
            ic = compose(mark, size * SS, p, plate).resize((size, size), Image.LANCZOS)
            big = ic.resize((size * scale, size * scale), Image.NEAREST)
            x = pad + sum(s * scale + pad for s in sizes[:i])
            sheet.paste(big, (x, y + pad), big)
        y += row_h
    p = os.path.join(ROOT, '_dev', 'icon-preview.png')
    sheet.save(p)
    print('预览: ' + p)


if __name__ == '__main__':
    main()

import zlib, struct, math, os

def sdf_round_rect(px, py, size, rad):
    cx = cy = size / 2.0
    hx = hy = size / 2.0 - rad
    dx = abs(px - cx) - hx
    dy = abs(py - cy) - hy
    dx = max(dx, 0.0)
    dy = max(dy, 0.0)
    return math.hypot(dx, dy) - rad

def in_triangle(px, py, a, b, c):
    def sign(p1, p2, p3):
        return (p1[0]-p3[0])*(p2[1]-p3[1]) - (p2[0]-p3[0])*(p1[1]-p3[1])
    d1 = sign((px,py), a, b)
    d2 = sign((px,py), b, c)
    d3 = sign((px,py), c, a)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)

def lerp(a, b, t):
    return a + (b - a) * t

def render(size):
    SS = 4
    rows = []
    rad = size * 0.235
    A = (0.385 * size, 0.275 * size)
    B = (0.385 * size, 0.725 * size)
    C = (0.705 * size, 0.500 * size)
    for y in range(size):
        row = bytearray()
        for x in range(size):
            cov = 0
            tri = 0
            for sy in range(SS):
                for sx in range(SS):
                    px = x + (sx + 0.5) / SS
                    py = y + (sy + 0.5) / SS
                    if sdf_round_rect(px, py, size, rad) <= 0:
                        cov += 1
                        if in_triangle(px, py, A, B, C):
                            tri += 1
            if cov == 0:
                row += bytes((0, 0, 0, 0))
                continue
            t = (x + y) / (2.0 * max(1, size - 1))
            r = lerp(59, 124, t)
            g = lerp(130, 58, t)
            b = lerp(246, 237, t)
            tr = tri / float(cov)
            if tr > 0:
                r = lerp(r, 255, tr)
                g = lerp(g, 255, tr)
                b = lerp(b, 255, tr)
            a = int(round(255 * cov / (SS * SS)))
            row += bytes((int(round(r)), int(round(g)), int(round(b)), a))
        rows.append(bytes(row))
    return rows

def write_png(path, size):
    rows = render(size)
    raw = b''.join(b'\x00' + r for r in rows)
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)

os.makedirs('icons', exist_ok=True)
for s in (16, 32, 48, 128):
    write_png('icons/%d.png' % s, s)
    print('icons/%d.png' % s, os.path.getsize('icons/%d.png' % s), 'bytes')

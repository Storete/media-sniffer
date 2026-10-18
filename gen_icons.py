"""生成扩展图标（纯标准库，无需 Pillow）"""
import math
import os
import struct
import zlib

BLUE = (37, 99, 235)
DARK = (29, 78, 216)
WHITE = (255, 255, 255)
S = 4  # 超采样倍数


def rounded_alpha(x, y, w, r):
    """圆角矩形内部判定"""
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), w - r)
    d = math.hypot(x - cx, y - cy)
    return d <= r


def radar(x, y, w):
    """雷达波：右下角的点 + 三条右上方向的弧"""
    cx, cy = 0.34 * w, 0.66 * w
    dist = math.hypot(x - cx, y - cy)
    ang = math.degrees(math.atan2(cy - y, x - cx))  # 右上方向为正

    # 中心点
    if dist <= 0.075 * w:
        return True
    # 弧线
    if -6 <= ang <= 96:
        for r in (0.20, 0.33, 0.46):
            if abs(dist - r * w) <= 0.035 * w:
                return True
    return False


def render(size):
    w = size
    buf = bytearray(w * w * 4)
    for py in range(w):
        for px in range(w):
            cov_bg = 0.0
            cov_fg = 0.0
            for sy in range(S):
                for sx in range(S):
                    x = px + (sx + 0.5) / S
                    y = py + (sy + 0.5) / S
                    if rounded_alpha(x, y, w, 0.22 * w):
                        cov_bg += 1
                        if radar(x, y, w):
                            cov_fg += 1
            n = S * S
            if cov_bg == 0:
                continue
            a = cov_bg / n
            fb = cov_fg / n
            # 背景竖向渐变
            t = py / max(1, w - 1)
            bg = tuple(round(BLUE[i] + (DARK[i] - BLUE[i]) * t) for i in range(3))
            col = tuple(round(bg[i] + (WHITE[i] - bg[i]) * (fb / a if a else 0)) for i in range(3))
            o = (py * w + px) * 4
            buf[o:o + 4] = bytes(col) + bytes([round(255 * a)])
    return bytes(buf)


def write_png(path, w, h, rgba):
    raw = b"".join(b"\x00" + rgba[y * w * 4:(y + 1) * w * 4] for y in range(h))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "extension", "icons")
    os.makedirs(out, exist_ok=True)
    for size in (16, 32, 48, 128):
        px = render(size)
        write_png(os.path.join(out, f"icon{size}.png"), size, size, px)
        print("生成", f"icon{size}.png")

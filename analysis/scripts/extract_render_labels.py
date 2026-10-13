#!/usr/bin/env python3
"""读取学校规划效果图上的红色标注，并把它和真实卫星底图对应起来。

产出三张核对图（都放在 /tmp/render_labels/）：
  render_numbered.png  效果图上把每个标注框出来并编号
  labels_grid.png      每个标注放大后的字样，配编号，便于逐条辨认
  anchor_zoom.png      真实底图上，你给的锚点位置 + 周边 OSM 建筑名
"""
import json
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# 学校给的规划鸟瞰效果图（已归档；uploads/ 是原始上传目录，不进版本库）
SRC = os.path.join(ROOT, "data", "raw", "plan", "campus_plan_render.jpg")
BASE = os.path.join(ROOT, "figures", "campus_basemap.png")
CAMPUS = os.path.join(ROOT, "web", "campus.json")
BOUNDS = os.path.join(ROOT, "web", "bounds.json")
OUT = "/tmp/render_labels"


def get_font(size):
    """找一个能显示中文的字体。"""
    for p in ("/System/Library/Fonts/PingFang.ttc",
              "/System/Library/Fonts/Supplemental/Songti.ttc",
              "/Library/Fonts/Arial Unicode.ttf",
              "/System/Library/Fonts/Helvetica.ttc"):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


# ---------------------------------------------------------------- 1. 抠标注
def extract_words(im):
    a = np.asarray(im).astype(np.int16)
    R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    red = (R > 115) & (R - G > 50) & (R - B > 40)

    # 横向膨胀：把同一个词里的字并成一块（字距小、词距大）
    red_d = ndimage.binary_dilation(red, structure=np.ones((3, 15)), iterations=1)
    lab, n = ndimage.label(red_d)
    objs = ndimage.find_objects(lab)
    sizes = ndimage.sum(red_d, lab, range(1, n + 1))

    words = []
    for i in range(n):
        sl = objs[i]
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        if sizes[i] < 180 or h < 12 or w < 20 or h > 95 or w > 430:
            continue
        words.append({"x0": int(sl[1].start), "y0": int(sl[0].start),
                      "w": int(w), "h": int(h)})
    words.sort(key=lambda t: (t["y0"], t["x0"]))
    return words


def draw_numbered(im, words):
    Z = 2
    M = im.resize((im.width * Z, im.height * Z), Image.LANCZOS).convert("RGB")
    d = ImageDraw.Draw(M)
    f = get_font(26)
    for i, wd in enumerate(words):
        box = [wd["x0"] * Z, wd["y0"] * Z,
               (wd["x0"] + wd["w"]) * Z, (wd["y0"] + wd["h"]) * Z]
        d.rectangle(box, outline=(0, 200, 255), width=3)
        d.text((box[0], box[1] - 30), str(i), fill=(0, 90, 255), font=f,
               stroke_width=2, stroke_fill=(255, 255, 255))
    M.save(f"{OUT}/render_numbered.png")
    return M.size


def draw_grid(im, words):
    Z, PAD, COLS = 5, 8, 3
    cells = []
    for i, wd in enumerate(words):
        box = (max(0, wd["x0"] - PAD), max(0, wd["y0"] - PAD),
               min(im.width, wd["x0"] + wd["w"] + PAD),
               min(im.height, wd["y0"] + wd["h"] + PAD))
        c = im.crop(box)
        cells.append((i, c.resize((c.width * Z, c.height * Z), Image.LANCZOS)))

    cw = max(c.width for _, c in cells) + 120
    ch = max(c.height for _, c in cells) + 24
    rows = (len(cells) + COLS - 1) // COLS
    M = Image.new("RGB", (cw * COLS, ch * rows), (255, 255, 255))
    d = ImageDraw.Draw(M)
    f = get_font(30)
    for k, (i, c) in enumerate(cells):
        r, col = divmod(k, COLS)
        x, y = col * cw, r * ch
        d.text((x + 8, y + 8), f"#{i}", fill=(0, 0, 0), font=f)
        M.paste(c, (x + 110, y + 8))
        d.rectangle([x, y, x + cw - 1, y + ch - 1], outline=(220, 220, 220))
    M.save(f"{OUT}/labels_grid.png")
    return M.size


# ------------------------------------------------- 2. 锚点附近的真实底图
def lonlat_to_px(lon, lat, b, size):
    x = (lon - b["west"]) / (b["east"] - b["west"]) * size[0]
    y = (b["north"] - lat) / (b["north"] - b["south"]) * size[1]
    return x, y


def centroid(geom):
    if geom["type"] == "Polygon":
        pts = geom["coordinates"][0]
    elif geom["type"] == "LineString":
        pts = geom["coordinates"]
    else:
        return None
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def draw_anchor_zoom(anchor, half_m=330):
    base = Image.open(BASE).convert("RGB")
    b = json.load(open(BOUNDS))
    feats = json.load(open(CAMPUS))["features"]

    alat, alon = anchor
    ax, ay = lonlat_to_px(alon, alat, b, base.size)

    # 像素与实际距离的换算
    m_per_px_x = (b["east"] - b["west"]) * 111320 * math.cos(math.radians(alat)) / base.width
    m_per_px_y = (b["north"] - b["south"]) * 111320 / base.height
    m_per_px = (m_per_px_x + m_per_px_y) / 2
    half_px = int(half_m / m_per_px)

    box = (int(ax - half_px), int(ay - half_px),
           int(ax + half_px), int(ay + half_px))
    crop = base.crop(box)
    Z = 2
    crop = crop.resize((crop.width * Z, crop.height * Z), Image.LANCZOS)
    d = ImageDraw.Draw(crop)
    f = get_font(26)
    fs = get_font(22)

    def to_crop(lon, lat):
        x, y = lonlat_to_px(lon, lat, b, base.size)
        return (x - box[0]) * Z, (y - box[1]) * Z

    # 画建筑轮廓和名字
    for ft in feats:
        p = ft["properties"]
        if p.get("kind") != "building":
            continue
        g = ft["geometry"]
        if g["type"] == "Polygon":
            rings = g["coordinates"]
        else:
            continue
        for ring in rings:
            pts = [to_crop(c[0], c[1]) for c in ring]
            d.line(pts + [pts[0]], fill=(255, 120, 0), width=3)
        c = centroid(g)
        if c:
            cx, cy = to_crop(c[0], c[1])
            if 0 < cx < crop.width and 0 < cy < crop.height:
                nm = p.get("name") or "(无名)"
                d.text((cx + 4, cy - 10), nm, fill=(255, 255, 0), font=fs,
                       stroke_width=3, stroke_fill=(0, 0, 0))

    # 锚点
    px, py = to_crop(alon, alat)
    r = 16
    d.ellipse([px - r, py - r, px + r, py + r], outline=(255, 0, 255), width=5)
    d.line([px - 40, py, px + 40, py], fill=(255, 0, 255), width=3)
    d.line([px, py - 40, px, py + 40], fill=(255, 0, 255), width=3)
    d.text((px + 22, py + 10), f"锚点 {alat},{alon}", fill=(255, 0, 255),
           font=f, stroke_width=3, stroke_fill=(255, 255, 255))

    crop.save(f"{OUT}/anchor_zoom.png")
    return crop.size


def main():
    os.makedirs(OUT, exist_ok=True)
    im = Image.open(SRC).convert("RGB")
    words = extract_words(im)

    print(f"效果图 {im.width}x{im.height}，提取到 {len(words)} 个标注块")
    for i, wd in enumerate(words):
        print(f"  #{i:2d}  x={wd['x0']:4d} y={wd['y0']:4d}  {wd['w']}x{wd['h']}")

    print("\n编号图:", draw_numbered(im, words))
    print("对照图:", draw_grid(im, words))

    anchor = (39.067743, 117.633092)
    print("锚点图:", draw_anchor_zoom(anchor))
    print(f"\n输出目录: {OUT}")


if __name__ == "__main__":
    main()

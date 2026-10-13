#!/usr/bin/env python3
"""在指定窗口里检测「影像上可见、但数据里没有」的建筑，并输出候选轮廓。

用法思路：
  * 每个窗口给一个颜色判据（屋顶 vs 地面），做阈值分割
  * 取面积最大的若干连通块作为候选
  * 对每个候选输出：面积、中心经纬度、最小外接矩形、以及一张叠图供人工核对

这些建筑（超市、10号公寓、长河楼）在 OSM 里没有轮廓，只能从影像上取。
影像是 2025-05 拍的，校园西北角当时还在施工，所以屋顶和裸土颜色接近，
阈值需要按窗口单独调；结果一律叠图人工核对后才写进 campus.json。
"""
from __future__ import annotations

import json
import math
import os
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
CACHE = Path("/tmp/campus_tile_cache")
Z = 19
ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
M_PER_PX = 0.298          # z19 在本地纬度约 0.30 m/px


def ll_to_tile(lon, lat, z=Z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    la = math.radians(lat)
    y = (1 - math.log(math.tan(la) + 1 / math.cos(la)) / math.pi) / 2 * n
    return x, y


def px_to_ll(px, py, tx0, ty0, z=Z):
    n = 2 ** z
    lon = (tx0 * 256 + px) / 256.0 / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ((ty0 * 256 + py) / 256.0) / n))))
    return lon, lat


def fetch(tx, ty, z=Z):
    CACHE.mkdir(parents=True, exist_ok=True)
    fp = CACHE / f"{z}_{tx}_{ty}.png"
    if not fp.exists():
        try:
            urllib.request.urlretrieve(ESRI.format(z=z, y=ty, x=tx), fp)
        except Exception:
            return None
    try:
        return Image.open(fp).convert("RGB")
    except Exception:
        return None


def mosaic(lon0, lon1, lat0, lat1, z=Z):
    x0, y1 = ll_to_tile(lon0, lat0, z)
    x1, y0 = ll_to_tile(lon1, lat1, z)
    tx0, tx1, ty0, ty1 = int(x0), int(x1), int(y0), int(y1)
    W, H = (tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256
    img = Image.new("RGB", (W, H), "#cccccc")
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            t = fetch(tx, ty, z)
            if t:
                img.paste(t, (int((tx - tx0) * 256), int((ty - ty0) * 256)))
    return img, tx0, ty0


def min_area_rect(pts):
    P = np.asarray(pts, float)
    best = None
    for i in range(len(P)):
        d = P[(i + 1) % len(P)] - P[i]
        L = np.hypot(*d)
        if L < 1e-9:
            continue
        u = d / L
        v = np.array([-u[1], u[0]])
        pu, pv = P @ u, P @ v
        a = (pu.max() - pu.min()) * (pv.max() - pv.min())
        if best is None or a < best[0]:
            best = (a, u, v, pu.min(), pv.min(), pu.max(), pv.max())
    if not best:
        return None
    _, u, v, u0, v0, u1, v1 = best
    return [tuple(u * cu + v * cv) for cu, cv in ((u0, v0), (u1, v0), (u1, v1), (u0, v1))]


def detect(name, window, rule, min_px=2500, top=4, pad_px=3):
    """返回候选列表，并写一张叠图。"""
    lon0, lon1, lat0, lat1 = window
    img, tx0, ty0 = mosaic(lon0, lon1, lat0, lat1)
    arr = np.asarray(img, dtype=np.int16)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    mask = rule(r, g, b)
    mask = ndimage.binary_closing(mask, iterations=2)
    lab, n = ndimage.label(mask)
    if n == 0:
        return [], None
    sizes = ndimage.sum(np.ones_like(lab), lab, range(1, n + 1))
    order = np.argsort(sizes)[::-1]

    cands = []
    for k in order[:top]:
        if sizes[k] < min_px:
            continue
        m = ndimage.binary_fill_holes(lab == (k + 1))
        m = ndimage.binary_dilation(m, iterations=pad_px)
        ys, xs = np.nonzero(m)
        ring_px = min_area_rect(np.stack([xs, ys], 1))
        if not ring_px:
            continue
        ring = [[round(px_to_ll(px, py, tx0, ty0)[0], 6),
                 round(px_to_ll(px, py, tx0, ty0)[1], 6)] for px, py in ring_px]
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        clon, clat = px_to_ll(xs.mean(), ys.mean(), tx0, ty0)
        # 长宽（米）
        side = []
        for i in range(4):
            a = np.array(ring_px[i]); c = np.array(ring_px[(i + 1) % 4])
            side.append(np.hypot(*(c - a)) * M_PER_PX)
        cands.append({
            "area_px": int(sizes[k]),
            "area_m2": round(float(m.sum()) * M_PER_PX ** 2),
            "center": [round(clon, 6), round(clat, 6)],
            "side_m": [round(s) for s in sorted(side)[:2]],
            "ring": ring,
        })

    # 叠图
    vis = np.asarray(img).copy()
    vis[mask] = [255, 0, 255]
    im2 = Image.fromarray(vis).resize((img.width * 2, img.height * 2), Image.NEAREST)
    dr = ImageDraw.Draw(im2)
    for c in cands:
        pts = []
        for lo, la in c["ring"]:
            X, Y = ll_to_tile(lo, la)
            pts.append(((X * 256 - tx0 * 256) * 2, (Y * 256 - ty0 * 256) * 2))
        dr.line(pts, fill=(0, 255, 0), width=4)
        cx = sum(p[0] for p in pts) / 4; cy = sum(p[1] for p in pts) / 4
        dr.text((cx - 30, cy - 8), f'{c["area_m2"]}m²', fill=(0, 255, 255))
    out = Path(f"/tmp/det_{name}.png")
    im2.save(out)
    return cands, out


# 三个窗口 + 各自的屋顶判据
JOBS = {
    "超市": dict(
        window=(117.63445, 117.63505, 39.06960, 39.07025),
        rule=lambda r, g, b: (r > 160) & ((r - b) > 45) & ((r - g) > 25),
    ),
    "长河楼": dict(
        window=(117.64100, 117.64210, 39.06670, 39.06770),
        rule=lambda r, g, b: (np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b) < 26)
                             & (r > 95) & (r < 170) & ((r - g) > -8),
    ),
    "10号公寓": dict(
        window=(117.63230, 117.63380, 39.06680, 39.06830),
        rule=lambda r, g, b: (r > 175) & (g > 168) & (b > 145) & ((r - b) < 55),
    ),
}


def main():
    all_out = {}
    for nm, job in JOBS.items():
        cands, out = detect(nm, job["window"], job["rule"])
        print(f"\n=== {nm} ===  候选 {len(cands)} 个   叠图 {out}")
        for i, c in enumerate(cands, 1):
            print(f"  #{i} 面积 {c['area_m2']:5d} m²  中心 ({c['center'][0]:.5f}, {c['center'][1]:.5f})  "
                  f"边长约 {c['side_m'][0]}×{c['side_m'][1]} m")
        all_out[nm] = cands
    p = ROOT / "data" / "processed" / "detected_buildings.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(all_out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n写入 {p.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

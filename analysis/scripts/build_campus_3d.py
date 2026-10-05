#!/usr/bin/env python3
"""由 OSM 建筑轮廓 + Esri 卫星影像生成校园地图底图与三维体块高度估算。

背景（见调研报告）：OSM 建筑轮廓只带 building 与少量 name，**没有层数与高度**，
因此三维体块高度只能按建筑类型用默认层高推算，并在属性中显式标注为估算值。

输出：
  data/processed/campus_buildings_3d.geojson  带估算高度/层数的建筑体块（WGS84）
  data/processed/campus_buildings_3d.csv      同上，表格形式
  figures/campus_basemap.png                  校园卫星正射底图（0.34 m/px 原生源）
"""
from __future__ import annotations

import csv
import io
import json
import math
import time
from pathlib import Path

import requests
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "osm"
PROC = ROOT / "data" / "processed"
FIG = ROOT / "figures"
HEADERS = {"User-Agent": "wisp-science-campus-map/1.0"}

# 按建筑类型的默认层高（米）——估算，非实测
DEFAULT_STOREY_H = 3.2
DORM_STOREYS = 6      # 学生公寓：校区内为 6 层建筑（现场/卫星阴影推断）
TEACH_STOREYS = 5     # 教学实训楼
DEFAULT_STOREYS = 4

# Esri World Imagery（本校区元数据：2025-05-20 拍摄，原生 0.34 m）
# 注意：该区域 z18 已是原生分辨率上限，z19 是插值放大
NATIVE_Z = 18


def ll_to_px(lat: float, lon: float, z: int) -> tuple[float, float]:
    n = 2**z
    return ((lon + 180) / 360 * n) * 256, ((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n) * 256


def px_to_ll(px: float, py: float, z: int) -> tuple[float, float]:
    n = 2**z
    lon = px / 256 / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * py / 256 / n))))
    return lat, lon


def estimate_height(tags: dict) -> tuple[float, int, str]:
    """返回 (高度m, 层数, 依据)。"""
    if "height" in tags:
        try:
            return float(str(tags["height"]).replace("m", "")), 0, "OSM height 标签"
        except ValueError:
            pass
    if "building:levels" in tags:
        lv = int(float(tags["building:levels"]))
        return lv * DEFAULT_STOREY_H, lv, "OSM building:levels 标签"
    name = tags.get("name", "")
    if "公寓" in name:
        return DORM_STOREYS * DEFAULT_STOREY_H, DORM_STOREYS, "按学生公寓默认 6 层估算"
    if tags.get("building") == "school":
        return TEACH_STOREYS * DEFAULT_STOREY_H, TEACH_STOREYS, "按教学实训楼默认 5 层估算"
    if tags.get("building") in ("grandstand",):
        return 8.0, 0, "看台，按 8 m 估算"
    return DEFAULT_STOREYS * DEFAULT_STOREY_H, DEFAULT_STOREYS, "按通用建筑默认 4 层估算"


def build_3d() -> tuple[list[dict], dict]:
    src = json.loads((RAW / "campus_osm_features.geojson").read_text(encoding="utf-8"))
    out = []
    stats = {"n": 0, "with_levels": 0, "estimated": 0}
    for ft in src["features"]:
        p = ft["properties"]
        if not p.get("in_campus") or "building" not in p.get("category", ""):
            continue
        h, lv, basis = estimate_height(p)
        props = {
            "osm_id": p["osm_id"],
            "name": p.get("name", ""),
            "building_type": p.get("building", ""),
            "height_m": round(h, 1),
            "levels": lv,
            "height_basis": basis,
        }
        stats["n"] += 1
        if "标签" in basis and "默认" not in basis:
            stats["with_levels"] += 1
        else:
            stats["estimated"] += 1
        out.append({"type": "Feature", "geometry": ft["geometry"], "properties": props})
    return out, stats


def make_basemap(buildings: list[dict]) -> Path:
    """拼接校园卫星底图并叠加建筑轮廓。"""
    boundary = json.loads((RAW / "campus_boundary.geojson").read_text(encoding="utf-8"))
    poly = [(c[1], c[0]) for c in boundary["features"][0]["geometry"]["coordinates"][0]]
    lats = [p[0] for p in poly]
    lons = [p[1] for p in poly]
    pad = 0.0005
    s, w, n, e = min(lats) - pad, min(lons) - pad, max(lats) + pad, max(lons) + pad

    z = NATIVE_Z
    x0, y0 = ll_to_px(n, w, z)
    x1, y1 = ll_to_px(s, e, z)
    tx0, ty0, tx1, ty1 = int(x0 // 256), int(y0 // 256), int(x1 // 256), int(y1 // 256)

    canvas = Image.new("RGB", ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256), (240, 240, 240))
    missing = 0
    for i, tx in enumerate(range(tx0, tx1 + 1)):
        for j, ty in enumerate(range(ty0, ty1 + 1)):
            url = (f"https://server.arcgisonline.com/ArcGIS/rest/services/"
                   f"World_Imagery/MapServer/tile/{z}/{ty}/{tx}")
            for attempt in range(4):
                try:
                    r = requests.get(url, headers=HEADERS, timeout=40)
                    if r.status_code == 200 and len(r.content) > 1000:
                        canvas.paste(Image.open(io.BytesIO(r.content)).convert("RGB"), (256 * i, 256 * j))
                        break
                except requests.RequestException:
                    pass
                time.sleep(1.5 * (attempt + 1))
            else:
                missing += 1
    if missing:
        print(f"  警告：{missing} 张瓦片下载失败")

    ox, oy = tx0 * 256, ty0 * 256
    left, top, right, bottom = int(x0 - ox), int(y0 - oy), int(x1 - ox), int(y1 - oy)
    img = canvas.crop((left, top, right, bottom))
    draw = ImageDraw.Draw(img)

    def to_px(lat: float, lon: float) -> tuple[float, float]:
        a, b = ll_to_px(lat, lon, z)
        return a - ox - left, b - oy - top

    for b in buildings:
        g = b["geometry"]
        if g["type"] == "Polygon":
            rings = [g["coordinates"][0]]
        elif g["type"] == "MultiPolygon":
            rings = [part[0] for part in g["coordinates"]]
        elif g["type"] == "LineString":
            rings = [g["coordinates"]]
        else:  # Point：仅有中心点的建筑，跳过描边
            continue
        for ring in rings:
            pts = [to_px(c[1], c[0]) for c in ring]
            if len(pts) > 2:
                draw.polygon(pts, outline=(255, 70, 0))
                draw.line(pts + [pts[0]], fill=(255, 70, 0), width=2)
                cx = sum(p[0] for p in pts) / len(pts)
                cy = sum(p[1] for p in pts) / len(pts)
                nm = b["properties"]["name"].replace("学生公寓", "公寓")
                if nm:
                    draw.text((cx - 18, cy - 5), nm, fill=(255, 240, 0))

    bp = [to_px(la, lo) for la, lo in poly]
    draw.line(bp + [bp[0]], fill=(0, 230, 255), width=3)

    mpp = 156543.03 * math.cos(math.radians(sum(lats) / len(lats))) / 2**z
    legend = [
        f"Tianjin Coastal Polytechnic campus  |  {mpp:.2f} m/pixel",
        f"Basemap: Esri World Imagery (2025-05-20)   Orange: {len(buildings)} buildings from OSM",
        "Cyan: campus boundary.  Trees mapped in OSM: 0",
    ]
    fnt_h = 26
    box_w = 900
    draw.rectangle([8, 8, 8 + box_w, 8 + fnt_h * len(legend) + 12], fill=(0, 0, 0))
    for i, line in enumerate(legend):
        draw.text((16, 14 + i * fnt_h), line, fill=(255, 255, 255))

    FIG.mkdir(parents=True, exist_ok=True)
    out = FIG / "campus_basemap.png"
    img.save(out)
    return out


def main() -> None:
    PROC.mkdir(parents=True, exist_ok=True)
    buildings, stats = build_3d()

    (PROC / "campus_buildings_3d.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": buildings}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    with (PROC / "campus_buildings_3d.csv").open("w", newline="", encoding="utf-8-sig") as fh:
        wr = csv.writer(fh)
        wr.writerow(["osm_id", "name", "building_type", "height_m", "levels", "height_basis"])
        for b in buildings:
            p = b["properties"]
            wr.writerow([p["osm_id"], p["name"], p["building_type"], p["height_m"], p["levels"], p["height_basis"]])

    fig = make_basemap(buildings)
    print(f"建筑体块      : {stats['n']} 栋")
    print(f"  有真实标签   : {stats['with_levels']}")
    print(f"  高度为估算   : {stats['estimated']}")
    print(f"底图          : {fig.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

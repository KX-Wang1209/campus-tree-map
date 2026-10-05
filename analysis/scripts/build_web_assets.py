#!/usr/bin/env python3
"""为网页应用生成静态资源：切片底图、校园要素、树种库。

底图策略：把校园卫星影像切成 z17-z19 的瓦片放在本地，
这样网页在校园里没网也能显示（学生实地采集时很关键）。
"""
from __future__ import annotations

import io
import json
import math
import time
from pathlib import Path

import requests
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "osm"
PROC = ROOT / "data" / "processed"
WEB = ROOT / "web"
TILES = WEB / "tiles"
HEADERS = {"User-Agent": "wisp-science-campus-map/1.0"}

ESRI = ("https://server.arcgisonline.com/ArcGIS/rest/services/"
        "World_Imagery/MapServer/tile/{z}/{y}/{x}")

# 校园边界（含少量外扩），用于确定切片范围
PAD = 0.0012

# 网页使用的缩放级别：z17 全局，z18 中景，z19 近景（z19 为插值放大，够看）
ZOOMS = [17, 18, 19]


def ll_to_tile(lat: float, lon: float, z: int) -> tuple[int, int]:
    n = 2**z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def campus_bbox() -> tuple[float, float, float, float]:
    doc = json.loads((RAW / "campus_boundary.geojson").read_text(encoding="utf-8"))
    ring = doc["features"][0]["geometry"]["coordinates"][0]
    lons = [c[0] for c in ring]
    lats = [c[1] for c in ring]
    return min(lats) - PAD, min(lons) - PAD, max(lats) + PAD, max(lons) + PAD


def build_tiles() -> dict:
    s, w, n, e = campus_bbox()
    meta = {}
    total = 0
    for z in ZOOMS:
        x0, y1 = ll_to_tile(s, w, z)
        x1, y0 = ll_to_tile(n, e, z)
        zdir = TILES / str(z)
        zdir.mkdir(parents=True, exist_ok=True)
        cnt = 0
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                fp = zdir / f"{x}_{y}.jpg"
                if fp.exists():
                    cnt += 1
                    continue
                url = ESRI.format(z=z, y=y, x=x)
                for attempt in range(3):
                    try:
                        r = requests.get(url, headers=HEADERS, timeout=40)
                        if r.status_code == 200 and len(r.content) > 1000:
                            img = Image.open(io.BytesIO(r.content)).convert("RGB")
                            img.save(fp, "JPEG", quality=82)
                            cnt += 1
                            break
                    except requests.RequestException:
                        pass
                    time.sleep(1.0 * (attempt + 1))
        meta[str(z)] = {"x0": x0, "x1": x1, "y0": y0, "y1": y1, "count": cnt}
        total += cnt
        print(f"  z{z}: {cnt} 张  x[{x0},{x1}] y[{y0},{y1}]")
    print(f"  本地瓦片共 {total} 张")
    return meta


def build_campus_geojson() -> dict:
    """校园要素转成网页用的精简 GeoJSON。"""
    src = json.loads((RAW / "campus_osm_features.geojson").read_text(encoding="utf-8"))
    boundary = json.loads((RAW / "campus_boundary.geojson").read_text(encoding="utf-8"))
    b3d = json.loads((PROC / "campus_buildings_3d.geojson").read_text(encoding="utf-8"))

    # 建筑高度查表
    hmap = {f["properties"]["osm_id"]: f["properties"] for f in b3d["features"]}

    feats = []
    for ft in src["features"]:
        p = ft["properties"]
        if not p.get("in_campus"):
            continue
        cat = p.get("category", "")
        kind = cat.split(":")[0]
        # 只保留对地图有意义的要素
        if kind not in ("building", "highway", "leisure", "natural", "landuse", "barrier"):
            continue
        props = {
            "kind": kind,
            "sub": cat.split(":", 1)[1] if ":" in cat else "",
            "name": p.get("name", ""),
        }
        if kind == "building":
            h = hmap.get(p["osm_id"], {})
            props["levels"] = h.get("levels", 0)
            props["height_m"] = h.get("height_m", 0)
            props["height_basis"] = h.get("height_basis", "")
        feats.append({"type": "Feature", "geometry": ft["geometry"], "properties": props})

    return {
        "type": "FeatureCollection",
        "features": feats,
        "boundary": boundary["features"][0]["geometry"],
    }


# 天津市城市管理委员会《天津市适宜园林树木栽植导则》推荐行道树/庭荫树，
# 加上校园常见的绿篱、花灌木。这是本地真实物种，供学生实地对照选择。
SPECIES = [
    # --- 行道树（TJ 导则首选） ---
    {"id": "baifa",     "name": "白蜡",       "latin": "Fraxinus chinensis",  "type": "落叶乔木", "role": "行道树", "icon": "🌳", "color": "#7cb342"},
    {"id": "guohuai",   "name": "国槐",       "latin": "Sophora japonica",    "type": "落叶乔木", "role": "行道树", "icon": "🌳", "color": "#558b2f"},
    {"id": "futong",    "name": "法桐",       "latin": "Platanus orientalis", "type": "落叶乔木", "role": "行道树", "icon": "🌳", "color": "#8bc34a"},
    {"id": "luan",      "name": "栾树",       "latin": "Koelreuteria",        "type": "落叶乔木", "role": "行道树", "icon": "🌳", "color": "#9ccc65"},
    {"id": "maobaiyang","name": "毛白杨",     "latin": "Populus tomentosa",   "type": "落叶乔木", "role": "行道树", "icon": "🌳", "color": "#689f38"},
    {"id": "chouchun",  "name": "臭椿",       "latin": "Ailanthus altissima", "type": "落叶乔木", "role": "行道树", "icon": "🌳", "color": "#7cb342"},
    {"id": "qiantouchun","name": "千头椿",    "latin": "Ailanthus altissima 'Qiantou'", "type": "落叶乔木", "role": "行道树", "icon": "🌳", "color": "#827717"},
    {"id": "cihuai",    "name": "刺槐",       "latin": "Robinia pseudoacacia","type": "落叶乔木", "role": "行道树", "icon": "🌳", "color": "#558b2f"},
    # --- 庭荫树 ---
    {"id": "yinxing",   "name": "银杏",       "latin": "Ginkgo biloba",       "type": "落叶乔木", "role": "庭荫树", "icon": "🍂", "color": "#fdd835"},
    {"id": "paotong",   "name": "泡桐",       "latin": "Paulownia",           "type": "落叶乔木", "role": "庭荫树", "icon": "💜", "color": "#ab47bc"},
    {"id": "qingtong",  "name": "青桐",       "latin": "Firmiana simplex",    "type": "落叶乔木", "role": "庭荫树", "icon": "🌳", "color": "#66bb6a"},
    {"id": "hehuan",    "name": "合欢",       "latin": "Albizia julibrissin", "type": "落叶乔木", "role": "庭荫树", "icon": "🌸", "color": "#f48fb1"},
    {"id": "yushu",     "name": "榆树",       "latin": "Ulmus pumila",        "type": "落叶乔木", "role": "庭荫树", "icon": "🌳", "color": "#795548"},
    {"id": "zhuang",    "name": "皂角",       "latin": "Gleditsia sinensis",  "type": "落叶乔木", "role": "庭荫树", "icon": "🌳", "color": "#6d4c41"},
    {"id": "goushu",    "name": "构树",       "latin": "Broussonetia",        "type": "落叶乔木", "role": "庭荫树", "icon": "🌳", "color": "#8d6e63"},
    {"id": "sang",      "name": "桑树",       "latin": "Morus alba",          "type": "落叶乔木", "role": "庭荫树", "icon": "🍇", "color": "#7e57c2"},
    {"id": "huangjinshu","name": "黄金树",    "latin": "Catalpa speciosa",    "type": "落叶乔木", "role": "庭荫树", "icon": "🌳", "color": "#fbc02d"},
    # --- 常绿 / 针叶 ---
    {"id": "kuai",      "name": "桧柏",       "latin": "Juniperus chinensis","type": "常绿乔木", "role": "常绿",   "icon": "🌲", "color": "#2e7d32"},
    {"id": "you",       "name": "油松",       "latin": "Pinus tabuliformis",  "type": "常绿乔木", "role": "常绿",   "icon": "🌲", "color": "#1b5e20"},
    {"id": "bai",       "name": "侧柏",       "latin": "Platycladus orientalis","type": "常绿乔木","role": "常绿",  "icon": "🌲", "color": "#33691e"},
    {"id": "xue",       "name": "雪松",       "latin": "Cedrus deodara",      "type": "常绿乔木", "role": "常绿",   "icon": "🌲", "color": "#004d40"},
    # --- 观花 / 小乔木 ---
    {"id": "zijing",    "name": "紫荆",       "latin": "Cercis chinensis",    "type": "小乔木",   "role": "观花",   "icon": "🌸", "color": "#ec407a"},
    {"id": "zwei",      "name": "紫薇",       "latin": "Lagerstroemia indica","type": "小乔木",   "role": "观花",   "icon": "🌸", "color": "#e91e63"},
    {"id": "congzhi",   "name": "丛生紫叶李", "latin": "Prunus cerasifera",   "type": "小乔木",   "role": "观花",   "icon": "🌸", "color": "#d81b60"},
    {"id": "tao",       "name": "碧桃",       "latin": "Prunus persica",      "type": "小乔木",   "role": "观花",   "icon": "🌸", "color": "#ff80ab"},
    {"id": "dingxiang", "name": "丁香",       "latin": "Syringa",             "type": "灌木",     "role": "观花",   "icon": "💜", "color": "#9c27b0"},
    {"id": "lianshu",   "name": "连翘",       "latin": "Forsythia suspensa",  "type": "灌木",     "role": "观花",   "icon": "💛", "color": "#ffca28"},
    # --- 绿篱 ---
    {"id": "huangyang", "name": "大叶黄杨",   "latin": "Euonymus japonicus",  "type": "常绿灌木", "role": "绿篱",   "icon": "🟩", "color": "#00c853"},
    {"id": "nvzhen",    "name": "女贞",       "latin": "Ligustrum lucidum",   "type": "灌木",     "role": "绿篱",   "icon": "🟩", "color": "#64dd17"},
    {"id": "yueji",     "name": "月季",       "latin": "Rosa chinensis",      "type": "灌木",     "role": "观花",   "icon": "🌹", "color": "#f44336"},
    # --- 兜底 ---
    {"id": "unknown",   "name": "暂不确定",   "latin": "",                    "type": "-",        "role": "待定",   "icon": "❓", "color": "#9e9e9e"},
]


def main() -> None:
    WEB.mkdir(parents=True, exist_ok=True)
    TILES.mkdir(parents=True, exist_ok=True)

    print("生成网页数据…")
    campus = build_campus_geojson()
    (WEB / "campus.json").write_text(
        json.dumps(campus, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(f"  campus.json: {len(campus['features'])} 个要素")

    (WEB / "species.json").write_text(
        json.dumps(SPECIES, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(f"  species.json: {len(SPECIES)} 个物种")

    print("下载离线瓦片…")
    meta = build_tiles()
    (WEB / "tiles_meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")

    s, w, n, e = campus_bbox()
    (WEB / "bounds.json").write_text(
        json.dumps({"south": s, "west": w, "north": n, "east": e,
                    "center": [(s + n) / 2, (w + e) / 2]}, indent=1), encoding="utf-8"
    )
    print(f"  范围: lat {s:.5f}..{n:.5f}  lon {w:.5f}..{e:.5f}")


if __name__ == "__main__":
    main()

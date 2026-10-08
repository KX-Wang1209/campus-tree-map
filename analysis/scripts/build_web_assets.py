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


# --------------------------------------------------------------------
# 建筑名称：来源是学校提供的规划鸟瞰效果图（图上用红字标注）。
# 效果图是透视图，先把图上的红字位置提取出来，再用单应变换配准到真实
# 经纬度（配准残差 0.7～38 px，约合 0.3～18 m），然后取最近的 OSM 建筑。
# 只保留距离足够近、且用途对得上的；配不准的不硬套。
# --------------------------------------------------------------------
NAME_MAP = {
    "way/1497712899": "学生活动中心",
    "way/1497712900": "二食堂",
    "way/1497712902": "一食堂",
    "way/1497712918": "艺术系",
    "way/1497708670": "国语系",
    "way/1497712911": "行政楼",
    "way/1497708671": "商务系",
    "way/1497708669": "主教学楼",
    "way/1497708672": "图书馆",
    "way/1497758057": "一报",
    "way/1497712894": "实训基地",
}

# 效果图上标了、但 OSM 里没有对应建筑轮廓的点位（按配准结果落位）。
# 主要是一些独立构筑物和校门，以及 2025-05 影像上还没建成、OSM 未收录的楼。
POIS = [
    {"name": "医务室", "lon": 117.63645, "lat": 39.06980,
     "note": "规划图标注，OSM 无对应轮廓"},
    {"name": "北门",   "lon": 117.63930, "lat": 39.07015, "note": "校园北侧校门"},
    {"name": "南门",   "lon": 117.63890, "lat": 39.06495, "note": "校园南侧校门"},
    {"name": "东门",   "lon": 117.64203, "lat": 39.06630, "note": "校园东侧校门"},
    {"name": "长河楼", "lon": 117.64153, "lat": 39.06760,
     "note": "湖边弧形建筑，OSM 未收录"},
    {"name": "二报",   "lon": 117.64180, "lat": 39.06700,
     "note": "第二报告厅；2025-05 影像上尚未建成，位置据规划图推算"},
]

# 南侧那栋 220 米长的楼，规划图上分属两个系：西边物流系、东边经管系。
# OSM 里是一个整体多边形，所以按经度切成两段分别命名。
SPLIT_BY_LON = {
    "way/1497712889": (117.63910, "物流系", "经管系"),
}


def _cut_x(a, b, xc):
    """线段 a→b 与竖直线 x=xc 的交点。"""
    if b[0] == a[0]:
        return [xc, a[1]]
    t = (xc - a[0]) / (b[0] - a[0])
    return [xc, a[1] + t * (b[1] - a[1])]


def clip_vertical(pts, xc, keep_west):
    """把多边形按竖直线裁成两半（Sutherland–Hodgman）。

    只用于南侧那栋长楼的拆分 —— 它是个接近矩形的长条，
    这个算法足够；形状复杂的多边形会有细缝，所以没做成通用工具。
    """
    out = []
    n = len(pts)
    for i in range(n):
        cur, prv = pts[i], pts[i - 1]
        cin = cur[0] <= xc if keep_west else cur[0] >= xc
        pin = prv[0] <= xc if keep_west else prv[0] >= xc
        if cin:
            if not pin:
                out.append(_cut_x(prv, cur, xc))
            out.append(cur)
        elif pin:
            out.append(_cut_x(prv, cur, xc))
    if len(out) >= 3 and out[0] != out[-1]:
        out.append(out[0])            # 闭合
    return out


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
        # OSM 自带的名称优先，没有的用规划图读出来的
        if not props["name"]:
            props["name"] = NAME_MAP.get(p.get("osm_id", ""), "")
            if props["name"]:
                props["name_src"] = "plan"     # 来自学校规划效果图
        if kind == "building":
            h = hmap.get(p["osm_id"], {})
            props["levels"] = h.get("levels", 0)
            props["height_m"] = h.get("height_m", 0)
            props["height_basis"] = h.get("height_basis", "")

        # 南侧那栋 220 米长楼：规划图上西边是物流系、东边是经管系。
        # OSM 只给了整体轮廓，所以按经度切成两段，各自挂名字。
        oid = p.get("osm_id", "")
        if oid in SPLIT_BY_LON and ft["geometry"]["type"] == "Polygon":
            xc, west_name, east_name = SPLIT_BY_LON[oid]
            ring = ft["geometry"]["coordinates"][0]
            for keep_west, nm in ((True, west_name), (False, east_name)):
                part = clip_vertical(ring, xc, keep_west)
                if len(part) < 4:
                    continue
                p2 = dict(props)
                p2["name"] = nm
                p2["name_src"] = "plan"
                feats.append({
                    "type": "Feature",
                    "geometry": {"type": "Polygon", "coordinates": [part]},
                    "properties": p2,
                })
            continue

        feats.append({"type": "Feature", "geometry": ft["geometry"], "properties": props})

    # 规划图上有、但 OSM 没有轮廓的点位（校门、独立建筑）
    for poi in POIS:
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [poi["lon"], poi["lat"]]},
            "properties": {"kind": "poi", "sub": "", "name": poi["name"],
                           "note": poi.get("note", ""), "name_src": "plan"},
        })

    return {
        "type": "FeatureCollection",
        "features": feats,
        "boundary": boundary["features"][0]["geometry"],
    }


# 树种库：按学校《校园植物名录（26年10月）》整理。
# 四类共 65 种（乔木 37、灌木藤木 24、草本 3、竹类 1），
# 每类末尾加一个「其他」，用于补录名录之外的树种。
SPECIES = [
    # ============ 乔木（37 种） ============
    {"id": "yinxing", "name": "银杏", "role": "乔木", "icon": "🍂", "color": "#fdd835"},
    {"id": "yuanbai", "name": "圆柏", "role": "乔木", "icon": "🌲", "color": "#2e7d32"},
    {"id": "maobaiyang", "name": "毛白杨", "role": "乔木", "icon": "🌳", "color": "#558b2f"},
    {"id": "liushu", "name": "柳树", "role": "乔木", "icon": "🌳", "color": "#7cb342"},
    {"id": "hetao", "name": "核桃", "role": "乔木", "icon": "🌰", "color": "#6d4c41"},
    {"id": "yushu", "name": "榆树", "role": "乔木", "icon": "🌳", "color": "#795548"},
    {"id": "yulan", "name": "玉兰", "role": "乔木", "icon": "🌸", "color": "#f48fb1"},
    {"id": "xuanlingmu", "name": "悬铃木", "role": "乔木", "icon": "🌳", "color": "#8bc34a"},
    {"id": "pingguo", "name": "苹果", "role": "乔木", "icon": "🍎", "color": "#ef5350"},
    {"id": "xifuhaitang", "name": "西府海棠", "role": "乔木", "icon": "🌸", "color": "#ec407a"},
    {"id": "chuisihaitang", "name": "垂丝海棠", "role": "乔木", "icon": "🌸", "color": "#f06292"},
    {"id": "hongbaoshi", "name": "红宝石海棠", "role": "乔木", "icon": "🌸", "color": "#d81b60"},
    {"id": "shanzha", "name": "山楂", "role": "乔木", "icon": "🌳", "color": "#c62828"},
    {"id": "lishu", "name": "梨树", "role": "乔木", "icon": "🍐", "color": "#aed581"},
    {"id": "lishu2", "name": "李树", "role": "乔木", "icon": "🌳", "color": "#9ccc65"},
    {"id": "ziyeli", "name": "紫叶李", "role": "乔木", "icon": "🍂", "color": "#7b1fa2"},
    {"id": "ribenwanying", "name": "日本晚樱", "role": "乔木", "icon": "🌸", "color": "#f8bbd0"},
    {"id": "shantao", "name": "山桃", "role": "乔木", "icon": "🌸", "color": "#f48fb1"},
    {"id": "maotao", "name": "毛桃", "role": "乔木", "icon": "🍑", "color": "#ffb74d"},
    {"id": "bitao", "name": "碧桃", "role": "乔木", "icon": "🌸", "color": "#ff80ab"},
    {"id": "yingtao", "name": "樱桃", "role": "乔木", "icon": "🍒", "color": "#e53935"},
    {"id": "xingshu", "name": "杏树", "role": "乔木", "icon": "🌸", "color": "#ffb300"},
    {"id": "hehuan", "name": "合欢", "role": "乔木", "icon": "🌸", "color": "#f06292"},
    {"id": "cihuai", "name": "刺槐", "role": "乔木", "icon": "🌳", "color": "#689f38"},
    {"id": "guohuai", "name": "国槐", "role": "乔木", "icon": "🌳", "color": "#33691e"},
    {"id": "longzhuai", "name": "龙爪槐", "role": "乔木", "icon": "🌳", "color": "#558b2f"},
    {"id": "wuyehuai", "name": "五叶槐", "role": "乔木", "icon": "🌳", "color": "#7cb342"},
    {"id": "chouchun", "name": "臭椿", "role": "乔木", "icon": "🌳", "color": "#827717"},
    {"id": "xiangchun", "name": "香椿", "role": "乔木", "icon": "🌿", "color": "#afb42b"},
    {"id": "huojushu", "name": "火炬树", "role": "乔木", "icon": "🍂", "color": "#bf360c"},
    {"id": "huanglu", "name": "黄栌", "role": "乔木", "icon": "🍂", "color": "#8d6e63"},
    {"id": "yuanbaofeng", "name": "元宝枫", "role": "乔木", "icon": "🍁", "color": "#d84315"},
    {"id": "luanshu", "name": "栾树", "role": "乔木", "icon": "🌳", "color": "#cddc39"},
    {"id": "zaoshu", "name": "枣树", "role": "乔木", "icon": "🌳", "color": "#a1887f"},
    {"id": "shishu", "name": "柿树", "role": "乔木", "icon": "🍊", "color": "#ff7043"},
    {"id": "baila", "name": "白蜡", "role": "乔木", "icon": "🌳", "color": "#43a047"},
    {"id": "maopaotong", "name": "毛泡桐", "role": "乔木", "icon": "💜", "color": "#ab47bc"},
    {"id": "other_qiao", "name": "其他", "role": "乔木", "icon": "➕", "color": "#90a4ae", "isOther": True},
    # ============ 灌木 / 藤木（24 种） ============
    {"id": "xiaolongbai", "name": "小龙柏", "role": "灌木或藤木", "icon": "🌲", "color": "#1b5e20"},
    {"id": "qiangwei", "name": "蔷薇", "role": "灌木或藤木", "icon": "🌹", "color": "#f06292"},
    {"id": "yueji", "name": "月季", "role": "灌木或藤木", "icon": "🌹", "color": "#e91e63"},
    {"id": "huangcimei", "name": "黄刺玫", "role": "灌木或藤木", "icon": "🌼", "color": "#fdd835"},
    {"id": "yuyemei", "name": "榆叶梅", "role": "灌木或藤木", "icon": "🌸", "color": "#ec407a"},
    {"id": "zhenzhumei", "name": "珍珠梅", "role": "灌木或藤木", "icon": "🌸", "color": "#cfd8dc"},
    {"id": "ziteng", "name": "紫藤", "role": "灌木或藤木", "icon": "💜", "color": "#7e57c2"},
    {"id": "zisuihuai", "name": "紫穗槐", "role": "灌木或藤木", "icon": "🌿", "color": "#5e35b1"},
    {"id": "huajiao", "name": "花椒", "role": "灌木或藤木", "icon": "🌿", "color": "#8d6e63"},
    {"id": "xiaoyehuangyang", "name": "小叶黄杨", "role": "灌木或藤木", "icon": "🟩", "color": "#00c853"},
    {"id": "dayehuangyang", "name": "大叶黄杨", "role": "灌木或藤木", "icon": "🟩", "color": "#64dd17"},
    {"id": "wuyedijin", "name": "五叶地锦", "role": "灌木或藤木", "icon": "🍁", "color": "#c62828"},
    {"id": "mujin", "name": "木槿", "role": "灌木或藤木", "icon": "🌺", "color": "#ab47bc"},
    {"id": "chengliu", "name": "柽柳", "role": "灌木或藤木", "icon": "🌸", "color": "#f48fb1"},
    {"id": "ziwei", "name": "紫薇", "role": "灌木或藤木", "icon": "🌸", "color": "#e91e63"},
    {"id": "shiliu", "name": "石榴", "role": "灌木或藤木", "icon": "🌺", "color": "#ff5722"},
    {"id": "hongruimu", "name": "红瑞木", "role": "灌木或藤木", "icon": "🌿", "color": "#d32f2f"},
    {"id": "lianqiao", "name": "连翘", "role": "灌木或藤木", "icon": "💛", "color": "#ffca28"},
    {"id": "dingxiang", "name": "丁香", "role": "灌木或藤木", "icon": "💜", "color": "#9c27b0"},
    {"id": "jinyenvzhen", "name": "金叶女贞", "role": "灌木或藤木", "icon": "🟨", "color": "#cddc39"},
    {"id": "yingchun", "name": "迎春", "role": "灌木或藤木", "icon": "💛", "color": "#ffeb3b"},
    {"id": "lingxiao", "name": "凌霄", "role": "灌木或藤木", "icon": "🌼", "color": "#ff7043"},
    {"id": "jinyinmu", "name": "金银木", "role": "灌木或藤木", "icon": "🌼", "color": "#f9a825"},
    {"id": "fengweilan", "name": "凤尾兰", "role": "灌木或藤木", "icon": "🌿", "color": "#a5d6a7"},
    {"id": "other_guan", "name": "其他", "role": "灌木或藤木", "icon": "➕", "color": "#90a4ae", "isOther": True},
    # ============ 草本（3 种） ============
    {"id": "feicai", "name": "费菜", "role": "草本", "icon": "🌼", "color": "#ffd54f"},
    {"id": "yuzan", "name": "玉簪", "role": "草本", "icon": "🌸", "color": "#b39ddb"},
    {"id": "yuanwei", "name": "鸢尾", "role": "草本", "icon": "💜", "color": "#7986cb"},
    {"id": "other_cao", "name": "其他", "role": "草本", "icon": "➕", "color": "#90a4ae", "isOther": True},
    # ============ 竹类（1 种） ============
    {"id": "zaoyuanzhu", "name": "早园竹", "role": "竹类", "icon": "🎋", "color": "#00897b"},
    {"id": "other_zhu", "name": "其他", "role": "竹类", "icon": "➕", "color": "#90a4ae", "isOther": True},
    # ============ 兜底 ============
    {"id": "unknown", "name": "暂不确定", "role": "待定", "icon": "❓", "color": "#9e9e9e"},
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

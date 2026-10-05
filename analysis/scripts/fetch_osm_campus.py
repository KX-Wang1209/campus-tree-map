#!/usr/bin/env python3
"""天津滨海职业学院（本部，塘沽庐山道 1101 号）OpenStreetMap 矢量数据获取。

用途：数字校园地图项目的基础底图数据源评估与建库。

调研实测结论（见 results/reports/ 可行性调研报告）：
  * OSM 在本校区有 26 栋建筑轮廓，与 Esri 卫星影像贴合良好（含 9 栋学生公寓的
    门厅凸出等细节），可直接作为二维/三维底图。
  * 但 **OSM 中单棵树木记录数为 0**（本校区及周边 bbox 内均无 natural=tree 节点），
    树木信息必须人工录入，这是本项目真正的数据工作量所在。
  * 建筑标签只有 building 与少量 name，缺少 building:levels / height，
    三维体块高度需要另行估算（按建筑类型给默认层高）。

输出（WGS84 / EPSG:4326）：
  data/raw/osm/campus_boundary.geojson     校园边界多边形
  data/raw/osm/campus_osm_features.geojson 边界内外的建筑/道路/场地/水体等要素
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "raw" / "osm"

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
HEADERS = {"User-Agent": "wisp-science-campus-map/1.0 (digitising campus trees)"}

# 校园外扩约 100 m 的查询范围 (S, W, N, E)
BBOX = (39.0628, 117.6290, 39.0719, 117.6440)

QUERY_BOUNDARY = """
[out:json][timeout:120];
way["amenity"="university"]["name"~"滨海职业"]({s},{w},{n},{e});
out geom tags;
"""

QUERY_FEATURES = """
[out:json][timeout:180];
(
  way["building"]({s},{w},{n},{e});
  way["highway"]({s},{w},{n},{e});
  way["landuse"]({s},{w},{n},{e});
  way["leisure"]({s},{w},{n},{e});
  way["natural"]({s},{w},{n},{e});
  way["barrier"]({s},{w},{n},{e});
  way["amenity"]({s},{w},{n},{e});
  node["natural"="tree"]({s},{w},{n},{e});
  node["amenity"="tree"]({s},{w},{n},{e});
);
out geom tags;
"""


def overpass(query: str) -> dict:
    last = None
    for host in ENDPOINTS:
        try:
            r = requests.post(host, data={"data": query}, headers=HEADERS, timeout=200)
            if r.status_code == 200:
                return r.json()
            last = f"{host} -> HTTP {r.status_code}: {r.text[:160]}"
        except Exception as exc:  # noqa: BLE001
            last = f"{host} -> {type(exc).__name__}: {exc}"
        time.sleep(3)
    raise RuntimeError(f"所有 Overpass 节点均失败: {last}")


def point_in_polygon(lat: float, lon: float, poly: list[tuple[float, float]]) -> bool:
    """射线法判断点是否在多边形内，poly 为 [(lat, lon), ...]。"""
    inside = False
    n = len(poly)
    for i in range(n):
        y1, x1 = poly[i]
        y2, x2 = poly[(i + 1) % n]
        if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def feature_category(tags: dict) -> str:
    for key in ("building", "highway", "leisure", "landuse", "natural", "barrier", "amenity"):
        if key in tags:
            return f"{key}:{tags[key]}"
    return "other"


def to_features(elements: list[dict], poly: list[tuple[float, float]] | None) -> list[dict]:
    feats = []
    for el in elements:
        tags = el.get("tags", {})
        if el.get("type") == "node":
            geom = {"type": "Point", "coordinates": [el["lon"], el["lat"]]}
            anchor = (el["lat"], el["lon"])
        elif el.get("geometry"):
            ring = [[p["lon"], p["lat"]] for p in el["geometry"]]
            if len(ring) >= 4 and ring[0] == ring[-1]:
                geom = {"type": "Polygon", "coordinates": [ring]}
            else:
                geom = {"type": "LineString", "coordinates": ring}
            anchor = (
                sum(p["lat"] for p in el["geometry"]) / len(el["geometry"]),
                sum(p["lon"] for p in el["geometry"]) / len(el["geometry"]),
            )
        elif el.get("center"):
            geom = {"type": "Point", "coordinates": [el["center"]["lon"], el["center"]["lat"]]}
            anchor = (el["center"]["lat"], el["center"]["lon"])
        else:
            continue

        props = dict(tags)
        props["osm_id"] = f"{el['type']}/{el['id']}"
        props["category"] = feature_category(tags)
        if el.get("timestamp"):
            props["osm_last_edit"] = el["timestamp"]
        if poly is not None:
            props["in_campus"] = point_in_polygon(anchor[0], anchor[1], poly)

        feats.append({"type": "Feature", "id": props["osm_id"], "geometry": geom, "properties": props})
    return feats


def write_geojson(path: Path, features: list[dict], note: str) -> None:
    doc = {
        "type": "FeatureCollection",
        "metadata": {
            "source": "OpenStreetMap via Overpass API, ODbL 1.0",
            "fetched_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "crs": "EPSG:4326",
            "note": note,
        },
        "features": features,
    }
    path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    s, w, n, e = BBOX

    b = overpass(QUERY_BOUNDARY.format(s=s, w=w, n=n, e=e))
    boundary_ways = [el for el in b["elements"] if el.get("type") == "way"]
    if not boundary_ways:
        raise RuntimeError("未找到校园边界")
    poly = [(p["lat"], p["lon"]) for p in boundary_ways[0]["geometry"]]
    write_geojson(
        OUT / "campus_boundary.geojson",
        to_features(boundary_ways, None),
        "天津滨海职业学院校园边界；OSM 标签 amenity=university",
    )

    time.sleep(2)
    f = overpass(QUERY_FEATURES.format(s=s, w=w, n=n, e=e))
    feats = to_features(f["elements"], poly)
    write_geojson(
        OUT / "campus_osm_features.geojson",
        feats,
        "校园及周边建筑/道路/场地/水体/绿地要素；in_campus 字段标注是否落在校园边界内",
    )

    # ---- 摘要 ----
    inb = [x for x in feats if x["properties"].get("in_campus")]
    print(f"边界顶点数          : {len(poly)}")
    print(f"要素总数            : {len(feats)}  (边界内 {len(inb)})")

    from collections import Counter

    cnt = Counter()
    for x in inb:
        c = x["properties"]["category"]
        cnt[c.split(":")[0]] += 1
    for k, v in cnt.most_common():
        print(f"  边界内 {k:<10}: {v}")

    trees = [x for x in feats if "tree" in x["properties"]["category"]]
    print(f"\n树木节点 (natural=tree / amenity=tree) : {len(trees)}  <-- 关键：需人工录入")
    print("输出目录:", OUT)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""校园树木地图 —— 协作服务器（零依赖，只用 Python 标准库）

学生各记各的，数据实时汇总到这台机器上，不用再收文件、手工合并。
谁记了什么，其他人几秒钟内就能看到。

用法：
    python3 web/server.py            # 默认 8080 端口
    python3 web/server.py 9000       # 换端口

启动后把打印出来的地址发给学生，手机浏览器打开就能用。

数据都放在 data/live/ 下：
    data/live/trees.json     所有树木记录
    data/live/photos/*.jpg   照片
想清空重来，删掉 data/live/ 目录即可。
"""
from __future__ import annotations

import base64
import hashlib
import json
import queue
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
LIVE = ROOT / "data" / "live"
PHOTOS = LIVE / "photos"
TREES_FILE = LIVE / "trees.json"

_lock = threading.Lock()
_trees: dict[str, dict] = {}          # id -> 记录
_subs: list[queue.Queue] = []         # 每个在线浏览器一个队列（用于实时推送）
_started = 0


# ----------------------------------------------------------------- 存取
def load_trees() -> None:
    global _trees
    if TREES_FILE.exists():
        try:
            doc = json.loads(TREES_FILE.read_text(encoding="utf-8"))
            _trees = {t["id"]: t for t in doc.get("trees", []) if t.get("id")}
        except Exception as e:
            print(f"  ! trees.json 读取失败，从空数据开始：{e}")
            _trees = {}


def save_trees() -> None:
    """原子写入，避免断电/崩溃时把数据写坏。"""
    LIVE.mkdir(parents=True, exist_ok=True)
    tmp = TREES_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"trees": list(_trees.values())}, ensure_ascii=False),
                   encoding="utf-8")
    tmp.replace(TREES_FILE)


def store_photos(rec: dict) -> dict:
    """把记录里的 dataURL 照片落成文件，换成可访问的路径。

    已经是路径的（编辑时回传）原样保留。
    """
    out = []
    for p in (rec.get("photos") or [])[:3]:
        if not isinstance(p, str) or not p:
            continue
        if p.startswith("data:image/"):
            try:
                b64 = p.split(",", 1)[1]
                raw = base64.b64decode(b64)
            except Exception:
                continue
            name = hashlib.sha1(raw).hexdigest()[:16] + ".jpg"
            fp = PHOTOS / name
            if not fp.exists():
                PHOTOS.mkdir(parents=True, exist_ok=True)
                fp.write_bytes(raw)
            out.append(f"photos/{name}")
        else:
            out.append(p)
    rec["photos"] = out
    return rec


def broadcast(event: dict) -> None:
    with _lock:
        subs = list(_subs)
    for q in subs:
        try:
            q.put_nowait(event)
        except Exception:
            pass


# ----------------------------------------------------------------- 校验
# 校园大致范围（外扩一些），用来挡掉明显错误/恶意的坐标
BOUNDS = (39.055, 117.615, 39.080, 117.660)      # S, W, N, E
DUP_RADIUS_M = 15.0


def _valid_coords(rec: dict) -> bool:
    lat, lon = rec.get("lat"), rec.get("lon")
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return False
    if lat != lat or lon != lon:                 # NaN
        return False
    return BOUNDS[0] <= lat <= BOUNDS[2] and BOUNDS[1] <= lon <= BOUNDS[3]


def _dist_m(a: dict, b: dict) -> float:
    import math
    R = 6371000.0
    dlat = math.radians(b["lat"] - a["lat"])
    dlon = math.radians(b["lon"] - a["lon"])
    lat = math.radians((a["lat"] + b["lat"]) / 2)
    return math.hypot(dlat, dlon * math.cos(lat)) * R


def _same_place(a: dict, b: dict) -> bool:
    """两条记录是否指向同一棵树（用容错半径判断，容忍 GPS 误差）"""
    return _dist_m(a, b) <= DUP_RADIUS_M


def _rand4() -> str:
    import secrets
    return secrets.token_hex(2)


# ----------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "TreeMap/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):        # 静音默认日志，只留关键事件
        pass

    # ---- 工具 ----
    def send_json(self, obj, code: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, body: bytes, ctype: str, cache: bool = False) -> None:
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if cache:
            self.send_header("Cache-Control", "public, max-age=604800")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return None
        raw = self.rfile.read(n)
        try:
            return json.loads(raw)
        except Exception:
            return None

    def resolve(self, rel: str) -> Path | None:
        """把 URL 路径映射到 web/ 下的文件，挡住目录穿越。"""
        rel = unquote(rel).lstrip("/")
        if not rel:
            rel = "index.html"
        p = (WEB / rel).resolve()
        try:
            p.relative_to(WEB.resolve())
        except ValueError:
            return None
        return p if p.is_file() else None

    # ---- GET ----
    def do_GET(self):
        try:
            path = urlparse(self.path).path

            if path == "/api/snapshot":
                with _lock:
                    trees = list(_trees.values())
                return self.send_json({"trees": trees, "server": True})

            if path == "/api/status":
                with _lock:
                    n = len(_trees), len(_subs)
                return self.send_json({"trees": n[0], "online": n[1]})

            if path == "/api/info":
                return self.send_json({
                    "lan": f"http://{lan_ip()}:{self.server.server_address[1]}/",
                    "port": self.server.server_address[1],
                    "dataDir": str(LIVE),
                })

            if path == "/api/events":
                return self.sse()

            # 照片
            if path.startswith("/photos/"):
                fp = (PHOTOS / Path(path).name).resolve()
                try:
                    fp.relative_to(PHOTOS.resolve())
                except ValueError:
                    return self.send_error(403)
                if fp.is_file():
                    return self.send_bytes(fp.read_bytes(), "image/jpeg", cache=True)
                return self.send_error(404)

            # 静态文件
            fp = self.resolve(path)
            if fp is None:
                return self.send_error(404)
            ctype = {
                ".html": "text/html; charset=utf-8",
                ".js": "application/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8",
                ".json": "application/json; charset=utf-8",
                ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                ".png": "image/png", ".svg": "image/svg+xml",
            }.get(fp.suffix.lower(), "application/octet-stream")
            cache = "/tiles/" in path or "/vendor/" in path
            return self.send_bytes(fp.read_bytes(), ctype, cache=cache)

        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                self.send_json({"error": str(e)}, 500)
            except Exception:
                pass

    # ---- 实时推送 ----
    def sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        q: queue.Queue = queue.Queue()
        with _lock:
            _subs.append(q)
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    ev = q.get(timeout=20)
                    line = json.dumps(ev, ensure_ascii=False)
                    self.wfile.write(f"data: {line}\n\n".encode())
                    self.wfile.flush()
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")     # 心跳，防代理断连
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with _lock:
                if q in _subs:
                    _subs.remove(q)

    # ---- POST ----
    def do_POST(self):
        try:
            path = urlparse(self.path).path
            body = self.read_json()
            if body is None:
                return self.send_json({"error": "请求体不是合法 JSON"}, 400)

            if path == "/api/trees":
                rec = body.get("tree") or body
                if not rec.get("id"):
                    return self.send_json({"error": "记录缺少 id"}, 400)
                if not _valid_coords(rec):
                    return self.send_json({"error": "记录坐标不合法"}, 400)

                rec = store_photos(rec)
                guarded = False
                with _lock:
                    old = _trees.get(rec["id"])
                    if old is not None and not _same_place(old, rec):
                        # 同一个 id 但位置差很远：不同的人各自生成的 id 撞号了。
                        # 直接覆盖会把别人的记录悄悄抹掉，这里换个新 id 存下来。
                        rec["id"] = f"{rec['id']}_{_rand4()}"
                        rec["id_conflict"] = True
                        guarded = True
                    _trees[rec["id"]] = rec
                    save_trees()
                broadcast({"type": "upsert", "tree": rec})
                return self.send_json({"ok": True, "tree": rec, "renamed": guarded})

            if path == "/api/bulk":
                items = body.get("trees") or []
                saved = []
                for rec in items:
                    if not rec.get("id") or not _valid_coords(rec):
                        continue
                    rec = store_photos(rec)
                    with _lock:
                        old = _trees.get(rec["id"])
                        if old is not None and not _same_place(old, rec):
                            rec["id"] = f"{rec['id']}_{_rand4()}"
                        _trees[rec["id"]] = rec
                    saved.append(rec)
                with _lock:
                    save_trees()
                if saved:
                    broadcast({"type": "bulk", "trees": saved})
                return self.send_json({"ok": True, "count": len(saved)})

            return self.send_json({"error": "未知接口"}, 404)

        except Exception as e:
            try:
                self.send_json({"error": str(e)}, 500)
            except Exception:
                pass

    # ---- DELETE ----
    def do_DELETE(self):
        try:
            path = urlparse(self.path).path
            if path.startswith("/api/trees/"):
                tid = unquote(path.rsplit("/", 1)[-1])
                with _lock:
                    existed = _trees.pop(tid, None)
                    if existed:
                        save_trees()
                if existed:
                    broadcast({"type": "delete", "id": tid})
                return self.send_json({"ok": bool(existed)})
            return self.send_json({"error": "未知接口"}, 404)
        except Exception as e:
            try:
                self.send_json({"error": str(e)}, 500)
            except Exception:
                pass


# ----------------------------------------------------------------- 启动
def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("0.0.0.0", port))
            return True
        except OSError:
            return False


def pick_port(want: int) -> tuple[int, bool]:
    """返回 (可用端口, 是否换过)。

    8080 常被 Tomcat、Jenkins 之类的程序占着，
    所以被占了就自动往后找一个，不用手动试。
    """
    if port_is_free(want):
        return want, False
    for p in range(want + 1, want + 21):
        if port_is_free(p):
            return p, True
    raise SystemExit(
        f"  {want}~{want + 20} 之间没有空闲端口。\n"
        f"  请手动指定一个，例如：python3 web/server.py 9000"
    )


def main() -> None:
    want = 8080
    if len(sys.argv) > 1:
        try:
            want = int(sys.argv[1])
        except ValueError:
            print(f"端口参数看不懂：{sys.argv[1]}，用默认 8080")

    LIVE.mkdir(parents=True, exist_ok=True)
    PHOTOS.mkdir(parents=True, exist_ok=True)
    load_trees()

    port, changed = pick_port(want)

    try:
        srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    except OSError as e:
        raise SystemExit(f"  端口 {port} 起不来：{e}\n  换个端口试试：python3 web/server.py 9000")
    srv.daemon_threads = True

    ip = lan_ip()
    print()
    print("  校园树木地图 · 协作服务器")
    print("  " + "-" * 44)
    if changed:
        print(f"  提示：{want} 端口被别的程序占用了，已自动改用 {port}")
    print(f"  本机打开   : http://127.0.0.1:{port}/")
    print(f"  发给学生的 : http://{ip}:{port}/")
    print(f"  当前记录数 : {len(_trees)}")
    print("  " + "-" * 44)
    print("  按 Ctrl+C 停止。数据在 data/live/ 里，不会丢。")
    print()

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。数据保存在 data/live/")


if __name__ == "__main__":
    main()

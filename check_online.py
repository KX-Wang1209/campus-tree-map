#!/usr/bin/env python3
"""检查线上站点和本地 web/ 是否一致（只看，不改任何东西）。

为什么有这个脚本：
    学生实际用的是腾讯云静态托管的线上网址。本地改完、甚至推了 GitHub，
    线上都还是旧的 —— 必须手动上传才生效。这件事很容易忘，而且忘了以后
    从「代码是新的」完全看不出来。

    所以每次发版前跑一下它。一旦线上落后，它会明确报出来。

用法：
    python3 check_online.py          # 有差异时退出码为 1
    python3 check_online.py --quiet  # 只在有差异时输出
"""
from __future__ import annotations

import hashlib
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

WEB = ("https://campus-tree-map-d9fro6lv4b0094f8-1309202203"
       ".tcloudbaseapp.com/web/")
LOCAL = pathlib.Path(__file__).resolve().parent / "web"

# 页面真正会去读的文件，外加学生能直接打开的说明文档。
# 瓦片目录太大，单独跳过。
FILES = [
    "index.html", "app.js", "app.css", "view3d.js",
    "campus.json", "species.json", "bounds.json", "tiles_meta.json",
    "logo.svg", "logo.png",
    "使用说明.md",
]

CONSOLE = ("https://tcb.cloud.tencent.com/dev"
           "?envId=campus-tree-map-d9fro6lv4b0094f8#/static-hosting")


def md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def fetch(name: str) -> bytes | None:
    # 中文文件名要转义，否则 http 库按 ASCII 发送会直接报错
    url = WEB + urllib.parse.quote(name)
    req = urllib.request.Request(url,
                                 headers={"Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    except Exception:
        return None


def main() -> int:
    quiet = "--quiet" in sys.argv
    behind: list[str] = []
    missing: list[str] = []

    for name in FILES:
        local = LOCAL / name
        if not local.exists():
            continue
        remote = fetch(name)
        if remote is None:
            missing.append(name)
        elif md5(remote) != md5(local.read_bytes()):
            behind.append(name)

    if not behind and not missing:
        if not quiet:
            print("线上与本地一致，不用传。")
        return 0

    print()
    print("=" * 58)
    print("  线上站点落后于本地，要传！")
    print("=" * 58)
    if behind:
        print("  内容不一致：", "、".join(behind))
    if missing:
        print("  线上取不到  ：", "、".join(missing))
    print()
    print("  传到这里（进 web/ 目录，点「上传文件」，覆盖上去）：")
    print("  " + CONSOLE)
    print()
    print("  别忘了先把 web/app.js 里对应的 ?v= 号加一，")
    print("  否则学生手机还是读旧缓存。")
    print("  步骤见 web/使用说明.md 的「怎么更新线上」。")
    print("=" * 58)
    print()
    return 1


if __name__ == "__main__":
    sys.exit(main())

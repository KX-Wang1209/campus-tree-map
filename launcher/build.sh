#!/bin/sh
# 把整个网站打包成双击即用的应用（macOS 的 .app 和 Windows 的 .exe）
#
# 用法：sh launcher/build.sh
#
# 产物在 dist/ 下：
#   dist/校园树木地图-macOS.zip     （内含 .app，解压后双击）
#   dist/校园树木地图-Windows.zip   （内含 .exe，解压后双击）
#
# 需要 Go 工具链。本机没装的话，脚本会提示去哪拿。

set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)
LAUNCHER="$ROOT/launcher"
DIST="$ROOT/dist"

# --- 找 Go ---
GO=$(command -v go 2>/dev/null || true)
if [ -z "$GO" ] && [ -x "$HOME/local-tools/go/bin/go" ]; then
  GO="$HOME/local-tools/go/bin/go"
fi
if [ -z "$GO" ]; then
  echo "找不到 Go。"
  echo "  可以下载官方包解压到 ~/local-tools/go："
  echo "  https://go.dev/dl/"
  exit 1
fi
echo "使用 Go: $GO  ($("$GO" version))"

VERSION=$(date +%Y%m%d)

# --- 把网站复制进打包目录 ---
# embed 不支持软链接，所以必须实际复制一份
echo "复制网站文件…"
rm -rf "$LAUNCHER/web"
cp -R "$ROOT/web" "$LAUNCHER/web"
# 使用说明是给人看的，不需要打进应用里
rm -f "$LAUNCHER/web/使用说明.md"
# server.py 是 Python 版的服务，打包版用 Go 重写了，不需要
rm -f "$LAUNCHER/web/server.py"

SIZE=$(du -sh "$LAUNCHER/web" | cut -f1)
echo "  已复制（$SIZE）"

# --- 编译 ---
mkdir -p "$DIST"
cd "$LAUNCHER"

echo ""
echo "编译 macOS 版（Apple Silicon）…"
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 "$GO" build -buildvcs=false -trimpath -ldflags "-s -w" -o "$DIST/tree-macos-arm64" .

echo "编译 macOS 版（Intel 芯片的旧 Mac）…"
GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 "$GO" build -buildvcs=false -trimpath -ldflags "-s -w" -o "$DIST/tree-macos-intel" .

echo "编译 Windows 版…"
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 "$GO" build -buildvcs=false -trimpath -ldflags "-s -w" -o "$DIST/tree-windows.exe" .

# --- 组装 macOS app 包 ---
echo ""
echo "组装 macOS 应用包…"
APP="$DIST/校园树木地图.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# 同时放进两种芯片版本，用脚本按机器类型选 —— 这样 Intel 和 M 系列都能用
cp "$DIST/tree-macos-arm64" "$APP/Contents/MacOS/tree-arm64"
cp "$DIST/tree-macos-intel" "$APP/Contents/MacOS/tree-intel"
rm -f "$DIST/tree-macos-arm64" "$DIST/tree-macos-intel"

cat > "$APP/Contents/MacOS/start" <<'LAUNCH'
#!/bin/sh
# 双击 .app 时由系统调用这里
DIR=$(cd "$(dirname "$0")" && pwd)
if [ "$(uname -m)" = "arm64" ]; then
  exec "$DIR/tree-arm64"
else
  exec "$DIR/tree-intel"
fi
LAUNCH
chmod +x "$APP/Contents/MacOS/start"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>校园树木地图</string>
  <key>CFBundleDisplayName</key>
  <string>校园树木地图</string>
  <key>CFBundleIdentifier</key>
  <string>cn.edu.tjbpi.campustreemap</string>
  <key>CFBundleVersion</key>
  <string>VERSION_PLACEHOLDER</string>
  <key>CFBundleShortVersionString</key>
  <string>VERSION_PLACEHOLDER</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>start</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.15</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST
sed -i '' "s/VERSION_PLACEHOLDER/$VERSION/g" "$APP/Contents/Info.plist" 2>/dev/null || \
  sed -i "s/VERSION_PLACEHOLDER/$VERSION/g" "$APP/Contents/Info.plist"

# 权限设成正常值：固定可执行位，避免带上个人 umask 的痕迹（否则别人拿到可能打不开）
chmod 755 "$APP/Contents/MacOS/start" "$APP/Contents/MacOS/tree-arm64" "$APP/Contents/MacOS/tree-intel"
chmod 644 "$APP/Contents/Info.plist"

# 去掉隔离属性，避免双击时被系统拦住（对本地生成的文件通常已经是干净的）
xattr -cr "$APP" 2>/dev/null || true

# --- 打包成 zip ---
echo ""
echo "打包…"
cd "$DIST"
rm -f 校园树木地图-macOS.zip 校园树木地图-Windows.zip
zip -qr 校园树木地图-macOS.zip 校园树木地图.app
mkdir -p win-tmp
cp tree-windows.exe "win-tmp/校园树木地图.exe"
chmod 755 "win-tmp/校园树木地图.exe"
cat > "win-tmp/先看我.txt" <<'TXT'
校园树木地图 —— 使用说明

【怎么打开】
双击「校园树木地图.exe」。
会自动弹出浏览器打开地图，不用装任何软件。

【如果 Windows 提示"已保护你的电脑"】
这是 Windows 对没有购买数字签名的程序的默认提示，不是病毒。
点「更多信息」→「仍要运行」即可。只需设置一次。

【怎么让学生用手机记录】
1. 电脑和手机连同一个 WiFi
2. 双击打开后，网页底部会显示一个「发给学生的地址」
3. 把这个地址发到班级群，学生手机浏览器打开就能记录
4. 学生记的内容会实时出现在你的电脑上

【数据在哪】
在「文档\CampusTreeMap」文件夹里。
想备份就整个复制走；想重新开始就删掉它。

【怎么关闭】
关掉那个黑色的命令行窗口即可。
TXT
zip -qr 校园树木地图-Windows.zip win-tmp
rm -rf win-tmp tree-windows.exe

echo ""
echo "完成！产物在 dist/ 目录："
ls -lh 校园树木地图-*.zip | awk '{printf "  %-34s %s\n", $9, $5}'
echo ""
echo "  macOS 版：解压后双击「校园树木地图.app」"
echo "  Windows 版：解压后双击「校园树木地图.exe」"
echo ""
echo "  首次打开如果被系统拦截，看压缩包里的说明。"

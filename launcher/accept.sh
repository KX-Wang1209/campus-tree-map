#!/bin/sh
# 验收脚本：模拟用户拿到成品后的完整流程
#
# 注意：全程不用 set -e。lsof / pkill / curl 在"没找到"时返回非零，
# 用 set -e 会误伤，脚本会莫名其妙中断。

ZIP="/Users/wangkaixuan/Documents/老妈&小芃材料/数字滨海学院/dist/校园树木地图-macOS.zip"
WORK=/tmp/accept

echo "=== 0. 先清理上次残留 ==="
pkill -f tree-arm64 >/dev/null 2>&1
pkill -f tree-intel >/dev/null 2>&1
sleep 2
rm -rf "$HOME/Documents/CampusTreeMap"
echo "  已清理进程和数据目录"

echo ""
echo "=== 1. 解压（模拟用户拿到压缩包）==="
rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK" || exit 1
unzip -q "$ZIP"
echo "  $WORK 内容：$(ls)"

echo ""
echo "=== 2. app 结构 ==="
APP="$WORK/校园树木地图.app"
ls -l "$APP/Contents/MacOS/" | tail -3
printf "  应用名：%s\n" "$(plutil -extract CFBundleName raw "$APP/Contents/Info.plist" 2>/dev/null)"

echo ""
echo "=== 3. 启动（等同双击）==="
open "$APP" >/dev/null 2>&1
echo "  已发出启动命令"

# 记下启动前已占用的端口，只认新出现的那个
BEFORE=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep tree- | awk '{print $9}' | tr '\n' ' ')

PORT=""
i=0
while [ $i -lt 20 ]; do
  sleep 1
  NOW=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep tree- | awk '{print $9}' | tr '\n' ' ')
  if [ -n "$NOW" ] && [ "$NOW" != "$BEFORE" ]; then
    PORT=$(echo "$NOW" | tr ' ' '\n' | grep -v '^$' | head -1 | sed 's/.*://')
    break
  fi
  i=$((i + 1))
done

if [ -z "$PORT" ]; then
  echo "  服务未就绪，尝试用已有实例的端口"
  PORT=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep tree- | head -1 | sed 's/.*://' | awk '{print $1}')
fi

if [ -z "$PORT" ]; then
  echo "  启动失败：没有进程在监听"
  exit 1
fi
echo "  服务端口：$PORT"

echo ""
echo "=== 4. 接口 ==="
printf "  /api/info    "; curl -s "http://127.0.0.1:$PORT/api/info"; echo ""
printf "  /api/status  "; curl -s "http://127.0.0.1:$PORT/api/status"; echo ""

echo ""
echo "=== 5. 静态资源（全部应为 200）==="
FAIL=0
for p in / /app.js /view3d.js /app.css /campus.json /species.json /bounds.json \
         /tiles/18/216732_100123.jpg /vendor/leaflet.js /vendor/maplibre-gl.js /vendor/maplibre-gl.css; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$p")
  [ "$code" = "200" ] || FAIL=$((FAIL + 1))
  printf "  %-34s %s\n" "$p" "$code"
done
printf "  异常项：%s\n" "$FAIL"

echo ""
echo "=== 6. 提交一条记录（模拟学生记录）==="
curl -s -X POST "http://127.0.0.1:$PORT/api/trees" \
  -H "Content-Type: application/json" \
  -d '{"tree":{"id":"accept-1","lat":39.0685,"lon":117.6365,"species":"yinxing","count":3,"note":"验收测试","recorder":"验收","photos":[],"health":"良好","created":1780000000000}}' \
  | head -c 200
echo ""
printf "  快照："; curl -s "http://127.0.0.1:$PORT/api/snapshot" | head -c 200; echo ""
printf "  落盘："; ls -la "$HOME/Documents/CampusTreeMap/trees.json" 2>/dev/null | awk '{print $5 " 字节"}' || echo "未找到"

echo ""
echo "=== 7. 坐标越界应被拒（防错）==="
curl -s -X POST "http://127.0.0.1:$PORT/api/trees" \
  -H "Content-Type: application/json" \
  -d '{"tree":{"id":"bad-1","lat":40.5,"lon":118.0,"species":"yinxing","photos":[]}}'
echo ""

echo ""
echo "=== 8. 删除测试记录 ==="
curl -s -X DELETE "http://127.0.0.1:$PORT/api/trees/accept-1"; echo ""
printf "  删除后："; curl -s "http://127.0.0.1:$PORT/api/status"; echo ""

echo ""
echo "=== 完成 ==="
echo "服务仍在运行（端口 $PORT），可打开浏览器查看：http://127.0.0.1:$PORT/"

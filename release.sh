#!/bin/sh
# 发一个新版本：提交改动、打标签、推送、自动建 GitHub Release
#
# 用法：
#   sh release.sh v1.1 "加了新功能"
#   sh release.sh v1.2 ""              # 说明留空也行
#
# 做的事：
#   1. 检查有没有未提交的改动，有就自动提交
#   2. 打一个带说明的标签
#   3. 推送到 GitHub
#   4. 在本机生成好打包成品（可选，会问）
#
# 注意：Release 的说明文字会自动从本次提交记录生成，
# 所以提交信息写清楚一点，Release 页面就好看。

set -e
cd "$(dirname "$0")"

# --- 读参数 ---
TAG="$1"
NOTE="$2"

if [ -z "$TAG" ]; then
  echo "用法：sh release.sh <版本号> [说明]"
  echo "例如：sh release.sh v1.1 \"修复了三维视图的显示问题\""
  echo ""
  echo "现有标签："
  git tag -l | sed 's/^/  /'
  exit 1
fi

# 版本号格式检查（v 开头 + 数字）
case "$TAG" in
  v[0-9]*) ;;
  *)
    echo "版本号要以 v 开头，比如 v1.1、v2.0"
    exit 1
    ;;
esac

# 标签不能重复
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "标签 $TAG 已经存在了。"
  echo "现有标签："
  git tag -l | sed 's/^/  /'
  exit 1
fi

echo "============================================"
echo "  发布 $TAG"
echo "============================================"
echo ""

# --- 检查仓库状态 ---
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ]; then
  echo "当前在 $BRANCH 分支，不是 main。先切回 main 再发版。"
  exit 1
fi

# --- 有改动就提交 ---
if [ -n "$(git status --porcelain)" ]; then
  echo "检测到未提交的改动："
  git status --short | sed 's/^/  /'
  echo ""
  printf "  提交说明（直接回车用默认）："
  read -r MSG
  [ -z "$MSG" ] && MSG="$TAG"
  git add -A
  git commit -q -m "$MSG"
  echo "  已提交：$MSG"
else
  echo "没有未提交的改动。"
fi
echo ""

# --- 生成 Release 说明 ---
# 从上一个标签到现在的提交记录里汇总
# 注意：不能用 HEAD^ 找上一个标签 —— 那样在"打完标签后又有新提交"时会找错，
# 导致把上一个版本的提交也算进来。应该找"当前 HEAD 之前最近的那个标签"。
PREV=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
# 如果找到的标签就是本次要打的，说明还没提交新内容，往前再找一个
if [ "$PREV" = "$TAG" ]; then
  PREV=$(git describe --tags --abbrev=0 "$TAG^" 2>/dev/null || echo "")
fi

if [ -n "$PREV" ]; then
  echo "本次改动（自 $PREV 以来）："
  CHANGES=$(git log --pretty=format:"- %s" "$PREV..HEAD")
else
  echo "首次发布，汇总全部提交："
  CHANGES=$(git log --pretty=format:"- %s" | head -20)
fi

if [ -z "$CHANGES" ]; then
  CHANGES="- 常规更新"
fi
echo "$CHANGES" | sed 's/^/  /'
echo ""

# 组装 Release 正文
BODY="$CHANGES

---

**完整改动记录**：https://github.com/KX-Wang1209/campus-tree-map/compare/${PREV:-main}...${TAG}"

if [ -n "$NOTE" ]; then
  BODY="$NOTE

$BODY"
fi

# --- 打标签 ---
git tag -a "$TAG" -m "$TAG

$BODY"
echo "已打标签：$TAG"
echo ""

# --- 推送 ---
printf "  推送到 GitHub？(Y/n)："
read -r GO
case "$GO" in
  [Nn]*) echo "  已取消推送。标签还留在本地。"; exit 0 ;;
esac

echo ""
echo "推送代码…"
git push -q origin main
echo "推送标签…"
git push -q origin "$TAG"
echo "  完成"
echo ""

# --- 提示建 Release ---
echo "============================================"
echo "  代码和标签已上传"
echo "============================================"
echo ""
echo "接下来在 GitHub 上建 Release（这样别人能直接看到更新说明）："
echo ""
echo "  打开这个链接，标题和正文已经填好一半："
echo "  https://github.com/KX-Wang1209/campus-tree-map/releases/new?tag=$TAG"
echo ""
echo "  如果想让标签直接带 Release，也可以在命令行用 gh（装了的话）："
echo "    gh release create $TAG --title \"$TAG\" --notes \"$CHANGES\""
echo ""

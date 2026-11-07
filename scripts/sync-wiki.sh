#!/usr/bin/env bash
# 将本仓库 wiki/ 目录同步到 GitHub Wiki(需要 Wiki 已在网页上初始化过一次)。
# 用法: scripts/sync-wiki.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_WIKI_URL="https://github.com/oMrCat/api-workbench.wiki.git"
STAGE="$(mktemp -d)/api-workbench.wiki"
git clone "$REPO_WIKI_URL" "$STAGE" 2>/dev/null || {
  echo "❌ Wiki 仓库尚不存在。请在网页上打开 https://github.com/oMrCat/api-workbench/wiki 并点击创建第一个页面,然后重跑本脚本。"
  exit 1
}
cp -R wiki/. "$STAGE"/
cd "$STAGE"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git -c user.name="API Workbench Dev" -c user.email="dev@api-workbench.local" commit -m "sync wiki pages from repository"
  git push origin master 2>/dev/null || git push origin main
  echo "✅ Wiki 已同步"
else
  echo "Wiki 已是最新"
fi

#!/usr/bin/env bash
# 一键启动 FeedGen：先起 Postgres/Redis，再启前后端
# Usage: ./start.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

INFRA_SCRIPT="${FEEDGEN_INFRA_SCRIPT:-/Volumes/SSD4T/dev/feedgen/start-infra.sh}"

if ! command -v feedgen >/dev/null 2>&1; then
  echo "错误: 未找到 feedgen CLI，请先安装或将其加入 PATH。"
  exit 1
fi

echo ">>> 启动 Postgres / Redis..."
if [[ -x "$INFRA_SCRIPT" ]]; then
  "$INFRA_SCRIPT"
else
  echo "错误: 未找到基础设施脚本: $INFRA_SCRIPT"
  echo "可通过 FEEDGEN_INFRA_SCRIPT 指定路径。"
  exit 1
fi

# 等待就绪（pg_ctl/redis-server 刚拉起时可能尚不可用）
for i in {1..30}; do
  if pg_isready -h 127.0.0.1 -q 2>/dev/null \
    && redis-cli ping 2>/dev/null | grep -q PONG; then
    break
  fi
  if [[ "$i" -eq 30 ]]; then
    echo "错误: Postgres 或 Redis 在超时内未就绪。"
    exit 1
  fi
  sleep 0.5
done

echo
echo ">>> 启动前后端服务..."
feedgen start

echo
feedgen status
echo "前端: http://127.0.0.1:3001"
echo "后端: http://127.0.0.1:3000/api"

#!/usr/bin/env bash
# 一键启动 FeedGen：Postgres → Redis → 前后端
# Usage: ./start.sh

set -euo pipefail

# 支持直接执行、bash start.sh，以及 launchd 经 node 管道 bash -s
if [[ -n "${FEEDGEN_ROOT:-}" && -d "${FEEDGEN_ROOT}" ]]; then
  ROOT="$FEEDGEN_ROOT"
elif [[ -n "${BASH_SOURCE[0]:-}" && "${BASH_SOURCE[0]}" != "bash" && "${BASH_SOURCE[0]}" != "-bash" ]]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  ROOT="/Volumes/SSD4T/pro/feedgen"
fi
cd "$ROOT"
FEEDGEN_ROOT="$ROOT"

export PATH="/Volumes/SSD4T/dev/bin:/Volumes/SSD4T/dev/homebrew/bin:/Volumes/SSD4T/dev/homebrew/opt/postgresql@16/bin:/Volumes/SSD4T/dev/redis/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

FEEDGEN_BIN="$ROOT/scripts/feedgen"
if command -v feedgen >/dev/null 2>&1; then
  FEEDGEN_BIN="$(command -v feedgen)"
elif [[ ! -x "$FEEDGEN_BIN" ]]; then
  echo "错误: 未找到 feedgen CLI（期望 $ROOT/scripts/feedgen）" >&2
  exit 1
fi

PGDATA="${PGDATA:-/Volumes/SSD4T/dev/homebrew/var/postgresql@16}"
PG_CTL="${PG_CTL:-/Volumes/SSD4T/dev/homebrew/opt/postgresql@16/bin/pg_ctl}"
PG_LOG="${PG_LOG:-/Volumes/SSD4T/dev/homebrew/var/log/postgresql@16.log}"
REDIS_CONF="${REDIS_CONF:-/Volumes/SSD4T/dev/redis/redis.conf}"
REDIS_SERVER="${REDIS_SERVER:-$(command -v redis-server 2>/dev/null || echo /Volumes/SSD4T/dev/redis/bin/redis-server)}"
REDIS_CLI="${REDIS_CLI:-$(command -v redis-cli 2>/dev/null || echo /Volumes/SSD4T/dev/redis/bin/redis-cli)}"

start_infra() {
  local infra_script="${FEEDGEN_INFRA_SCRIPT:-/Volumes/SSD4T/dev/feedgen/start-infra.sh}"
  if [[ -x "$infra_script" ]]; then
    echo ">>> 启动 Postgres / Redis: $infra_script"
    "$infra_script"
    return
  fi

  echo ">>> 启动 Postgres / Redis (内置逻辑)"
  mkdir -p "$(dirname "$PG_LOG")" /Volumes/SSD4T/dev/redis

  if ! pg_isready -h 127.0.0.1 -q 2>/dev/null; then
    if [[ ! -x "$PG_CTL" ]]; then
      echo "错误: 未找到 pg_ctl: $PG_CTL" >&2
      exit 1
    fi
    "$PG_CTL" -D "$PGDATA" -l "$PG_LOG" start
  else
    echo "PostgreSQL 已在运行"
  fi

  if ! "$REDIS_CLI" ping 2>/dev/null | grep -q PONG; then
    if [[ ! -x "$REDIS_SERVER" ]]; then
      echo "错误: 未找到 redis-server: $REDIS_SERVER" >&2
      exit 1
    fi
    if [[ -f "$REDIS_CONF" ]]; then
      "$REDIS_SERVER" "$REDIS_CONF"
    else
      mkdir -p /Volumes/SSD4T/dev/redis/data /Volumes/SSD4T/dev/redis/logs
      "$REDIS_SERVER" --port 6379 --bind 127.0.0.1 --dir /Volumes/SSD4T/dev/redis/data \
        --daemonize yes --logfile /Volumes/SSD4T/dev/redis/logs/redis.log
    fi
  else
    echo "Redis 已在运行"
  fi
}

start_infra

echo ">>> 等待 Postgres / Redis 就绪..."
for i in $(seq 1 60); do
  if pg_isready -h 127.0.0.1 -q 2>/dev/null \
    && "$REDIS_CLI" ping 2>/dev/null | grep -q PONG; then
    echo "基础设施就绪"
    break
  fi
  if [[ "$i" -eq 60 ]]; then
    echo "错误: Postgres 或 Redis 在超时内未就绪。" >&2
    pg_isready -h 127.0.0.1 2>&1 || true
    "$REDIS_CLI" ping 2>&1 || true
    exit 1
  fi
  sleep 0.5
done

echo
echo ">>> 启动前后端服务..."
"$FEEDGEN_BIN" start

echo
"$FEEDGEN_BIN" status
echo "前端: http://127.0.0.1:3001"
echo "后端: http://127.0.0.1:3000/api"

#!/usr/bin/env bash
# macOS 登录自启入口：等待外置盘挂载后执行 start.sh
# 由 LaunchAgent com.feedgen.app 调用（经 /bin/bash -c 等待后 exec）

set -euo pipefail

ROOT="/Volumes/SSD4T/pro/feedgen"
LOG_DIR="${HOME}/Library/Logs/feedgen"
mkdir -p "$LOG_DIR"
exec >>"$LOG_DIR/autostart.log" 2>&1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] feedgen autostart begin"

# 外置盘可能比登录会话晚挂载
for i in $(seq 1 150); do
  if [[ -x "$ROOT/start.sh" ]]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] volume ready after ${i} check(s)"
    break
  fi
  sleep 2
done

if [[ ! -x "$ROOT/start.sh" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $ROOT/start.sh 不可用（外置盘未挂载？）"
  exit 1
fi

# 再稍等磁盘完全就绪，避免竞态
sleep 2
exec "$ROOT/start.sh"

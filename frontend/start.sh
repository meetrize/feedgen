#!/bin/bash

# FeedGen 前端启动脚本

echo "启动 FeedGen 前端应用..."

# 若 3001 已被占用（常见为上次未退出的 http-server），先释放端口
if lsof -ti:3001 >/dev/null 2>&1; then
  echo "检测到端口 3001 已被占用，正在结束占用进程..."
  lsof -ti:3001 | xargs kill -9 2>/dev/null
  sleep 1
fi

# 检查后端是否运行
if ! curl -s http://localhost:3000/ > /dev/null; then
    echo "警告: 后端服务未运行。请确保后端服务已在端口3000启动。"
    echo "启动后端服务: cd ../backend && npm run dev"
fi

# 启动前端服务器（禁用缓存，避免前端改动不生效）
cd "$(dirname "$0")"
npx http-server -p 3001 -c-1

echo "前端应用已启动在 http://localhost:3001"
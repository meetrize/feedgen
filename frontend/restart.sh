#!/bin/bash

# 停止当前运行在3001端口的前端服务器
echo "正在停止当前运行的前端服务器..."
lsof -ti:3001 | xargs kill -9 2>/dev/null || echo "端口3001上没有进程运行"

# 等待片刻确保端口已释放
sleep 2

# 启动新的前端服务器（禁用缓存，避免前端改动不生效）
echo "正在启动前端服务器..."
cd "$(dirname "$0")"  # 切换到脚本所在目录（frontend目录）
npx http-server -p 3001 -c-1 &

echo "前端服务器已在端口3001上启动"
echo "访问地址: http://localhost:3001"
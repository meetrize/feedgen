#!/bin/bash

# FeedGen Backend Restart Script
# 用于重启后端服务

echo "🔄 正在重启 FeedGen 后端服务..."

# 获取当前脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 进入 backend 目录
cd "$SCRIPT_DIR"

echo "📍 当前目录: $(pwd)"

# 停止现有的后端进程
echo "🛑 正在停止现有的后端进程..."
pkill -f "npm run dev" || true
pkill -f "ts-node src/index.ts" || true
pkill -f "node dist/index.js" || true

# 等待一段时间确保进程完全停止
sleep 3

# 检查端口是否被占用，如果是则杀死占用进程
PORT=3000
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
    echo "🔒 端口 $PORT 被占用，正在释放..."
    lsof -ti:$PORT | xargs kill -9 2>/dev/null || true
fi

# 启动后端服务
echo "🚀 正在启动后端服务..."
npm run dev &

# 等待服务启动
echo "⏳ 等待服务启动..."
sleep 5

# 检查服务是否成功启动
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
    echo "✅ 后端服务已在端口 $PORT 上成功启动"
    echo "🌐 访问地址: http://localhost:$PORT"
else
    echo "❌ 服务启动失败，请检查错误日志"
    exit 1
fi

echo "🎉 后端服务重启完成！"
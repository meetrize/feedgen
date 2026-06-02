#!/bin/bash

# FeedGen 后端服务启动脚本

echo "==================================="
echo "FeedGen 后端服务启动脚本"
echo "==================================="

# 检查 Node.js 是否已安装
if ! command -v node &> /dev/null; then
    echo "❌ 错误: Node.js 未安装"
    echo "请先安装 Node.js 18+ 版本"
    exit 1
fi

# 检查 npm 是否已安装
if ! command -v npm &> /dev/null; then
    echo "❌ 错误: npm 未安装"
    echo "请先安装 Node.js 18+ 版本（包含 npm）"
    exit 1
fi

echo "✅ Node.js 版本: $(node --version)"
echo "✅ npm 版本: $(npm --version)"

# 检查是否在 backend 目录中
if [ ! -f "package.json" ]; then
    echo "❌ 错误: 未在 backend 目录中"
    echo "请切换到 backend 目录后再运行此脚本"
    exit 1
fi

# 检查 .env 文件是否存在
if [ ! -f ".env" ] && [ ! -f ".env.local" ]; then
    echo "⚠️  警告: 未找到 .env 或 .env.local 文件"
    echo "请先创建环境配置文件"
    echo ""
    echo "快速创建示例配置:"
    echo "cp .env.example .env  # 如果存在 .env.example"
    echo "或"
    echo "cp .env .env.local   # 如果存在 .env"
    echo ""
    echo "然后编辑文件配置数据库连接等参数"
    exit 1
fi

echo "✅ 找到环境配置文件"

# 检查依赖是否已安装
if [ ! -d "node_modules" ]; then
    echo "📦 未检测到 node_modules，正在安装依赖..."
    npm install
    if [ $? -ne 0 ]; then
        echo "❌ 依赖安装失败"
        exit 1
    fi
    echo "✅ 依赖安装完成"
else
    echo "✅ 依赖已安装"
fi

# 检查 PostgreSQL 是否正在运行
echo "🔍 检查 PostgreSQL 服务..."
if lsof -Pi :5432 -sTCP:LISTEN -t >/dev/null ; then
    echo "✅ PostgreSQL 正在运行 (端口 5432)"
else
    echo "⚠️  PostgreSQL 未运行或不在默认端口"
    echo "请确保 PostgreSQL 服务已启动"
    echo "macOS (使用 Homebrew): brew services start postgresql"
    echo "Ubuntu: sudo systemctl start postgresql"
fi

# 检查 Redis 是否正在运行
echo "🔍 检查 Redis 服务..."
if lsof -Pi :6379 -sTCP:LISTEN -t >/dev/null ; then
    echo "✅ Redis 正在运行 (端口 6379)"
else
    echo "⚠️  Redis 未运行或不在默认端口"
    echo "请确保 Redis 服务已启动"
    echo "macOS (使用 Homebrew): brew services start redis"
    echo "Ubuntu: sudo systemctl start redis-server"
fi

echo ""
echo "选择启动模式:"
echo "1) 开发模式 (npm run dev) - 带热重载"
echo "2) 生产模式 (npm start) - 需要先构建"
echo "3) 仅构建项目 (npm run build)"
echo "4) 运行数据库迁移 (npm run db:migrate)"
echo ""

read -p "请输入选项 (1-4): " choice

case $choice in
    1)
        echo "🚀 启动开发模式..."
        echo "注意: 服务将在 http://localhost:3000 运行"
        echo "按 Ctrl+C 停止服务"
        npm run dev
        ;;
    2)
        echo "🚀 启动生产模式..."
        echo "注意: 需要先运行构建命令"
        echo "如果尚未构建，请先运行: npm run build"
        npm start
        ;;
    3)
        echo "🔨 构建项目..."
        npm run build
        ;;
    4)
        echo "🔄 运行数据库迁移..."
        npm run db:migrate
        ;;
    *)
        echo "❌ 无效选项"
        exit 1
        ;;
esac

echo ""
echo "==================================="
echo "感谢使用 FeedGen!"
echo "==================================="
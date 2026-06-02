# FeedGen 后端服务 - 快速开始

## 🚀 快速启动指南

### 1. 环境准备

确保您的系统已安装以下软件：

- **Node.js** 18.x 或更高版本
- **PostgreSQL** 14.x 或更高版本
- **Redis** 7.x 或更高版本

检查安装：
```bash
node --version
npm --version
psql --version  # 如果已安装
redis-cli --version  # 如果已安装
```

### 2. 克隆并进入项目目录

```bash
cd backend
```

### 3. 安装依赖

```bash
npm install
```

### 4. 配置环境变量

复制环境变量文件：
```bash
cp .env .env.local
```

编辑 `.env.local` 文件，配置数据库连接：
```env
DATABASE_URL="postgresql://uranpgsql:guestR56Y@117.72.44.160:5432/uranpgsql?schema=public"
JWT_SECRET="your-super-secret-jwt-key-here-change-in-production"
REDIS_URL="redis://localhost:6379"
PORT=3000
```

### 5. 启动数据库服务

**PostgreSQL:**
```bash
# macOS (使用 Homebrew)
brew services start postgresql

# Ubuntu
sudo systemctl start postgresql
```

**Redis:**
```bash
# macOS (使用 Homebrew)
brew services start redis

# Ubuntu
sudo systemctl start redis-server
```

### 6. 创建数据库并运行迁移

```bash
# 创建数据库（首次运行）
npx prisma db push

# 或运行迁移
npx prisma migrate dev
```

### 7. 启动服务

**开发模式:**
```bash
npm run dev
```

**生产模式:**
```bash
npm run build
npm start
```

---

## 🛠️ 使用启动脚本（推荐）

我们提供了一个便捷的启动脚本，可以自动检查环境并启动服务：

```bash
cd backend
./start.sh
```

该脚本会：
- 检查 Node.js 和 npm 是否已安装
- 检查依赖是否已安装
- 检查 PostgreSQL 和 Redis 服务状态
- 提供交互式菜单选择启动模式

---

## 🔧 常见问题解决

### 数据库连接错误
如果遇到 "Can't reach database server" 错误：
1. 确认 PostgreSQL 服务正在运行
2. 检查 `.env.local` 文件中的数据库连接字符串是否正确
3. 确认数据库用户和密码是否正确

### Redis 连接错误
确认 Redis 服务正在运行：
```bash
redis-cli ping
# 应该返回 "PONG"
```

### 端口被占用
如果端口 3000 被占用，在 `.env.local` 中修改端口：
```env
PORT=3001
```

---

## 📞 服务验证

服务启动后，访问以下地址验证：

- **健康检查**: http://localhost:3000/
- **API 文档**: 查看 `API_DOCUMENTATION.md` 文件

---

## 📋 启动流程概览

1. **环境检查** → 确保 Node.js、PostgreSQL、Redis 已安装
2. **依赖安装** → `npm install`
3. **环境配置** → 配置 `.env.local`
4. **数据库设置** → 启动 PostgreSQL，运行迁移
5. **Redis 设置** → 启动 Redis 服务
6. **启动应用** → `npm run dev` 或 `npm start`

---

## ⚡ 一键启动命令

```bash
# 开发模式
npm run dev

# 生产模式
npm run build && npm start
```

服务启动后，您将看到类似以下的输出：
```
Server listening on port 3000
Starting crawler worker...
Crawler worker started
Starting scheduler...
Scheduler started
All services started successfully
```

此时服务已准备好接受请求！
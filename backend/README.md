# FeedGen Backend

基于 Fastify 和 TypeScript 构建的 Feed 转换服务后端。

## 技术栈

- **运行时**: Node.js 18+ / TypeScript
- **框架**: Fastify
- **数据库**: PostgreSQL + Prisma
- **认证**: JWT
- **队列**: Bull (基于 Redis)
- **爬虫引擎**: Puppeteer/Playwright + Cheerio

## 项目结构

```
backend/
├── src/
│   ├── models/          # Prisma模型
│   ├── routes/          # API路由
│   │   ├── auth.ts      # 认证相关
│   │   ├── feed.ts      # Feed管理
│   │   └── billing.ts   # 计费相关
│   ├── middleware/      # 中间件
│   ├── services/        # 业务逻辑
│   ├── workers/         # 队列处理器
│   └── utils/          # 工具函数
├── prisma/             # 数据库模式
├── migrations/         # 数据库迁移
└── tests/             # 测试文件
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env` 文件并填入正确的配置：

```bash
cp .env .env.local
# 编辑 .env.local 文件
```

### 3. 数据库设置

```bash
# 生成 Prisma 客户端
npm run db:generate

# 运行数据库迁移
npm run db:migrate
```

### 4. 启动开发服务器

```bash
npm run dev
```

服务器将在 `http://localhost:3000` 上运行。

## API 端点

### 认证
- `POST /api/auth/register` - 用户注册
- `POST /api/auth/login` - 用户登录
- `GET /api/auth/me` - 获取当前用户信息

### Feed 管理
- `GET /api/feeds` - 获取用户的所有 Feeds
- `POST /api/feeds` - 创建新 Feed
- `PUT /api/feeds/:id` - 更新 Feed
- `DELETE /api/feeds/:id` - 删除 Feed
- `GET /api/feeds/:id` - 获取单个 Feed 详情
- `GET /api/feeds/:id/preview` - 预览 Feed

### 计费
- `GET /api/billing/usage` - 获取使用情况
- `GET /api/billing/records` - 获取账单记录
- `GET /api/billing/current-cycle` - 获取当前账单周期

## 环境变量

- `DATABASE_URL` - PostgreSQL 数据库连接字符串
- `JWT_SECRET` - JWT 签名密钥
- `REDIS_URL` - Redis 连接字符串
- `MAX_CONCURRENT_CRAWLERS` - 并发爬虫数量限制
- `CRAWLER_TIMEOUT` - 爬虫超时时间（毫秒）
- `PORT` - 服务器端口

## 开发指南

### 添加新路由

1. 在 `src/routes/` 目录下创建新路由文件
2. 使用 Fastify 插件模式导出路由
3. 在 `src/server.ts` 中注册新路由

### 数据库模型变更

1. 修改 `prisma/schema.prisma` 文件
2. 本地开发生成迁移：运行 `npm run db:migrate:dev`（`migrate dev`）
3. 将迁移应用到数据库：运行 `npm run db:migrate`（`migrate deploy`，适合服务器/已有库）
4. 运行 `npm run db:generate` 更新 Prisma 客户端

### 认证保护

所有需要认证的路由应使用 `preValidation: fastify.authenticate` 选项。
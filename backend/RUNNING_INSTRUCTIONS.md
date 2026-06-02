# 运行说明

## 环境要求

- Node.js 18+
- PostgreSQL 14+
- Redis 7+

## 安装依赖

```bash
cd backend
npm install
```

## 环境配置

复制环境变量文件：

```bash
cp .env .env.local
```

编辑 `.env.local` 文件，配置数据库连接和其他参数：

```env
# 数据库连接
DATABASE_URL="postgresql://username:password@localhost:5432/feedgen?schema=public"

# JWT 密钥
JWT_SECRET="your-super-secret-jwt-key-here-change-in-production"

# Redis 连接
REDIS_URL="redis://localhost:6379"

# 端口
PORT=3000
```

## 数据库设置

### 1. 安装PostgreSQL
如果您还没有安装PostgreSQL，请按以下步骤操作：

**macOS (使用Homebrew):**
```bash
brew install postgresql
brew services start postgresql
```

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

**Windows:**
下载并安装 PostgreSQL from https://www.postgresql.org/download/windows/

### 2. 创建数据库
```bash
# 连接到PostgreSQL (可能需要使用您的系统用户名)
psql postgres

# 在psql提示符下执行以下命令:
CREATE DATABASE feedgen;
CREATE USER feedgen_user WITH ENCRYPTED PASSWORD 'feedgen_pass';
GRANT ALL PRIVILEGES ON DATABASE feedgen TO feedgen_user;
\q
```

### 3. 更新环境变量
在 `.env.local` 文件中更新数据库连接字符串：
```env
DATABASE_URL="postgresql://uranpgsql:guestR56Y@117.72.44.160:5432/uranpgsql?schema=public"
```

### 4. 运行数据库迁移
```bash
cd backend
npx prisma migrate dev --name init
```

或者使用预设的npm脚本：
```bash
npm run db:migrate
```

## Redis 设置

### 1. 安装Redis
**macOS (使用Homebrew):**
```bash
brew install redis
brew services start redis
```

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install redis-server
sudo systemctl start redis-server
sudo systemctl enable redis-server
```

**Windows:**
Redis官方不支持Windows，但您可以使用WSL或从GitHub下载非官方版本。

## 完整启动流程

1. **安装依赖**:
```bash
cd backend
npm install
```

2. **设置数据库** (如果尚未设置):
```bash
# 运行数据库迁移
npm run db:migrate

# 或者直接推送数据库模式（开发环境）
npm run db:push
```

3. **构建项目** (可选，开发模式不需要):
```bash
npm run build
```

4. **启动服务**:
```bash
# 开发模式（带热重载）
npm run dev

# 或生产模式（需要先构建）
npm start
```

## Docker 方式运行（可选）

如果您更喜欢使用Docker，可以使用以下命令：

```bash
# 启动数据库和应用
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

创建 `docker-compose.yml` 文件：
```yaml
version: '3.8'
services:
  postgres:
    image: postgres:13
    container_name: feedgen_postgres
    environment:
      POSTGRES_DB: feedgen
      POSTGRES_USER: feedgen_user
      POSTGRES_PASSWORD: feedgen_pass
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    container_name: feedgen_redis
    ports:
      - "6379:6379"

  app:
    build: .
    container_name: feedgen_app
    depends_on:
      - postgres
      - redis
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: "postgresql://feedgen_user:feedgen_pass@postgres:5432/feedgen"
      REDIS_URL: "redis://redis:6379"
      JWT_SECRET: "your-super-secret-jwt-key-here-change-in-production"
    volumes:
      - .:/app
      - /app/node_modules

volumes:
  postgres_data:
```

## 故障排除

### 数据库连接错误
如果遇到 "Can't reach database server" 错误：
1. 确认 PostgreSQL 服务正在运行
2. 检查 `.env.local` 文件中的数据库连接字符串是否正确
3. 确认数据库名称、用户名和密码是否正确
4. 确认 PostgreSQL 是否在默认端口 5432 上运行

### Redis 连接错误
如果遇到 Redis 连接错误：
1. 确认 Redis 服务正在运行
2. 检查 `.env.local` 文件中的 Redis 连接字符串是否正确

### 端口冲突
如果端口3000已被占用，可以在 `.env.local` 中设置不同端口：
```env
PORT=3001
```

## 服务启动说明

当您运行 `npm run dev` 时，应用程序会启动以下服务：

1. **HTTP 服务器**：监听在指定端口（默认3000），处理API请求
2. **爬虫工作进程**：处理队列中的爬虫任务
3. **调度器**：定期检查需要更新的Feeds并安排爬取任务

## API 测试

服务器启动后，可以通过以下方式测试API：

```bash
# 检查服务器是否运行
curl http://localhost:3000/

# 查看API文档
cat API_DOCUMENTATION.md
```

## 常见问题

### 1. 数据库连接错误
确保 PostgreSQL 服务正在运行，并且 `.env.local` 文件中的数据库连接字符串正确。

### 2. 权限错误
确保数据库用户有足够的权限创建和修改表。

### 3. 端口占用
如果端口3000已被占用，可以在 `.env.local` 文件中修改 `PORT` 变量。

### 4. 内存不足
爬虫操作可能消耗较多内存，确保系统有足够的可用内存。

### 5. 依赖问题
如果遇到依赖问题，尝试清理缓存并重新安装：
```bash
rm -rf node_modules package-lock.json
npm install
```

## 项目结构

```
backend/
├── dist/                 # 编译后的文件
├── node_modules/         # 依赖包
├── prisma/               # 数据库模式和迁移
├── src/
│   ├── routes/           # API路由
│   ├── services/         # 业务逻辑服务
│   ├── workers/          # 队列处理器
│   ├── middleware/       # 中间件
│   ├── types/            # 类型定义
│   └── server.ts         # 服务器主文件
├── package.json
├── tsconfig.json
├── .env                  # 环境变量
├── README.md
├── API_DOCUMENTATION.md  # API文档
└── RUNNING_INSTRUCTIONS.md # 本文件
```

## 开发说明

- 所有API端点都在 `src/routes/` 目录下定义
- 爬虫逻辑在 `src/services/crawler.ts` 中实现
- 队列处理在 `src/workers/crawlerWorker.ts` 中实现
- 数据库模型在 `prisma/schema.prisma` 中定义
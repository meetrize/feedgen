# Feed 转换服务 - 项目技术规范

## 项目概述

一个将任意网站新闻转换为 RSS/Atom Feed XML 的 SaaS 服务，支持用户注册、订阅管理和按使用量计费。

## 技术栈

### 后端
- **运行时**: Node.js 18+ / TypeScript
- **框架**: Express 或 Fastify
- **爬虫引擎**:
  - Puppeteer/Playwright (动态网站，JavaScript 渲染)
  - Cheerio (静态网站，HTML 解析)
- **Feed 生成**: `feed` npm 包
- **任务队列**: Bull (基于 Redis)
- **认证**: JWT + bcrypt
- **ORM**: Prisma 或 TypeORM

### 前端
- **框架**: Vue 3 + Vite 或 React + Next.js
- **UI 库**: Element Plus / Ant Design / Tailwind CSS
- **状态管理**: Pinia / Zustand
- **功能模块**:
  - 用户注册/登录
  - Feed 订阅管理
  - 爬虫规则配置（可视化选择器）
  - 计费仪表板
  - RSS 预览

### 数据库

#### 主数据库: PostgreSQL 14+
**用途**: 持久化存储
- 用户账户信息
- Feed 订阅配置
- 抓取的文章内容（带 TTL）
- 计费记录

**核心表结构**:
```sql
-- 用户表
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    plan VARCHAR(50) DEFAULT 'free', -- free/basic/pro
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Feed 订阅配置
CREATE TABLE feeds (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    target_url TEXT NOT NULL,
    selector_rules JSONB, -- 存储 CSS 选择器规则
    update_interval INTEGER DEFAULT 3600, -- 秒
    status VARCHAR(20) DEFAULT 'active', -- active/paused/error
    last_fetched_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 文章缓存表
CREATE TABLE articles (
    id SERIAL PRIMARY KEY,
    feed_id INTEGER REFERENCES feeds(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    link TEXT NOT NULL,
    description TEXT,
    content TEXT, -- 可选：完整内容
    pub_date TIMESTAMP,
    cached_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP, -- TTL 过期时间
    UNIQUE(feed_id, link)
);

-- 计费记录
CREATE TABLE billing_records (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    feed_count INTEGER DEFAULT 0,
    request_count INTEGER DEFAULT 0,
    amount DECIMAL(10,2),
    billing_period VARCHAR(20), -- 2024-01
    created_at TIMESTAMP DEFAULT NOW()
);

-- 使用量统计
CREATE TABLE usage_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    feed_id INTEGER REFERENCES feeds(id),
    action VARCHAR(50), -- fetch/generate
    timestamp TIMESTAMP DEFAULT NOW()
);
```

#### 缓存层: Redis 7+
**用途**:
- 文章内容缓存 (TTL: 1-6 小时)
- 任务队列 (Bull Queue)
- API 限流 (Rate Limiting)
- Session 存储

**缓存键设计**:
```
feed:{feed_id}:articles -> List
user:{user_id}:quota -> Hash
rate_limit:{user_id}:{endpoint} -> String (TTL)
```

## 数据存储策略

### 是否存储目标网站内容？**是**

**理由**:
1. **性能**: 避免每次请求都爬取，直接从数据库返回
2. **稳定性**: 目标网站故障时仍可提供服务
3. **友好性**: 减少对目标网站的压力
4. **计费**: 准确记录转换次数和数据量

**存储规则**:
- 设置 TTL (1-6 小时可配置)
- 只存储关键字段: 标题、链接、摘要、发布时间
- 原文内容可选存储 (根据用户套餐)
- 过期后自动重新抓取

## 系统架构

```
┌─────────────┐
│   用户浏览器   │
└──────┬──────┘
       │
┌──────▼──────────────────────┐
│   前端 (Vue/React)           │
│   - 订阅管理                 │
│   - 规则配置                 │
│   - 计费面板                 │
└──────┬──────────────────────┘
       │ REST API / GraphQL
┌──────▼──────────────────────┐
│   后端 API (Node.js)         │
│   - 认证授权                 │
│   - Feed CRUD                │
│   - 计费逻辑                 │
└──┬───┬───────────────────┬──┘
   │   │                   │
   │   │                   │
┌──▼───▼──┐         ┌──────▼──────┐
│ PostgreSQL│         │    Redis    │
│  主数据库  │         │  缓存/队列   │
└──────────┘         └──────┬──────┘
                            │
                     ┌──────▼──────┐
                     │  爬虫 Worker │
                     │  (Bull Queue)│
                     └─────────────┘
```

## 开发顺序建议

### 推荐顺序: **数据库 → 后端 → 前端**

#### 第一阶段: 数据库设计 (1-2 天)
1. 设计并创建 PostgreSQL 表结构
2. 配置 Redis 实例
3. 编写数据库迁移脚本
4. 准备测试数据

**为什么先做数据库？**
- 数据模型是整个系统的基础
- 后端 API 设计依赖数据结构
- 提前发现数据关系问题

#### 第二阶段: 后端开发 (1-2 周)
1. 搭建 Node.js 项目框架
2. 实现用户认证 (注册/登录/JWT)
3. 开发 Feed CRUD API
4. 实现爬虫核心逻辑
5. 集成 Bull 队列
6. 实现 RSS/Atom XML 生成
7. 添加计费逻辑
8. API 文档 (Swagger/OpenAPI)

**核心 API 端点**:
```
POST   /api/auth/register
POST   /api/auth/login
GET    /api/feeds
POST   /api/feeds
PUT    /api/feeds/:id
DELETE /api/feeds/:id
GET    /api/feeds/:id/preview
GET    /api/feeds/:id/rss.xml  (公开访问)
GET    /api/billing/usage
```

#### 第三阶段: 前端开发 (1 周)
1. 搭建前端项目
2. 实现登录/注册页面
3. Feed 管理界面
4. 爬虫规则配置器 (可视化选择器)
5. RSS 预览组件
6. 计费仪表板
7. 对接后端 API

## 核心功能模块

### 1. 爬虫引擎
```javascript
// 示例: 爬虫配置
{
  "url": "https://example.com/news",
  "selectors": {
    "item": ".news-item",
    "title": "h2.title",
    "link": "a.read-more@href",
    "description": ".summary",
    "pubDate": "time@datetime"
  },
  "type": "static" // or "dynamic"
}
```

### 2. Feed 生成
```javascript
const { Feed } = require('feed');

const feed = new Feed({
  title: "转换的 Feed",
  link: "https://yourservice.com/feed/123",
  // ...
});

articles.forEach(article => {
  feed.addItem({
    title: article.title,
    link: article.link,
    description: article.description,
    date: new Date(article.pub_date)
  });
});

return feed.rss2(); // 或 feed.atom1()
```

### 3. 计费规则
```javascript
// 套餐配置
const PLANS = {
  free: { feeds: 3, requests: 1000 },
  basic: { feeds: 10, requests: 10000, price: 9.9 },
  pro: { feeds: 50, requests: 100000, price: 29.9 }
};
```

## 部署建议

- **后端**: Docker + PM2 / Kubernetes
- **数据库**: 托管 PostgreSQL (AWS RDS / DigitalOcean)
- **Redis**: 托管 Redis (AWS ElastiCache / Redis Cloud)
- **前端**: Vercel / Netlify / Cloudflare Pages
- **监控**: Sentry (错误追踪) + Grafana (性能监控)

## 安全考虑

1. **限流**: 防止滥用爬虫
2. **验证码**: 防止机器人注册
3. **HTTPS**: 全站加密
4. **SQL 注入**: 使用 ORM 参数化查询
5. **XSS 防护**: 前端输入验证和转义
6. **爬虫礼仪**: 遵守 robots.txt，设置合理的请求间隔

## 扩展功能

- 自定义 Feed 样式
- Webhook 通知
- 邮件订阅
- 多语言支持
- 移动端 App

---

**文档版本**: 1.0  
**最后更新**: 2026-03-19

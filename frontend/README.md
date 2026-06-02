# FeedGen 前端应用

FeedGen 是一个将网页转换为RSS/Atom订阅的工具。用户无需登录即可使用，系统会自动创建匿名用户。

## 功能特性

- 无需注册登录，自动创建匿名用户
- 简洁直观的用户界面
- 支持输入任意网页URL创建订阅源
- 自动生成RSS订阅链接

## 使用方法

1. 访问前端应用（默认端口3001）
2. 在输入框中输入要转换的网页URL
3. 点击"创建Feed"按钮
4. 系统将自动为匿名用户创建订阅源
5. 复制生成的RSS URL并在RSS阅读器中使用

## 技术架构

- 前端：纯HTML/CSS/JavaScript
- 后端API：Node.js/Fastify
- 数据库：PostgreSQL

## 开发

```bash
# 启动前端（端口3001）
cd frontend
npx http-server -p 3001

# 启动后端（端口3000）
cd backend
npm run dev
```

## API接口

- `POST /api/auth/create-anonymous` - 创建匿名用户
- `POST /api/feeds` - 创建订阅源
- `GET /api/feeds/:id/rss` - 获取RSS输出

## 文件结构

- `index.html` - 主页面
- `styles.css` - 样式文件
- `script.js` - 前端逻辑
- `icons/` - 图标文件夹
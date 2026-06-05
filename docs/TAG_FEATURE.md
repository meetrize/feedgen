# 文章 Tag 功能说明

本文档描述 FeedGen 阅读器中**用户级文章标签（Tag）**的产品边界、数据模型、API 与前端行为，供开发与测试对照。分步实施手册见 [TAG_AI_PROMPTS.md](./TAG_AI_PROMPTS.md)。

**文档版本**：1.0（步骤 0 交付物）  
**路由前缀**：`/api/feed-subscriptions`（注册于 `backend/src/server.ts`）

---

## 1. 目标与边界

### 1.1 目标

- 用户可为**自己 Feed 下的文章**打上主题类标签（如「AI」「待读」），用于整理与筛选阅读列表。
- Tag 与 **Feed 分组（UserFeedGroup）**、**喜欢（UserArticleLike）**、**已读（UserArticleRead）** 相互独立，可组合使用（例如：某 Feed + 某 Tag + 仅未读）。

### 1.2 边界（必须遵守）

| 约束 | 说明 |
|------|------|
| **用户级** | 所有 Tag 数据归属 `user_id`；不同用户同名标签互不影响。 |
| **禁止污染 articles 表** | 不在 `articles` 上增加 tag 字段或 JSONB；关联仅存于 `user_tags`、`user_article_tags`。 |
| **一期不做自动打标** | 不实现 Feed 规则自动打标（可选远期见步骤 11b）；`source` 一期主要为 `manual`。 |
| **文章归属校验** | 仅能操作 `feeds.user_id === 当前用户` 下的文章（与 like/read 一致）。 |
| **单篇标签上限** | 每篇文章最多 **20** 个 Tag（与 API 实现一致）。 |
| **API 位置** | 全部挂在现有 `feed-subscription` 路由模块，前缀 `/api/feed-subscriptions`，复用 `requireUserId` 与 JWT。 |

### 1.3 非目标（一期）

- Admin 改 Tag（步骤 10 仅可选只读展示）。
- 多标签 AND/OR 筛选（步骤 11a 可选）。
- Crawler / 入库流水线自动打标（步骤 11b 可选）。

---

## 2. 数据模型

### 2.1 表：`user_tags`（Prisma：`UserTag`）

用户 Tag **词汇表**：每个用户维护自己的标签定义。

| 字段 | 类型 | 含义 |
|------|------|------|
| `id` | SERIAL PK | 标签 ID |
| `user_id` | INT FK → `users` | 所属用户，`ON DELETE CASCADE` |
| `name` | VARCHAR(50) | 显示名称，trim 后 1–50 字符 |
| `slug` | VARCHAR(60) NULL | 可选 URL 友好名（一期可留空） |
| `color` | VARCHAR(16) NULL | 可选，如 `#8250df` |
| `icon` | VARCHAR(50) NULL | 可选，与分组共用 `normalizeGroupIcon` 规则 |
| `sort_order` | INT DEFAULT 0 | 侧栏排序，越小越靠前 |
| `created_at` / `updated_at` | TIMESTAMP(6) | 创建/更新时间 |

**约束与索引**

- `UNIQUE (user_id, name)` — 映射名 `ux_user_tags_user_name`：同一用户下标签名不可重复。
- `INDEX (user_id, sort_order)` — 映射名 `idx_user_tags_user_sort`：按用户拉取有序列表。

删除某条 `user_tags` 记录时，通过外键 **级联删除** 该用户在此 tag 上的全部 `user_article_tags` 关联。

### 2.2 表：`user_article_tags`（Prisma：`UserArticleTag`）

用户 ↔ 文章 ↔ 标签的 **多对多关联**（带元数据）。

| 字段 | 类型 | 含义 |
|------|------|------|
| `user_id` | INT FK → `users` | 打标用户 |
| `article_id` | INT FK → `articles` | 文章 |
| `tag_id` | INT FK → `user_tags` | 标签 |
| `source` | VARCHAR(20) DEFAULT `manual` | 来源：`manual`（一期）；远期可为 `rule` |
| `tagged_at` | TIMESTAMP(6) | 打标时间，列表按 tag 筛选时可作排序依据 |

**主键**：复合主键 `(user_id, article_id, tag_id)`。

**索引**

- `(user_id, tag_id, tagged_at DESC)` — `idx_user_article_tags_user_tag_time`：按标签筛文章、按打标时间排序。
- `(user_id, article_id)` — `idx_user_article_tags_user_article`：单篇文章查全部标签。

三列外键均 `ON DELETE CASCADE`：删用户 / 文章 / 标签时自动清理关联行。

### 2.3 Prisma 关系扩展（步骤 1 实施）

- `User`：`tags UserTag[]`、`article_tags UserArticleTag[]`
- `Article`：`user_tags UserArticleTag[]`（注意：命名表示「用户打在该文章上的 tag 关联」，不是全局 tag 字段）

### 2.4 与现有表的关系示意

```
users ──┬── user_tags (1:N 词汇表)
        └── user_article_tags (N:M 经 article_id + tag_id)
articles ── feeds ── users
```

文章实体仍在 `articles`；Tag 仅通过 `user_article_tags` 挂到「某用户视角下的某篇文章」。

---

## 3. API 清单

以下路径均相对于 **`/api/feed-subscriptions`**。除注明外均需 Header：`Authorization: Bearer <token>`（登录接口见 `POST /api/auth/login`，响应字段 `token`）。

### 3.1 Tag 词汇表 CRUD（步骤 2）

#### `GET /tags`

列出当前用户全部标签（含每标签关联文章数）。

**响应示例**

```json
{
  "tags": [
    {
      "id": 1,
      "name": "AI",
      "slug": null,
      "color": "#8250df",
      "icon": "zap",
      "sort_order": 0,
      "article_count": 12,
      "created_at": "2026-06-04T10:00:00.000Z",
      "updated_at": "2026-06-04T10:00:00.000Z"
    }
  ]
}
```

排序：`sort_order ASC, id ASC`。

#### `POST /tags`

创建标签。

**请求**

```json
{
  "name": "AI",
  "color": "#8250df",
  "icon": "zap"
}
```

**响应** `200`

```json
{
  "tag": {
    "id": 1,
    "name": "AI",
    "slug": null,
    "color": "#8250df",
    "icon": "zap",
    "sort_order": 0,
    "created_at": "2026-06-04T10:00:00.000Z",
    "updated_at": "2026-06-04T10:00:00.000Z"
  }
}
```

**错误**：名称为空/超长 `400`；重名 `409` `{ "error": "标签名称已存在" }`。

#### `PATCH /tags/:tagId`

更新名称、颜色、图标或 `sort_order`。

**请求**（字段均可选）

```json
{
  "name": "人工智能",
  "color": "#0969da",
  "sort_order": 1
}
```

**响应** `{ "tag": { ... } }`；非本用户标签 `404`。

#### `DELETE /tags/:tagId`

删除标签（级联删除关联）。**响应** `{ "ok": true }` 或等价；`404` 若不存在。

#### `PUT /tags/reorder`

批量更新排序。

**请求**

```json
{
  "ordered_ids": [3, 1, 2]
}
```

**响应** `{ "tags": [ ... ] }` 或 `{ "ok": true }`；`ordered_ids` 含非本用户 id → `400`。

---

### 3.2 单篇文章打标（步骤 3）

路径参数 `articleId` 须为当前用户 Feed 下文章，否则 `404` `{ "error": "文章不存在" }`。

#### `GET /articles/:articleId/tags`

**响应**

```json
{
  "tags": [
    { "id": 1, "name": "AI", "color": "#8250df", "icon": "zap" }
  ]
}
```

按 `sort_order`、`name` 排序。

#### `PUT /articles/:articleId/tags`

全量替换该用户在此文章上的标签。

**请求**

```json
{
  "tag_ids": [1, 2]
}
```

**响应** `{ "tags": [ ... ] }`；去重；超过 20 个 `400`。

#### `POST /articles/:articleId/tags`

追加一条关联；`tag_id` 与 `name` 二选一。

**请求 A**（已有标签）

```json
{ "tag_id": 1 }
```

**请求 B**（无则创建再关联）

```json
{ "name": "待读" }
```

**响应** `{ "tags": [ ... ] }`；已存在关联则幂等成功；超过 20 个 `400`。

#### `DELETE /articles/:articleId/tags/:tagId`

移除一条关联。**响应** `{ "ok": true }` 或 `{ "tags": [ ... ] }`。

---

### 3.3 文章列表扩展（步骤 4a / 4b）

#### `GET /articles`（现有接口扩展）

在每条 `articles[]` 项中增加字段（步骤 4a）：

```json
{
  "id": 100,
  "title": "示例",
  "tags": [
    { "id": 1, "name": "AI", "color": "#8250df" }
  ],
  "is_liked": false,
  "is_read": true
}
```

无标签时 `tags: []`。批量加载，避免 N+1。

**查询参数（步骤 4b）**

| 参数 | 说明 |
|------|------|
| `tagId` | 单个标签 ID；仅返回打过该标签的文章（在用户当前 feed/group/feedId 范围内） |
| 与 `scope=liked` 同时存在 | **互斥**：以 `tagId` 为准，忽略 `scope=liked`（实现时在代码注释说明） |
| 非法 `tagId` | 非数字 → `400` `{ "error": "tagId 无效" }`；非本用户标签 → `404` |

**示例**

```
GET /api/feed-subscriptions/articles?tagId=1&limit=20&offset=0
```

**响应** 结构不变：`{ "articles": [...], "total": 42 }`，筛选后 `total` 为符合条件的总数。

**可选（步骤 11a）**：`tagIds=1,2&tagMode=any|all`。

---

### 3.4 批量打标（步骤 8）

#### `POST /articles/batch-tags`

**请求**

```json
{
  "article_ids": [10, 11],
  "tag_ids": [1, 2],
  "action": "add"
}
```

`action`：`add` | `remove` | `set`（`set` 对每篇先清空再写入，同单篇 PUT）。

**响应**

```json
{
  "ok": true,
  "updated": 2,
  "skipped": []
}
```

非法 `article_ids`（非本人 Feed）→ `400` 并说明 `invalid_ids`；单篇累计超过 20 → 按实现返回 `400`。

---

### 3.5 可选：Admin 只读（步骤 10）

#### `GET /api/admin/articles`

每篇文章增加 `tags: string[]` 或 `tags: [{ id, name }]`（按文章所属 Feed 的 `user_id` 查询），不提供写接口。

---

### 3.6 错误与迁移提示

- 未带有效 token：`401`（与现有 feed-subscription 行为一致）。
- 表未迁移：在 `getSubscriptionRouteError` 中识别 `user_tags` / `user_article_tags` 相关错误，提示执行 `npm run db:migrate`（与 `user_article_likes` 同类处理）。

---

## 4. 与 UserFeedGroup / UserArticleLike 对比

| 维度 | UserFeedGroup | UserArticleLike | Tag（user_tags + user_article_tags） |
|------|---------------|-----------------|--------------------------------------|
| **作用对象** | Feed 订阅源 | 单篇文章 | 单篇文章（主题分类） |
| **数据形态** | 用户词汇表 + Feed.group_id | 用户×文章 二元关联 | 用户词汇表 + 用户×文章×标签 三元关联 |
| **主键** | `id` | `(user_id, article_id)` | `(user_id, article_id, tag_id)` |
| **名称唯一** | `UNIQUE(user_id, name)` | — | `UNIQUE(user_id, name)` |
| **级联** | 删用户 → 删分组；删分组 → Feed.group_id SET NULL | 删用户/文章 → 删 like | 删用户/文章/标签 → 删关联 |
| **API 前缀** | `/groups` | `/articles/:id/like` | `/tags`、`/articles/:id/tags` |
| **列表筛选** | `groupId` / `ungrouped` | `scope=liked` | `tagId`（及可选 `tagIds`） |
| **是否改 articles 表** | 否 | 否 | **否** |
| **展示字段** | 侧栏分组树 | `is_liked`、喜欢列表 | `tags[]`、`article_count` |

模式对齐点：`user_id` 隔离 + Prisma `onDelete: Cascade` + 路由集中在 `feed-subscription.ts`。

---

## 5. 前端交互概要

实现文件主要为 `frontend/article-reader.html`、`frontend/article-reader.js`。认证方式与 like/read 相同（Bearer token）。

### 5.1 文章详情打标（步骤 5）

- 在阅读详情区（标题/工具栏附近）展示 Tag **chips**（背景色用 `color` 或默认灰）。
- 打开文章时：`GET /articles/:id/tags`。
- 输入框 + 回车：`GET /tags` 联想；匹配则 `POST { tag_id }`，否则 `POST { name }`。
- Chip 上 ×：`DELETE /articles/:id/tags/:tagId`。

### 5.2 侧栏标签区 + 列表筛选（步骤 6）

- Feed 分组树下方增加「**标签**」折叠区：`GET /tags` 渲染（色点 + 名称 + `article_count`）。
- 点击某项：`activeScope = 'tag'`，`activeTagId = id`，请求 `GET /articles?tagId=...`。
- 与 `scope=liked` 互斥：点标签清空 liked 模式；点「喜欢」清空 `activeTagId`。
- 顶栏标题「标签：xxx」+ 清除筛选；右键/菜单：PATCH/DELETE 标签。

### 5.3 列表卡片（步骤 7）

- 使用列表接口返回的 `article.tags`，标题下最多展示 3 个 chip，超出 `+N`。
- 点击 chip：等同侧栏选中该标签并 `loadArticles()`。

### 5.4 批量打标 UI（步骤 9）

- 列表多选 → 底部「添加标签 / 移除标签」→ 弹层多选 `GET /tags` → `POST /articles/batch-tags`。

### 5.5 状态持久化（可选）

扩展 reader 的 localStorage，保存 `activeTagId` / `activeScope`。

---

## 6. 实施阶段

与 [TAG_AI_PROMPTS.md](./TAG_AI_PROMPTS.md) 步骤一一对应：

| 步骤 | 内容 | 本仓库状态 |
|------|------|------------|
| **0** | 编写本文档 `docs/TAG_FEATURE.md` | 当前步骤 |
| **1** | Prisma 模型 + migration（`user_tags`、`user_article_tags`） | 待实施 |
| **2** | Tag 词汇表 CRUD API（5 个端点） | 待实施 |
| **3** | 单篇文章打标 API | 待实施 |
| **4a** | `GET /articles` 每条返回 `tags[]` | 待实施 |
| **4b** | `GET /articles?tagId=` 筛选 | 待实施 |
| **5** | 阅读器详情打标 UI | 待实施 |
| **6** | 侧栏标签区 + tagId 筛选（**MVP 终点**） | 待实施 |
| **7** | 列表卡片 Tag chip + 点击筛选 | 待实施 |
| **8** | 批量打标 API | 待实施 |
| **9** | 批量打标 UI | 待实施 |
| **10**（可选） | Admin 文章列表只读展示 Tag | 待实施 |
| **11a**（可选） | 多标签 `tagIds` + `tagMode` | 待实施 |
| **11b**（可选） | Feed 规则自动打标 `source=rule` | 待实施 |

**推荐顺序**：0 → 1 → 2 → 3 → 4a → 4b → 5 → 6 →（7–9）→（10–11）。

**运维**：涉及 schema 或后端路由变更后执行：

```bash
cd /www/wwwroot/pro/backend && npm run db:migrate && npm run db:generate
feedgen restart backend
```

---

## 7. 测试与环境

```bash
export API_BASE="http://127.0.0.1:3000/api"
export TOKEN="<登录后 token>"
export AUTH="Authorization: Bearer $TOKEN"
```

登录：

```bash
curl -s -X POST "$API_BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"你的邮箱","password":"你的密码"}'
```

各步骤的 curl / 浏览器验收清单见 [TAG_AI_PROMPTS.md](./TAG_AI_PROMPTS.md) 对应章节。

---

## 8. 参考文件

| 文件 | 用途 |
|------|------|
| `backend/prisma/schema.prisma` | `UserArticleLike`、`UserFeedGroup`、`Article` 现有模式 |
| `backend/src/routes/feed-subscription.ts` | 路由、认证、`normalizeGroupIcon`、文章列表 |
| `backend/src/server.ts` | 前缀 `/api/feed-subscriptions` |
| `docs/TAG_AI_PROMPTS.md` | 分步 AI 提示词与验收命令 |

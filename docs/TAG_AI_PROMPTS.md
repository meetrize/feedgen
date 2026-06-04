# 文章 Tag 功能 — 分步 AI 开发提示词

本文档为 Tag 功能的**逐步实施手册**。每次新对话只执行**一个步骤**，将对应章节的「完整提示词」整段复制给 AI。

**设计约束（全程有效）**

- Tag 是**用户级**能力，表：`user_tags`、`user_article_tags`
- **禁止**在 `articles` 表增加 tag 字段或 JSONB
- 模式对齐：`UserArticleLike`、`UserFeedGroup`（`user_id` + 级联删除）
- API 前缀：`/api/feed-subscriptions`（见 `backend/src/server.ts`）
- 运维：迁移/改后端后执行 `feedgen restart backend`（或 `feedgen restart`）
- **不要**在本功能中重构无关模块、不要改 crawler worker（除非步骤 11b）

**环境变量（测试脚本用）**

```bash
export API_BASE="http://127.0.0.1:3000/api"
# 登录后填入：
export TOKEN="你的 Bearer token"
export AUTH="Authorization: Bearer $TOKEN"
```

获取 TOKEN：用已有账号 `POST $API_BASE/auth/login`，body `{"email":"...","password":"..."}`，取响应中的 token 字段（以实际 `auth.ts` 响应为准）。

---

## 步骤 0：编写功能说明文档

### 完整提示词（复制从这里开始）

```
【任务】步骤 0/11：仅编写 Tag 功能说明文档，不写任何业务代码。

【背景】
FeedGen 是文章爬虫 + RSS 阅读系统。Tag 用于用户给文章打主题标签（非 Feed 分组、非喜欢/已读）。
PostgreSQL + Prisma，后端 Fastify，路由前缀 /api/feed-subscriptions。

【交付】
新建文件：docs/TAG_FEATURE.md（简体中文），包含：
1. 目标与边界（用户级 Tag；不在 articles 表存 tag；一期不做自动打标）
2. 表结构说明：user_tags、user_article_tags 字段含义与索引
3. API 清单（路径、方法、请求/响应示例 JSON）
4. 与 UserFeedGroup / UserArticleLike 的对比表
5. 前端交互概要（侧栏、详情打标、tagId 筛选）
6. 实施阶段列表（对应 TAG_AI_PROMPTS.md 步骤 1–11）

【参考文件】
- backend/prisma/schema.prisma（UserArticleLike、UserFeedGroup、Article）
- backend/src/routes/feed-subscription.ts
- docs/TAG_AI_PROMPTS.md（若已存在可交叉引用）

【禁止】
- 不要修改 schema、路由、前端
- 不要实现代码

【验收】
- [ ] docs/TAG_FEATURE.md 存在且为中文
- [ ] 明确两张表名与 UNIQUE(user_id, name)
- [ ] API 路径与 /api/feed-subscriptions 前缀一致
```

### 验证方法

```bash
test -f /www/wwwroot/pro/docs/TAG_FEATURE.md && head -80 /www/wwwroot/pro/docs/TAG_FEATURE.md
```

人工检查：文档中的 API 列表是否覆盖步骤 2–4 将实现的端点。

---

## 步骤 1：Prisma 模型与数据库迁移

### 完整提示词

```
【任务】步骤 1/11：仅实现 Tag 相关的 Prisma 模型与 SQL migration，不写 API 与前端。

【范围】
修改：backend/prisma/schema.prisma
新增：backend/prisma/migrations/<timestamp>_add_user_tags/migration.sql

【模型要求】

1) UserTag（表名 user_tags）
- id Int @id @default(autoincrement())
- user_id Int → User
- name String @db.VarChar(50)
- slug String? @db.VarChar(60)
- color String? @db.VarChar(16)
- icon String? @db.VarChar(50)
- sort_order Int @default(0)
- created_at, updated_at DateTime @db.Timestamp(6)
- @@unique([user_id, name], map: "ux_user_tags_user_name")
- @@index([user_id, sort_order], map: "idx_user_tags_user_sort")

2) UserArticleTag（表名 user_article_tags）
- 复合主键 @@id([user_id, article_id, tag_id])
- user_id, article_id, tag_id 均带 FK，ON DELETE CASCADE
- source String @default("manual") @db.VarChar(20)
- tagged_at DateTime @default(now()) @db.Timestamp(6)
- @@index([user_id, tag_id, tagged_at(sort: Desc)], map: "idx_user_article_tags_user_tag_time")
- @@index([user_id, article_id], map: "idx_user_article_tags_user_article")

3) 在 User 增加：tags UserTag[]、article_tags UserArticleTag[]
4) 在 Article 增加：user_tags UserArticleTag[]

【风格】
与现有 UserArticleLike、UserFeedGroup 的 @@map、索引命名一致。

【禁止】
- 不要改 feed-subscription.ts、前端、crawler
- 不要在本步执行破坏性 SQL（DROP 其他表）

【完成后说明】
在回复中写明需执行：
  cd /www/wwwroot/pro/backend && npm run db:migrate && npm run db:generate
  feedgen restart backend

【验收清单】
- [ ] migration.sql 含两张表、外键、索引
- [ ] npx tsc --noEmit 在 backend 目录无 Prisma 类型错误（migrate 后）
```

### 验证方法

```bash
cd /www/wwwroot/pro/backend
npm run db:migrate
npm run db:generate
npx tsc --noEmit
```

```bash
# 若可连数据库，检查表是否存在
psql "$DATABASE_URL" -c '\d user_tags'
psql "$DATABASE_URL" -c '\d user_article_tags'
```

**预期**：两张表存在；`user_tags` 有唯一约束 `(user_id, name)`。

### 测试方法

无需 HTTP 测试。失败时查看 `feedgen logs backend -n 30` 是否出现 `user_tags` / P2021。

---

## 步骤 2：Tag 词汇表 CRUD API

### 完整提示词

```
【任务】步骤 2/11：在 feed-subscription 路由中实现用户 Tag 词汇表 CRUD。不要改 GET /articles，不要改前端。

【文件】
仅修改：backend/src/routes/feed-subscription.ts
（步骤 1 的 schema 应已存在；若不存在先提示用户执行步骤 1）

【认证】
复用现有 requireUserId(req, res)。

【新增端点】（相对前缀 /api/feed-subscriptions）

1. GET /tags
   响应：{ tags: Array<{ id, name, slug, color, icon, sort_order, article_count, created_at, updated_at }> }
   - 仅当前用户的 tags
   - 按 sort_order ASC, id ASC
   - article_count：该用户在此 tag 下的 user_article_tags 条数（groupBy 或子查询）

2. POST /tags
   Body: { name: string, color?: string, icon?: string }
   - name：trim，长度 1–50，空则 400
   - icon：复用 normalizeGroupIcon（同分组）
   - color：可选，校验为 #RGB 或 #RRGGBB（不合法可忽略或 400）
   - P2002 → 409 { error: '标签名称已存在' }
   - 响应：{ tag: {...} }

3. PATCH /tags/:tagId
   Body: { name?, color?, icon?, sort_order? }
   - tag 必须属于当前 user_id，否则 404
   - 改名时同样 trim + 长度 + P2002→409

4. DELETE /tags/:tagId
   - 404 若不存在或不属于用户
   - 删除 tag（级联删 user_article_tags）

5. PUT /tags/reorder
   Body: { ordered_ids: number[] }
   - 按数组顺序写入 sort_order 0,1,2...
   - ordered_ids 中每个 id 必须属于当前用户，否则 400
   - 响应：{ tags: [...] } 或 { ok: true }

【错误处理】
- 在 getSubscriptionRouteError 的错误信息检测中增加 user_tags、user_article_tags（与 user_article_likes 同样提示 migrate）
- 日志 req.log.error(error)

【禁止】
- 不要实现文章打标、不要改 GET /articles
- 不要新建独立路由文件（除非项目惯例要求，默认只改 feed-subscription.ts）

【完成后】
列出新增路由；说明 feedgen restart backend。

【验收清单】
- [ ] 5 个端点均可调
- [ ] 重名创建返回 409
- [ ] 删除 tag 后 GET /tags 不再包含该项
```

### 验证方法

```bash
cd /www/wwwroot/pro/backend && npx tsc --noEmit
feedgen restart backend
```

### 测试方法（curl）

```bash
# 1. 登录
curl -s -X POST "$API_BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"你的邮箱","password":"你的密码"}' | jq .

export TOKEN="粘贴 token"
export AUTH="Authorization: Bearer $TOKEN"

# 2. 创建标签
curl -s -X POST "$API_BASE/feed-subscriptions/tags" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"name":"AI","color":"#8250df","icon":"zap"}' | jq .

# 3. 列表（应有 article_count: 0）
curl -s "$API_BASE/feed-subscriptions/tags" -H "$AUTH" | jq .

# 4. 重名应 409
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$API_BASE/feed-subscriptions/tags" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"name":"AI"}'

# 5. 改名
TAG_ID=1  # 替换为实际 id
curl -s -X PATCH "$API_BASE/feed-subscriptions/tags/$TAG_ID" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"name":"人工智能"}' | jq .

# 6. 排序
curl -s -X PUT "$API_BASE/feed-subscriptions/tags/reorder" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"ordered_ids\":[$TAG_ID]}" | jq .

# 7. 删除
curl -s -X DELETE "$API_BASE/feed-subscriptions/tags/$TAG_ID" -H "$AUTH" | jq .
```

**预期 HTTP**：创建 200；重名 409；无 token 401；删除后 GET 列表无该 id。

---

## 步骤 3：单篇文章打标 API

### 完整提示词

```
【任务】步骤 3/11：实现单篇文章的 Tag 读写 API。不要改 GET /articles 列表逻辑，不要改前端。

【文件】
backend/src/routes/feed-subscription.ts

【辅助函数】（写在同文件顶部或 articles 路由附近）
async function assertArticleOwnedByUser(userId: number, articleId: number): Promise<article | null>
- prisma.article.findFirst({
    where: { id: articleId, feeds: { user_id: userId } },
    select: { id: true, feed_id: true }
  })
- 不存在返回 null（路由返回 404 { error: '文章不存在' }）

async function assertTagOwnedByUser(userId: number, tagId: number): Promise<boolean>

【常量】
MAX_TAGS_PER_ARTICLE = 20

【新增端点】

1. GET /articles/:articleId/tags
   响应：{ tags: [{ id, name, color, icon }] }
   - 按 tag.sort_order, tag.name 排序

2. PUT /articles/:articleId/tags
   Body: { tag_ids: number[] }
   - 全量替换：先删该用户在此 article 上的全部 user_article_tags，再插入 tag_ids
   - 每个 tag_id 必须属于 userId
   - tag_ids 去重；超过 20 个返回 400
   - 响应：{ tags: [...] }

3. POST /articles/:articleId/tags
   Body: { tag_id?: number, name?: string } 二选一
   - tag_id：追加关联，已存在则幂等成功
   - name：若无同名 UserTag 则创建再关联（source=manual）
   - 超过 20 个返回 400
   - 响应：{ tags: [...] }

4. DELETE /articles/:articleId/tags/:tagId
   - 删除一条关联，响应 { ok: true } 或 { tags: [...] }

【禁止】
- 不要实现 batch-tags
- 不要改 GET /articles 的 tags 字段

【验收清单】
- [ ] 只能操作自己 Feed 下的文章
- [ ] PUT 全量替换正确
- [ ] POST name 可自动创建 Tag
```

### 验证方法

```bash
cd /www/wwwroot/pro/backend && npx tsc --noEmit
feedgen restart backend
```

### 测试方法

```bash
# 取一篇自己的文章 id
curl -s "$API_BASE/feed-subscriptions/articles?limit=1" -H "$AUTH" | jq '.articles[0].id'
export ARTICLE_ID=123   # 替换

# 用 name 创建并打标
curl -s -X POST "$API_BASE/feed-subscriptions/articles/$ARTICLE_ID/tags" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"name":"测试标签"}' | jq .

# 查询
curl -s "$API_BASE/feed-subscriptions/articles/$ARTICLE_ID/tags" -H "$AUTH" | jq .

# 全量替换（先 POST /tags 再拿 tag_ids）
curl -s -X PUT "$API_BASE/feed-subscriptions/articles/$ARTICLE_ID/tags" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"tag_ids":[1]}' | jq .

# 删除关联
curl -s -X DELETE "$API_BASE/feed-subscriptions/articles/$ARTICLE_ID/tags/1" -H "$AUTH" | jq .

# 非法文章应 404
curl -s -o /dev/null -w "%{http_code}\n" \
  "$API_BASE/feed-subscriptions/articles/99999999/tags" -H "$AUTH"
```

**数据库抽查**（可选）：

```sql
SELECT * FROM user_article_tags WHERE user_id = <你的user_id> AND article_id = <ARTICLE_ID>;
```

---

## 步骤 4a：文章列表返回 tags 字段（不实现筛选）

### 完整提示词

```
【任务】步骤 4a/11：仅让 GET /feed-subscriptions/articles 的每条文章带上 tags 数组。不要实现 tagId 筛选参数。

【文件】
backend/src/routes/feed-subscription.ts

【实现要求】
1. 在现有返回 articles 的所有分支（scope=all/today/liked、unreadOnly、普通列表）中，为 mappedArticles 增加 tags 字段。

2. 批量加载 tags（避免 N+1）：
   - 收集本页 articleIds
   - 一次查询 user_article_tags JOIN user_tags
     WHERE user_id = userId AND article_id IN (...)
   - 组装 Map<articleId, tags[]>

3. tags 单项格式：{ id, name, color }（icon 可选）

4. 无标签时 tags: []

【禁止】
- 不要加 query.tagId
- 不要改前端

【参考】
同文件内 is_liked / is_read 的批量 Set 加载方式（readRows、likedRows）。

【验收】
- [ ] GET /articles?limit=5 每条有 tags 数组
- [ ] scope=liked 的文章也有 tags
- [ ] total/limit/offset 行为与改前一致
```

### 测试方法

```bash
curl -s "$API_BASE/feed-subscriptions/articles?limit=5" -H "$AUTH" | jq '.articles[] | {id, tags}'

# 先给一篇文章打标后再查
curl -s -X POST "$API_BASE/feed-subscriptions/articles/$ARTICLE_ID/tags" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"name":"列表可见"}' | jq .

curl -s "$API_BASE/feed-subscriptions/articles?limit=20" -H "$AUTH" \
  | jq ".articles[] | select(.id==$ARTICLE_ID) | .tags"
```

**预期**：打标文章 `tags` 非空；其他文章 `tags: []`。

---

## 步骤 4b：按 tagId 筛选文章列表

### 完整提示词

```
【任务】步骤 4b/11：为 GET /articles 增加 tagId 查询参数，服务端分页筛选。保留步骤 4a 的 tags 字段。

【文件】
backend/src/routes/feed-subscription.ts

【查询参数】
tagId?: string  // 单个标签 ID

【行为】
1. 当 tagId 有效时：
   - 校验该 tag 属于当前 user（否则 404）
   - 在现有 articleWhere / scopedFeedIds 范围内筛选（与 feedId、groupId、ungrouped 组合）
   - 实现方式参考 scope=liked：$queryRaw JOIN user_article_tags + articles，ORDER BY tagged_at DESC, created_at DESC
   - 返回 { articles, total }，articles 含 tags、is_read、is_liked

2. 当 tagId 与 scope=liked 同时存在：
   - 采用互斥：tagId 优先，忽略 scope=liked（或返回 400，二选一并在代码注释说明）

3. tagId 无效非数字 → 400 { error: 'tagId 无效' }

【禁止】
- 不要实现 tagIds、tagMode（留给步骤 11a）
- 不要改前端

【验收】
- [ ] ?tagId=X 只返回打过该标签的文章
- [ ] total 与分页正确
- [ ] 与 feedId 组合时只在该 feed 内筛选
```

### 测试方法

```bash
TAG_ID=1  # 替换
curl -s "$API_BASE/feed-subscriptions/articles?tagId=$TAG_ID&limit=10" -H "$AUTH" | jq '{total, ids: [.articles[].id]}'

# 每条应含该 tag（tags 数组里至少有 id==TAG_ID）
curl -s "$API_BASE/feed-subscriptions/articles?tagId=$TAG_ID&limit=3" -H "$AUTH" \
  | jq '.articles[] | select([.tags[].id] | index('$TAG_ID') | not) | .id'
# 应无输出

# 组合 feedId（替换 FEED_ID）
curl -s "$API_BASE/feed-subscriptions/articles?tagId=$TAG_ID&feedId=$FEED_ID&limit=5" -H "$AUTH" | jq '.total'
```

---

## 步骤 5：阅读器 — 文章详情打标 UI

### 完整提示词

```
【任务】步骤 5/11：在文章阅读器详情区实现 Tag 展示与编辑。不要实现侧栏标签列表、不要实现 tagId 列表筛选 UI。

【文件】
- frontend/article-reader.html（如需容器/样式）
- frontend/article-reader.js

【API】（已实现于步骤 2–3）
- GET  /feed-subscriptions/tags
- GET  /feed-subscriptions/articles/:id/tags
- POST /feed-subscriptions/articles/:id/tags  body { name } 或 { tag_id }
- DELETE /feed-subscriptions/articles/:id/tags/:tagId

【UI 要求】
1. 在阅读详情面板（标题/工具栏附近）增加 Tag 区域：
   - 展示已有 tag 为 chip（显示 name，背景用 color 或默认灰）
   - chip 上 × 删除（调 DELETE）
   - 输入框 + 回车：联想已有 tags（GET /tags），匹配则 POST tag_id，否则 POST name 创建
2. 打开文章时加载 GET .../articles/:id/tags
3. 使用现有 auth headers 模式（与 like/read 相同）
4. 样式与 article-reader-like-btn 协调，不引入新框架

【禁止】
- 不要改 activeScope、侧栏 DOM
- 不要实现批量打标

【完成后】
说明如何在浏览器验证（http://127.0.0.1:3001 或 feedgen info 的地址）

【验收】
- [ ] 打开文章能看到 tags
- [ ] 添加、删除 tag 后刷新仍正确
- [ ] 未登录时行为与现有页面一致（跳转登录或提示）
```

### 验证方法

1. `feedgen restart`（若只改前端可 `feedgen restart frontend`）
2. 浏览器打开文章阅读页，登录后打开任意文章
3. DevTools → Network：确认调用了 `.../tags` 接口且 200

### 测试方法（手工清单）

| # | 操作 | 预期 |
|---|------|------|
| 1 | 输入新标签名回车 | 出现新 chip，Network POST 200 |
| 2 | 点击 chip × | chip 消失，DELETE 200 |
| 3 | 输入已有标签名前几个字符回车 | 关联已有 tag，不重复创建 |
| 4 | F5 刷新后再打开同一篇 | tags 仍在 |

---

## 步骤 6：阅读器 — 侧栏标签区 + 列表筛选

### 完整提示词

```
【任务】步骤 6/11：文章阅读器侧栏增加「标签」区块，点击按 tagId 筛选文章列表。步骤 5 的详情打标应已存在。

【文件】
frontend/article-reader.html
frontend/article-reader.js

【状态】
- 新增 activeTagId（number | null）
- activeScope 扩展：'tag' 时表示按标签筛选（与 'all'|'today'|'liked' 互斥）
- applyArticleScopeQueryParams：当 activeScope==='tag' && activeTagId 时 params.set('tagId', String(activeTagId))
- 与 scope=liked 互斥：点标签时 activeScope='tag'；点「喜欢」时清空 activeTagId

【侧栏 UI】
1. 在 Feed 分组树下方增加「标签」折叠区
2. GET /feed-subscriptions/tags 渲染列表：色点 + name + article_count
3. 点击某项：activeTagId=id，activeScope='tag'，resetArticleListPage()，loadArticles()
4. 顶栏标题显示「标签：xxx」并提供清除（恢复 all）
5. 标签项右键或 ⋮ 菜单：重命名、改色、删除（PATCH/DELETE /tags/:id），删除前 confirm

【localStorage】（可选）
扩展已有 reader 状态存储，保存 activeTagId

【禁止】
- 不要实现列表卡片 chip 点击筛选（步骤 7）
- 不要实现批量打标

【验收】
- [ ] 侧栏显示标签及数量
- [ ] 点击后列表仅含该标签文章
- [ ] 清除筛选恢复全部
```

### 测试方法

| # | 操作 | 预期 |
|---|------|------|
| 1 | 侧栏点击某标签 | Network：`articles?tagId=` |
| 2 | 清除筛选 | 请求无 tagId，列表恢复 |
| 3 | 先点「喜欢」再点标签 | 进入 tag 模式，非 liked 列表 |
| 4 | 删除标签 | 侧栏项消失，若正在筛选则回全部 |

```bash
# 与浏览器并行：直接测 API 有数据即可
curl -s "$API_BASE/feed-subscriptions/tags" -H "$AUTH" | jq '.tags'
```

---

## 步骤 7：列表卡片展示 Tag + 点击筛选

### 完整提示词

```
【任务】步骤 7/11：文章列表每条卡片展示 Tag chips，点击 chip 等同侧栏选中该标签。不改变后端。

【文件】
frontend/article-reader.js（renderArticles 或等价渲染函数）

【要求】
1. 使用列表接口返回的 article.tags（步骤 4a）
2. 标题下方展示最多 3 个 chip，超出显示 +N
3. 点击 chip：设置 activeTagId、activeScope='tag'，更新侧栏选中态（若有），loadArticles()
4. chip 样式与详情区一致

【禁止】
- 不要改后端
- 不要做多选批量

【验收】
- [ ] 列表可见 tags
- [ ] 点击 chip 列表变为该 tag 筛选
```

### 测试方法

浏览器：找一篇多标签文章（或打 4 个标签），确认只显示 3 个 + `+1`；点击 chip 后 URL 请求含 `tagId`。

---

## 步骤 8：批量打标 API

### 完整提示词

```
【任务】步骤 8/11：仅实现批量打标 API，不改前端。

【文件】
backend/src/routes/feed-subscription.ts

【端点】
POST /articles/batch-tags

Body:
{
  "article_ids": number[],   // 1–100，去重
  "tag_ids": number[],       // 至少 1 个，均属于当前用户
  "action": "add" | "remove" | "set"
}

【行为】
- add：对每个 article_id 插入 tag_ids 关联（已存在跳过）；单篇累计标签不超过 20
- remove：删除指定关联
- set：对每篇文章先删该用户全部 tag 关联再写入 tag_ids（与 PUT 单篇类似）
- 所有 article 必须 feeds.user_id === userId，否则 400 并说明 invalid_ids
- 响应：{ ok: true, updated: number, skipped?: number[] }

【禁止】
- 不要改 GET /articles 其他逻辑

【验收】
- [ ] add 后多篇带相同 tag
- [ ] remove 只移除指定 tag
- [ ] 含非法 article_id 返回 400
```

### 测试方法

```bash
curl -s -X POST "$API_BASE/feed-subscriptions/articles/batch-tags" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"article_ids":[1,2],"tag_ids":[1],"action":"add"}' | jq .

# 抽查
for id in 1 2; do
  curl -s "$API_BASE/feed-subscriptions/articles/$id/tags" -H "$AUTH" | jq .
done

curl -s -X POST "$API_BASE/feed-subscriptions/articles/batch-tags" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"article_ids":[1,2],"tag_ids":[1],"action":"remove"}' | jq .
```

---

## 步骤 9：阅读器批量打标 UI

### 完整提示词

```
【任务】步骤 9/11：阅读器列表多选 + 批量打标，调用步骤 8 API。

【文件】
frontend/article-reader.html
frontend/article-reader.js

【UI】
1. 列表进入「多选模式」（按钮「批量打标」或 checkbox 列）
2. 选中 ≥1 篇后底部浮条：「添加标签」「移除标签」
3. 弹层：GET /tags 多选 checkbox，确认后 POST batch-tags action=add/remove
4. 完成后退出多选并 loadArticles()

【禁止】
- 不要改 Admin
- 不要实现 tag set 全量替换 UI（可选，非必须）

【验收】
- [ ] 选 2 篇批量 add 后两篇都有 tag
- [ ] 批量 remove 生效
```

### 测试方法

| # | 操作 | 预期 |
|---|------|------|
| 1 | 选 2 篇文章 → 添加标签 | batch-tags 200，列表刷新后两篇有 chip |
| 2 | 选 2 篇 → 移除标签 | chip 消失 |

Network 面板检查 `POST .../batch-tags` 请求体与响应。

---

## 步骤 10（可选）：Admin 只读展示 Tag

### 完整提示词

```
【任务】步骤 10（可选）：管理后台文章列表只读展示 Tag，不提供编辑。

【文件】
- backend/src/routes/admin.ts
- frontend/admin.js
- frontend/admin.html

【后端】
GET /api/admin/articles 响应中每篇文章增加 tags: string[]（标签名列表）或 tags: [{id,name}]
- 通过 article → user_article_tags → user_tags 查询（注意：按文章所属 feed 的 user_id 查 tags）

【前端】
表格增加一列「标签」，显示逗号分隔名称

【禁止】
- 不要实现 Admin 改 tag
- 不要改普通用户路由

【验收】
- [ ] Admin 登录后文章表可见标签列
```

### 测试方法

使用管理员账号登录 Admin 页，打开「所有采集文章」，确认有标签列；对比普通用户 API 打标同一篇后 Admin 可见。

---

## 步骤 11a（可选）：多标签 AND/OR 筛选

### 完整提示词

```
【任务】步骤 11a（可选）：GET /articles 支持 tagIds 与 tagMode。

【参数】
- tagIds: "1,2,3"
- tagMode: "any"（默认，OR）| "all"（AND）

【行为】
- any：文章拥有任一 tag
- all：文章同时拥有全部 tag
- 与 scopedFeedIds、feedId、groupId 组合

【前端】（若做）
侧栏 Shift+点击多选标签时传 tagIds+tagMode

【验收】
- [ ] tagMode=all 时结果 ⊆ 每个单 tag 筛选的交集
```

### 测试方法

```bash
curl -s "$API_BASE/feed-subscriptions/articles?tagIds=1,2&tagMode=all&limit=20" -H "$AUTH" | jq '.total,.articles[].id'
curl -s "$API_BASE/feed-subscriptions/articles?tagIds=1,2&tagMode=any&limit=20" -H "$AUTH" | jq '.total'
```

---

## 步骤 11b（可选）：Feed 自动打标规则

### 完整提示词

```
【任务】步骤 11b（可选）：Feed 规则自动打标（远期）。

【范围】
- 新表 feed_tag_rules（feed_id, tag_id, match_field, match_type, pattern, is_active）
- crawlerWorker 或文章入库后执行规则，写入 user_article_tags source='rule'
- 文档更新 docs/TAG_FEATURE.md

【禁止】
- 不要破坏现有手动打标

【验收】
- [ ] 配置规则后新抓取文章自动带 tag
- [ ] source 字段为 rule
```

---

## 通用：每步结束后给 AI 的收尾要求

在任意步骤提示词末尾可追加：

```
【收尾】
1. 列出所有改动文件路径
2. 若涉及 backend：cd backend && npx tsc --noEmit
3. 执行 feedgen restart backend（或 restart）
4. 用上文「测试方法」跑一遍，贴出关键命令输出或失败原因
5. 如需提交 git，commit message 简体中文：feat(tag): ... 或 fix(tag): ...
```

---

## 推荐执行顺序（速查）

```
0 文档 → 1 表 → 2 Tag CRUD → 3 单篇 API → 4a 列表带 tags → 4b tagId 筛选
→ 5 详情 UI → 6 侧栏筛选 → 7 列表 chip → 8 batch API → 9 batch UI → 10 Admin → 11a/11b
```

**MVP**：完成到 **步骤 6** 即可日常使用。

**新对话开场白模板**：

```
请严格执行 @docs/TAG_AI_PROMPTS.md 的【步骤 N】完整提示词。
上一步已完成并通过测试。（附上失败信息或 NONE）
```

---

**文档版本**：1.0  
**对应设计**：Tag 用户级两表方案（user_tags + user_article_tags）

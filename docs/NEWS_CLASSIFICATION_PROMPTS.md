# 新闻标题分类 — 分步 AI 开发提示词

本文档为**新闻标题 AI 文本分类**功能的逐步实施手册。每次新对话只执行**一个步骤**，将对应章节的「完整提示词」整段复制给 Composer / Cursor Agent。

**设计基准**：[`docs/NEWS_CLASSIFICATION.md`](./NEWS_CLASSIFICATION.md)  
**模式参考**：[`docs/TAG_AI_PROMPTS.md`](./TAG_AI_PROMPTS.md)

---

## 能否一次性交给 Composer 完成？

**不建议一次性完成。** 原因如下：

| 因素 | 说明 |
|------|------|
| **跨栈** | 同时涉及 Python ML 服务、Node Fastify、Prisma、Bull、Vanilla JS 前端 |
| **依赖链** | 步骤 2→3 必须先于 6→7；步骤 1 必须先于所有 API |
| **环境验证** | ML 服务需单独启动、测内存；一次性做完难以定位是 Python 还是 Node 出错 |
| **上下文长度** | 全量实现约 30+ 文件，单次对话易遗漏边界约束或半成品 |
| **8GB 内存** | 需分步验证 gte-small-zh 与爬虫/后端共存，避免 OOM |

**推荐做法**：按本文档 **步骤 1 → 14** 顺序执行；**MVP（可日常使用）** 完成到 **步骤 13**（含自动分类 + 用户侧筛选）。训练相关（步骤 10–11）可在有标注数据后再做。

**若坚持「尽量合并」**：最多合并相邻 2 步（如 1+2、4+5），且每合并步后必须跑完验收命令再继续。

---

## 设计约束（全程有效）

- AI 分类是**系统级**能力，表前缀 `news_categories`、`article_classifications` 等
- **禁止**在 `articles` 表增加 category 字段；**禁止**写入 `user_tags`
- 与 **UserTag** 独立并存；用户侧字段名用 `ai_category`，与用户 `tags` 区分
- ML 推理在 **Python Sidecar**（`/www/wwwroot/pro/ml-service`），Node **不加载** torch
- 复用 keyatten 环境：`/www/wwwroot/keyatten/miniconda` 或 venv
- Admin API 前缀：`/api/admin/classification`；鉴权复用 `admin.ts` 的 `is_admin`
- 用户只读类别：`/api/classification/categories`；文章扩展仍在 `/api/feed-subscriptions`
- 运维：改 backend 后 `feedgen restart backend`；改 ML 后重启 ml-service（步骤 14 前可手动 `./run.sh`）
- **不要**重构 crawler、auth、billing 等无关模块

**环境变量**

```bash
export API_BASE="http://127.0.0.1:3000/api"
export ML_URL="http://127.0.0.1:3010"
# 管理员登录后：
export ADMIN_TOKEN="你的管理员 JWT"
export ADMIN_AUTH="Authorization: Bearer $ADMIN_TOKEN"
# 普通用户：
export TOKEN="你的用户 JWT"
export AUTH="Authorization: Bearer $TOKEN"
```

管理员登录：`POST $API_BASE/auth/login`，账号需 `users.is_admin = true`。

---

## 步骤 0：设计文档（已完成）

设计文档已存在于 `docs/NEWS_CLASSIFICATION.md`，无需重复编写。

**验收**：`test -f docs/NEWS_CLASSIFICATION.md`

---

## 步骤 1：Prisma 模型与数据库迁移

### 完整提示词

```
【任务】步骤 1/14：仅实现新闻分类相关的 Prisma 模型与 SQL migration，不写 API、ML 服务与前端。

【设计基准】
严格对照 @docs/NEWS_CLASSIFICATION.md 第 4 节「数据库设计」。

【范围】
修改：backend/prisma/schema.prisma
新增：backend/prisma/migrations/<timestamp>_add_news_classification/migration.sql

【模型清单】（7 张表）
1) NewsCategory → news_categories
2) NewsCategoryExample → news_category_examples
3) NewsCategoryPrototype → news_category_prototypes（embedding Bytes）
4) ArticleClassification → article_classifications（article_id UNIQUE）
5) ClassificationAnnotation → classification_annotations
6) ClassificationTrainingJob → classification_training_jobs
7) ClassificationModelVersion → classification_model_versions

【关系扩展】
- Article：classification ArticleClassification?、classification_annotations ClassificationAnnotation[]
- User：classification_annotations ClassificationAnnotation[]（labeled_by 可选 FK）

【风格】
与现有 UserTag、UserArticleLike 的 @@map、索引命名、onDelete 策略一致。

【禁止】
- 不要改 articles 表字段
- 不要写路由、ML、前端、crawler
- 不要 DROP 其他表

【完成后说明】
回复中写明需执行：
  cd /www/wwwroot/pro/backend && npm run db:migrate && npm run db:generate
  feedgen restart backend

【验收清单】
- [ ] migration.sql 含 7 张表、外键、索引
- [ ] article_classifications.article_id UNIQUE
- [ ] npx tsc --noEmit 无 Prisma 类型错误
```

### 验证方法

```bash
cd /www/wwwroot/pro/backend
npm run db:migrate && npm run db:generate && npx tsc --noEmit
psql "$DATABASE_URL" -c '\d news_categories' 2>/dev/null || echo "请手动确认表已创建"
```

---

## 步骤 2：Python ML 服务骨架

### 完整提示词

```
【任务】步骤 2/14：仅搭建 ml-service 骨架与健康检查，不实现完整分类逻辑。

【范围】
新建目录：/www/wwwroot/pro/ml-service/
  app/main.py          FastAPI，监听 0.0.0.0:3010
  app/config.py        端口、ML_SERVICE_TOKEN、模型目录、keyatten 路径
  app/services/embedder.py   gte-small-zh 加载与单条 embed（可先 lazy load）
  requirements.txt
  run.sh               激活 /www/wwwroot/keyatten/miniconda 或 venv 后 uvicorn 启动
  README.md            启动说明（中文简要）

【API】
- GET /internal/health → { "status": "ok", "embedder_ready": bool, "active_model": null|string }
- POST /internal/embed → { "texts": ["..."] } → { "vectors": [[...]] }（鉴权：Header X-Internal-Token）

【安全】
- 除 health 外，校验 X-Internal-Token 与环境变量 ML_SERVICE_TOKEN 一致
- 仅绑定内网，文档注明不对公网暴露

【禁止】
- 不要改 Node backend
- 不要在本步实现 classify / train
- 不要 pip install 到系统 Python，使用 keyatten 已有环境

【验收清单】
- [ ] ./run.sh 后 curl http://127.0.0.1:3010/internal/health 返回 ok
- [ ] embed 一条中文标题返回向量数组
```

### 验证方法

```bash
cd /www/wwwroot/pro/ml-service
export ML_SERVICE_TOKEN=test-token-123
./run.sh &
sleep 15
curl -s http://127.0.0.1:3010/internal/health | head -c 500
curl -s -X POST http://127.0.0.1:3010/internal/embed \
  -H "Content-Type: application/json" \
  -H "X-Internal-Token: test-token-123" \
  -d '{"texts":["央行宣布下调存款准备金率"]}'
```

---

## 步骤 3：ML 分类推理（原型冷启动）

### 完整提示词

```
【任务】步骤 3/14：在 ml-service 实现 POST /internal/classify，支持「无 LR 模型时仅用原型向量」冷启动。

【设计基准】
@docs/NEWS_CLASSIFICATION.md 第 3.2 节三层策略；本步至少实现：有 prototype 则余弦相似度分类；无模型时 skip LR。

【范围】
修改/新增 ml-service：
  app/services/classifier.py    推理主逻辑
  app/services/prototype.py     余弦相似度、批量 prototype 计算
  app/main.py                   新增 POST /internal/classify、POST /internal/prototype/rebuild

【POST /internal/classify】
请求：{ "title": "...", "categories": [{ "id": 1, "code": "finance", "prototype": [float...] }] }
或简化为 Node 传 title，Python 从请求体读 prototypes（本步 Node 未接时可测 mock categories）

响应：{ "category_id": 1|null, "category_code": "finance"|null, "confidence": 0.94, "model_version": null, "need_review": false }

【POST /internal/prototype/rebuild】
请求：{ "examples": ["标题1","标题2"] } → { "prototype": [float...], "example_count": 2 }

【阈值】
config：HIGH=0.65, LOW=0.50；低于 LOW 则 need_review=true

【禁止】
- 不要改 Node backend
- 不要实现训练

【验收清单】
- [ ] 给定 finance 类 prototype 与相似标题，confidence > 0.5
- [ ] 无关标题 confidence 较低或 need_review=true
```

### 验证方法

```bash
# 先 rebuild 原型，再 classify（用步骤 2 启动的 ml-service）
curl -s -X POST "$ML_URL/internal/prototype/rebuild" \
  -H "Content-Type: application/json" -H "X-Internal-Token: $ML_SERVICE_TOKEN" \
  -d '{"examples":["央行下调存款准备金率","A股收盘上涨","理财产品收益回落"]}'
# 将返回的 prototype 填入 classify 请求的 categories
```

---

## 步骤 4：Node ML 客户端 + Admin 类别 CRUD API

### 完整提示词

```
【任务】步骤 4/14：实现 Node 调 ML 的客户端 + Admin 类别 CRUD，不写 Bull 队列与前端。

【范围】
新建：
  backend/src/services/classification/mlClient.ts
  backend/src/services/classification/categoryService.ts
  backend/src/routes/classification-admin.ts

修改：
  backend/src/server.ts  注册 prefix /api/admin/classification
  backend/.env.example 或文档注释  增加 ML_SERVICE_URL、ML_SERVICE_TOKEN

【mlClient】
- classify(title, prototypes?)
- rebuildPrototype(examples: string[])
- healthCheck()
- 请求头 X-Internal-Token

【categoryService】
- CRUD news_categories
- 创建/更新类别时若有 examples，调 mlClient.rebuildPrototype，写入 news_category_prototypes
- 禁用类别：status=disabled，不物理删除

【Admin API】（复用 admin.ts 的 verifyAdmin 模式，可 export 或在 classification-admin 内 duplicate hook）
GET    /categories
POST   /categories  { code, name, description?, color?, examples?: string[] }
PATCH  /categories/:id
DELETE /categories/:id  → 实际 status=disabled
POST   /categories/:id/examples  { titles: string[] }

【禁止】
- 不要实现 classify article、Bull、crawler、前端
- 不要改 user_tags

【环境变量】
ML_SERVICE_URL=http://127.0.0.1:3010
ML_SERVICE_TOKEN=与 ml-service 一致

【完成后】
feedgen restart backend

【验收清单】
- [ ] Admin POST 创建 finance 类 + 3 条 examples 后 DB 有 news_category_prototypes
- [ ] GET /categories 返回列表含 example_count
```

### 验证方法

```bash
curl -s -H "$ADMIN_AUTH" "$API_BASE/admin/classification/categories"
curl -s -X POST -H "$ADMIN_AUTH" -H "Content-Type: application/json" \
  -d '{"code":"finance","name":"财经","color":"#e67e22","examples":["央行下调存款准备金率","A股震荡走高"]}' \
  "$API_BASE/admin/classification/categories"
```

---

## 步骤 5：Admin 前端 — 类别管理 Panel

### 完整提示词

```
【任务】步骤 5/14：仅在 admin 后台增加「新闻分类 → 类别管理」面板，对接步骤 4 API。

【范围】
修改：frontend/admin.html（侧栏菜单 + panel 容器）
新建：frontend/admin-classification.js（或按 admin.js 模式扩展）
修改：frontend/admin.html 引入新 script

【功能】
- 表格：code、name、status、示例数、颜色、操作（编辑、禁用）
- 新建/编辑弹窗：code、name、description、color、示例标题（多行 textarea，一行一条）
- 调用 GET/POST/PATCH/DELETE /api/admin/classification/categories

【风格】
与 admin.html 现有表格、toolbar、admin-menu-btn 风格一致；不引入新框架。

【禁止】
- 不要做标注队列、训练、阅读器
- 不要改 backend 路由（除非发现 API 缺字段需小补）

【验收清单】
- [ ] 管理员登录 Admin 可见「新闻分类」菜单
- [ ] 可新建类别并在列表中看到
- [ ] 刷新后数据仍在
```

### 验证方法

浏览器打开 Admin 页，用管理员账号登录，手动新建「科技 / tech」类别并保存。

---

## 步骤 6：Bull 分类队列 + 单条分类 API

### 完整提示词

```
【任务】步骤 6/14：实现 classification Bull 队列、ClassificationService、Admin 手动分类 API。

【设计基准】
@docs/NEWS_CLASSIFICATION.md 第 3.2、6.4、6.5 节

【范围】
新建：
  backend/src/services/classification/classificationService.ts
  backend/src/services/classification/classificationQueue.ts
修改：
  backend/src/routes/classification-admin.ts
  backend/src/index.ts  启动 classification queue processor（与 crawlerWorker 类似）

【classificationService.classifyArticle(articleId)】
1. 读 article.title
2. 读所有 active categories + prototypes
3. mlClient.classify(title, categoriesWithPrototypes)
4. upsert article_classifications（category_id, confidence, need_review, model_version）

【Bull 队列】
- 名：classification-queue
- job data: { articleId: number }
- attempts: 3, backoff exponential
- ML 失败不抛到 crawler（本步 crawler 未接）

【Admin API】
POST /classify  { article_id: number }  → 同步等待或立即返回 job_id（推荐同步 classify 便于测试）
POST /classify/batch  { article_ids: number[] }  → enqueue 多个

【可选】
backend/prisma/seed-classification.js 写入 8 个初始类别（见设计文档第 9 节）

【环境变量】
CLASSIFICATION_ENABLED=1

【禁止】
- 不要改 crawlerWorker（下一步）
- 不要改 feed-subscription 用户 API

【验收清单】
- [ ] POST classify 对已有 article_id 写入 article_classifications
- [ ] ml-service 不可用时队列重试且不 crash backend
```

### 验证方法

```bash
# 确保 ml-service 运行中
curl -s -X POST -H "$ADMIN_AUTH" -H "Content-Type: application/json" \
  -d '{"article_id": 1}' "$API_BASE/admin/classification/classify"
psql "$DATABASE_URL" -c "SELECT * FROM article_classifications LIMIT 3;"
feedgen restart backend
```

---

## 步骤 7：爬虫入库钩子（自动分类）

### 完整提示词

```
【任务】步骤 7/14：在 crawlerWorker 文章入库成功后 enqueue 分类任务。

【范围】
仅修改：backend/src/workers/crawlerWorker.ts

【逻辑】
- 在 articles 批量 insert 成功后，若 process.env.CLASSIFICATION_ENABLED !== '0'，对每个新插入的 article id 调用 classificationQueue.add({ articleId })
- 使用 removeOnComplete、attempts 与步骤 6 一致
- **分类失败不得影响爬虫入库成功状态**

【禁止】
- 不要改 classify 核心逻辑（除非缺 export）
- 不要改前端
- 不要同步等待 ML（必须异步 queue）

【验收清单】
- [ ] 手动触发一次 crawl 或模拟 insert 后，article_classifications 在数分钟内出现
- [ ] CLASSIFICATION_ENABLED=0 时不 enqueue
```

### 验证方法

```bash
feedgen restart backend
# 对某 Feed 手动爬取（Admin 或现有 manual crawl API）
sleep 30
psql "$DATABASE_URL" -c "SELECT ac.article_id, ac.confidence, nc.name FROM article_classifications ac LEFT JOIN news_categories nc ON nc.id=ac.category_id ORDER BY ac.id DESC LIMIT 5;"
```

---

## 步骤 8：标注 API（待标注队列 + 人工改标）

### 完整提示词

```
【任务】步骤 8/14：实现 Admin 标注相关 API，不写前端。

【Admin API】前缀 /api/admin/classification
GET  /pending?need_review=true&limit&offset&category_id&feed_id
     返回：articles + 当前 ai 预测 + confidence + feed 名
POST /annotate  { article_ids: number[], category_id: number }
     行为：
     - upsert article_classifications
     - insert classification_annotations（source=manual 或 corrected）
     - need_review=false
GET  /stats  各类别标注数、待审核数、今日标注量

【查询】
- pending 优先 need_review=true，按 confidence ASC
- 仅查 articles 表存在的数据

【禁止】
- 不要写训练逻辑
- 不要改 user_tags

【验收清单】
- [ ] annotate 后 annotations 表有记录且 classifications 已更新
- [ ] pending 列表 exclude 已 need_review=false 的项（或按设计文档筛选）
```

### 验证方法

```bash
curl -s -H "$ADMIN_AUTH" "$API_BASE/admin/classification/pending?limit=5"
curl -s -X POST -H "$ADMIN_AUTH" -H "Content-Type: application/json" \
  -d '{"article_ids":[1],"category_id":1}' "$API_BASE/admin/classification/annotate"
curl -s -H "$ADMIN_AUTH" "$API_BASE/admin/classification/stats"
```

---

## 步骤 9：Admin 前端 — 待标注队列 Panel

### 完整提示词

```
【任务】步骤 9/14：Admin 增加「待标注」面板，对接步骤 8 API。

【范围】
修改：frontend/admin.html、frontend/admin-classification.js

【功能】
- Tab：待标注 | 类别管理（步骤 5 已有）
- 表格：标题、Feed、AI 预测、置信度、时间
- 行内下拉选择类别 → POST /annotate
- 批量勾选 + 统一设类
- 筛选：need_review、置信度区间（可选）

【禁止】
- 不要做训练 Panel（下一步）
- 不要改阅读器

【验收清单】
- [ ] 待标注列表可加载
- [ ] 改标后该行从待标注消失或预测更新
```

### 验证方法

Admin 页打开「待标注」，选一条低置信度文章改标，刷新确认。

---

## 步骤 10：ML 训练 + 模型版本 API

### 完整提示词

```
【任务】步骤 10/14：实现训练流水线（Python train + Node 任务编排 + 模型版本管理）。

【设计基准】
@docs/NEWS_CLASSIFICATION.md 第 3.4 节

【Python ml-service 新增】
POST /internal/train  { job_id, annotations: [{title, category_id}] }
GET  /internal/train/{job_id}/progress
POST /internal/reload-model  { version, path }
- 训练：embed 批量 → sklearn LogisticRegression → 保存 models/v{N}/classifier.pkl + metrics.json
- 进度：内存或文件记录 0-100

【Node 新增】
backend/src/services/classification/trainingService.ts
Bull 队列：classification-train-queue（concurrency=1）

【Admin API】
POST /training/start  → 从 classification_annotations 拉数据，创建 training_jobs，enqueue
GET  /training/jobs
GET  /training/jobs/:id
GET  /models/active
PUT  /models/active  { version }  → 更新 is_active，调 ml reload-model

【DB】
写入 classification_training_jobs、classification_model_versions

【禁止】
- 不要改 crawler
- 训练时勿 block 其他 API

【验收清单】
- [ ] 至少 20 条 annotations 可触发训练并成功
- [ ] metrics_json 含 accuracy 或 macro_f1
- [ ] PUT models/active 后 classify 返回新 model_version
```

### 验证方法

```bash
# 先积累若干 annotate，再：
curl -s -X POST -H "$ADMIN_AUTH" "$API_BASE/admin/classification/training/start"
curl -s -H "$ADMIN_AUTH" "$API_BASE/admin/classification/training/jobs"
curl -s -H "$ADMIN_AUTH" "$API_BASE/admin/classification/models/active"
```

---

## 步骤 11：Admin 前端 — 模型训练 Panel

### 完整提示词

```
【任务】步骤 11/14：Admin 增加「模型训练」Panel。

【功能】
- 显示当前 active 版本、metrics 摘要
- 训练历史表格（status、progress、trigger、finished_at）
- 「开始训练」按钮 → POST /training/start
- 进度：每 3 秒轮询 GET /training/jobs/:id
- 训练成功后「发布版本」→ PUT /models/active

【禁止】
- 不要改 ML 训练核心（除非 API 不匹配需小修）

【验收清单】
- [ ] 可触发训练并看到进度变化
- [ ] 可发布新版本
```

### 验证方法

Admin → 模型训练 → 开始训练 → 等待完成 → 发布 → 再 classify 一篇文章看 model_version。

---

## 步骤 12：用户侧 API（ai_category + categoryId 筛选）

### 完整提示词

```
【任务】步骤 12/14：扩展用户文章 API，只读类别列表 + 列表带 ai_category + categoryId 筛选。

【范围】
新建：backend/src/routes/classification-public.ts  prefix /api/classification
修改：backend/src/routes/feed-subscription.ts
修改：backend/src/server.ts 注册 classification-public

【GET /api/classification/categories】
- 需 JWT（普通用户）
- 返回 active 类别：id, code, name, color, sort_order

【GET /api/feed-subscriptions/articles 扩展】
- 每条增加 ai_category: { id, code, name, color, confidence, need_review } | null
- 批量 join article_classifications + news_categories，避免 N+1
- 查询参数 categoryId：筛选该 AI 类别（在用户 feed 范围内）
- categoryId 与 tagId、scope=liked 互斥规则参考 docs/TAG_FEATURE.md（categoryId 优先或文档约定一种）

【禁止】
- 不要改 user_tags 逻辑
- 不要改 admin 路由

【验收清单】
- [ ] 用户 GET /articles 可见 ai_category
- [ ] ?categoryId= 筛选有效
- [ ] GET /classification/categories 无需 admin
```

### 验证方法

```bash
curl -s -H "$AUTH" "$API_BASE/classification/categories"
curl -s -H "$AUTH" "$API_BASE/feed-subscriptions/articles?limit=3" | head -c 2000
curl -s -H "$AUTH" "$API_BASE/feed-subscriptions/articles?categoryId=1&limit=5"
```

---

## 步骤 13：阅读器前端（AI 类别展示 + 侧栏筛选）

### 完整提示词

```
【任务】步骤 13/14：在阅读器展示 AI 类别并支持侧栏筛选。**MVP 终点。**

【范围】
修改：frontend/article-reader.js、frontend/article-reader.html（若需容器）、frontend/styles.css

【功能】
1. 列表卡片：标题下展示 ai_category chip（色点+名称，可选显示置信度）；与用户 tags chip 区分样式 class=ai-category-chip
2. 侧栏 Feed 分组下增加「主题分类」区：GET /api/classification/categories
3. 点击类别：activeScope='category'，activeCategoryId=id，请求 articles?categoryId=
4. 与 tagId、scope=liked 互斥（参考 TAG 实现）
5. localStorage 持久化 activeCategoryId（可选）

【禁止】
- 不要把 AI 类别写入 user_tags
- 不要改 admin 页

【验收清单】
- [ ] 列表可见 [财经] 等 AI chip
- [ ] 侧栏点「科技」只显示该类别文章
- [ ] 与用户手动 Tag 可同时显示
```

### 验证方法

浏览器打开 article-reader，登录用户账号，确认列表 chip 与侧栏筛选。

---

## 步骤 14（可选）：批量补跑 + feedgen 集成 ml-service

### 完整提示词

```
【任务】步骤 14（可选）：历史文章批量分类 + feedgen 管理 ml-service。

【范围】
1) Admin API POST /classify/batch 扩展：支持 feed_id、since、全量补跑，Bull classification-batch-queue，限并发
2) Admin UI：批量分类按钮（可选 feed 下拉）
3) scripts/feedgen 增加 start|stop|restart|status|logs ml
4) systemd 单元 feedgen-ml.service（若项目已有 systemd 模式）

【禁止】
- 不要改变步骤 6-7 单条队列语义

【验收清单】
- [ ] feedgen status 显示 ml 服务状态
- [ ] 批量任务可补跑历史 articles
```

### 验证方法

```bash
feedgen status
curl -s -X POST -H "$ADMIN_AUTH" -H "Content-Type: application/json" \
  -d '{"feed_id":1}' "$API_BASE/admin/classification/classify/batch"
```

---

## 步骤 15（可选）：增强功能

### 完整提示词

```
【任务】步骤 15（可选）：任选一项或多项，不要一次全做。

A) 自动触发训练：新增标注 ≥ 200 时 enqueue train（cron 或 annotate 后检查）
B) Admin 统计报表：各类别文章数、准确率抽样
C) WebSocket 训练进度：/api/admin/classification/ws/training/:jobId（backend 已有 ws 依赖）
D) 阅读器：低置信度文章仅 Admin 可见 need_review 标记（普通用户不展示）

【验收】
按所选子项写明确标准。
```

---

## 通用：每步结束后给 AI 的收尾要求

在任意步骤提示词末尾可追加：

```
【收尾】
1. 列出所有改动文件路径
2. 若涉及 backend：cd /www/wwwroot/pro/backend && npx tsc --noEmit
3. 若涉及 ml-service：确认 health 正常
4. 执行 feedgen restart backend（及 ml 若需）
5. 用上文「验证方法」跑一遍，贴关键输出或失败原因
6. 若用户要求提交 git：commit message 简体中文，如 feat(classification): 新增类别 CRUD API
7. 不要修改与本步无关的文件
```

---

## 推荐执行顺序（速查）

```
0 设计文档(已完成)
→ 1 数据库
→ 2 ML 骨架
→ 3 ML classify
→ 4 Admin 类别 API
→ 5 Admin 类别 UI
→ 6 Bull + 单条分类
→ 7 爬虫钩子
→ 8 标注 API
→ 9 标注 UI
→ 10 训练 API
→ 11 训练 UI
→ 12 用户 API
→ 13 阅读器 UI  ★ MVP 终点
→ 14 批量+feedgen（可选）
→ 15 增强（可选）
```

**最小可用路径（跳过训练）**：`1 → 2 → 3 → 4 → 6 → 7 → 12 → 13`  
（仅原型向量分类，无 LR 训练，适合先上线自动打标）

**完整路径**：按 1–13 全部执行，含 8–9 标注与 10–11 训练。

---

## 新对话开场白模板

```
请严格执行 @docs/NEWS_CLASSIFICATION_PROMPTS.md 的【步骤 N】完整提示词。
设计基准：@docs/NEWS_CLASSIFICATION.md
上一步已完成并通过测试。（附上失败信息或写 NONE）
约束：AI 分类不写 user_tags；不修改 articles 表结构；ML 在 Python sidecar。
```

---

## 常见问题

| 问题 | 处理 |
|------|------|
| ml-service 启动 OOM | 先 `feedgen stop` 停 frontend；确认仅一个 embedder 进程；训练 concurrency=1 |
| classify 全 null | 检查 categories 是否有 prototypes；ML_SERVICE_TOKEN 是否一致 |
| migration 失败 | 看 shadow DB；勿手动改已 deploy 的 migration |
| 阅读器无 ai_category | 先确认步骤 12 API 有字段；文章是否已 classify |
| 想一次做 3–4 步 | 可合并相邻步，但必须按顺序且每步验收通过 |

---

**文档版本**：1.0  
**对应设计**：[`docs/NEWS_CLASSIFICATION.md`](./NEWS_CLASSIFICATION.md)

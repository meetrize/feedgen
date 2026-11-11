# 文章查重 / 去重与定时任务台

## 目标

- **查重**：按自然日聚合近重复标题，展示「最早一条 + 转载数」，可展开同簇成员（时间正序）。
- **去重**：阅读器列表**显示**只留簇内最早一条；**不删库**。
- **异步判定**：独立于爬虫主路径；可定时跑、可手动触发/停止、可看进度。
- **任务台**：Admin「定时任务」面板统一托管查重及后续后台任务。

## 数据模型

| 表 / 字段 | 说明 |
|-----------|------|
| `articles.title_norm` | 规范化标题 |
| `articles.title_simhash` | 64-bit SimHash |
| `articles.dup_cluster_id` | 所属簇 |
| `articles.dup_is_primary` | 簇内最早一条为 `true` |
| `articles.dup_checked_at` | 最近一次参与判定时间 |
| `article_dup_clusters` | 日簇：`run_day`、`primary_article_id`、`member_count`、`sample_title` |
| `system_jobs` | 任务注册：`key` / `cron` / `enabled` / `config` |
| `system_job_runs` | 运行记录：状态、进度、`stats`、触发方式 |

入库（爬虫）只写 `title_norm` / `title_simhash`，**不**在爬虫事务里做簇合并。

## 近重复算法（v1）

窗口：自然日 `run_day`（优先 `pub_date` 本地日，否则 `created_at`）。

1. 规范化 → `title_norm`
2. SimHash；汉明距离 ≤ **3** 进候选
3. 字符 bigram Jaccard ≥ **0.88** 同簇（阈值可写在 `system_jobs.config`）
4. 同簇选最早（`pub_date` ASC NULLS LAST → `created_at` → `id`）为 primary
5. URL 规范化完全相同 → 强制同簇

配置示例（`dedup.daily`）：

```json
{ "hammingMax": 3, "jaccardMin": 0.88, "forceRebuild": false }
```

## Bull 队列

- 队列名：`dedup-queue`
- concurrency：`1`
- 环境变量：`DEDUP_ENABLED=0` 可关闭 worker；默认开启
- Job：`day`（指定日）/ `backfill`（日期区间）；取消为协作式（run 状态 `cancelled`）

启动入口：`backend/src/index.ts` → `startDedupWorker()` + `startJobScheduler()`。

默认 cron：`15 */2 * * *`（错开爬虫高峰）。`JOB_SCHEDULER_ENABLED=0` 可关闭任务台调度。

## Admin API

前缀：`/api/admin/jobs`（需管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 任务列表 + 最近 run |
| GET | `/:key/runs` | 运行历史 |
| POST | `/:key/trigger` | 手动触发（body: `{ mode, run_day, from, to, forceRebuild }`） |
| POST | `/runs/:id/cancel` | 取消运行中/排队任务 |
| PATCH | `/:key` | 改 cron / enabled / config |

前端：Admin → **定时任务**（`admin-jobs.js`）。

## 阅读器 API / UI

| 能力 | 说明 |
|------|------|
| `GET /api/feed-subscriptions/articles/dup-clusters?day=` | 查重簇（按 `member_count` DESC，含成员） |
| `GET .../articles?dedupe=1` | 列表过滤：`dup_is_primary = true OR dup_cluster_id IS NULL` |
| 工具栏「查重」 | 大弹层，可选日期，可展开成员 |
| 工具栏「去重」 | `localStorage reader.dedupeDisplay=1`，拉列表带 `dedupe=1` |

未检查过的文章在去重模式下仍显示，避免误伤。

## 运维备忘

```bash
# 应用迁移后重启后端
feedgen restart backend

# 日志
feedgen logs backend -f
```

手动触发（管理员令牌）：

```bash
curl -X POST "$API/api/admin/jobs/dedup.daily/trigger" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"day","forceRebuild":true}'
```

## 非目标（本轮）

- 不物理删除转载文
- 不做跨日全局指纹库
- 不用 LLM 判重
- 不在爬虫线程内嵌全量两两比较
- 任务台 v1 对 importance / theme / finance 仅只读展示；可运行的首个托管任务是 `dedup.daily`

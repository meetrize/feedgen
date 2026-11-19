# 新闻未来日程扫描

定时任务 `calendar.future_scan`：扫描**今日新入库**文章，用 AI 判断标题是否含未来日程，再从正文（或仅标题）抽取事件，写入 meostock 财经日历 SQLite。

## 配置

| 项 | 说明 |
|----|------|
| Cron（默认） | `30 */2 * * *` |
| 环境变量 `QUOTE_CACHE_PATH` | 覆盖日历库路径；默认 `/Users/meetrice/pro/meostock/data/quote_cache.db` |
| 环境变量 `CALENDAR_FUTURE_SCAN_ENABLED=0` | 禁用本任务逻辑 |
| 提示词 / batchSize / 去重参数 | 存在 `system_jobs.config`，管理台「定时任务 → 策略/提示词」可改 |

### 去重相关 config（默认开启）

| 字段 | 默认 | 说明 |
|------|------|------|
| `dedupeEnabled` | `true` | 写入前语义去重 |
| `dedupeDayWindow` | `2` | 按 `start_ts` ± N 天召回候选 |
| `dedupeMaxCandidates` | `12` | 单次最多候选条数 |
| `dedupeMinConfidence` | `0.8` | AI 判同置信度阈值 |
| `dedupeRuleSimilarity` | `0.72` | 规则相似短路（同日 + 名称归一 Jaccard） |
| `dedupeSystemPrompt` / `dedupeUserPromptTemplate` | 内置 | 可覆盖 |

## 处理流程

1. 取 Asia/Shanghai「今天」`created_at` 范围内、尚未处理完的文章（每轮最多 `batchSize`）。
2. **标题筛**：AI 返回 `hit`；未命中记 `skipped_no_future`。
3. **抽取**：有正文优先 `fulltext.body_text(_zh)`，否则 RSS `content` / 摘要；无正文也可只从标题抽。
4. 过滤：无合法 `start_at`，或早于今日 00:00 的丢弃。
5. **语义去重**（避免标题措辞不同但同一事件重复入库）：
   - 按日期窗召回库内东财 + feedgen 候选；
   - 同日且名称高度相似 → 规则合并（不调 AI）；
   - 否则 AI 返回 `same_as_fe_code`；达置信度则合并；
   - 合并：向已有行 `content` 追加原文线索，不覆盖东财名称 / importance；
   - 本批多条也先做规则互并。
6. 剩余行 Upsert 到 `finance_calendar_event`（`source=feedgen`）。
7. 写入 Postgres `article_calendar_extractions` 做幂等；正文后来抓取成功且此前无正文时可重抽。

## 日历字段约定

| 字段 | 规则 |
|------|------|
| `fe_code` | `feedgen_{articleId}_{sha1(name\|start_at\|std_type).slice(0,16)}`（新建时）；合并时沿用已有 `fe_code` |
| `source` | `feedgen`（与东财 `eastmoney` 共存；面板展示为「feedgen」/「东财」） |
| `importance*` | 不写入，留给 meostock AI 评级 |
| `sponsor` | 缺省 `新闻推断` |
| `fe_type` | 缺省 `新闻日程` |

## 管理台

- 启停 / 立即运行 / 运行历史：与其它系统任务相同。
- **策略/提示词**：编辑 cron、`batchSize`、`maxEventsPerArticle`、`maxBodyChars`、去重开关与窗口、两套 system/user 提示词；可「恢复默认提示词」后再保存。
- 运行 stats 含 `merged` / `dedupeRuleHits` / `dedupeAiCalls` / `dedupeAiMerges`。

## 验收建议

1. 造一条今日入库文章，标题含「下周三召开…」。
2. 管理台手动运行本任务。
3. 查 `quote_cache.db`：`SELECT * FROM finance_calendar_event WHERE source='feedgen'`。
4. 再跑一次：处理表幂等，日历行不重复增生。
5. 另造一篇标题措辞不同、同一会议同一日的文章 → 应 **合并** 进已有行（`merged` 增加），而不是新 `fe_code`。
6. 改提示词保存后，下次运行应使用新文案。

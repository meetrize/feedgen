# 原文正文抓取

按重要度阈值异步抓取原文正文；与爬虫主路径隔离，结果存独立表，阅读器详情优先展示。

## 目标

- 多数公开新闻页 / RSS 全文可拿到正文；失败可记录状态，不影响列表。
- 用 Mozilla Readability 抽主文，避免导航/广告；质量不够时 Playwright 回退。
- 默认仅 **重要度 ≥ 2 星** 抓取；阈值可在任务台配置（`minStars=1` 几乎全部，`0` 不按星过滤）。

## 流水线

```
爬虫入库(title/desc/url[/RSS content])
  → importance-queue 评分
  → stars ≥ minStars → fulltext-queue
  → HTTP → Readability（失败则 Playwright）
  → article_fulltexts + articles.fulltext_status
  → 阅读器详情优先 fulltext_html
```

RSS / Atom 若带 `content:encoded` 或长 `content`，会写入 `articles.content`；worker 达阈值后优先采用，**不必再请求原站**。

## 表结构

### `article_fulltexts`（1:1）

| 字段 | 说明 |
|------|------|
| `article_id` | PK / FK |
| `status` | `pending` / `success` / `failed` / `skipped` / `blocked` |
| `body_html` | 消毒后 HTML |
| `body_text` | 纯文本 |
| `word_count` / `byte_size` | 规模 |
| `extractor` | `rss` / `readability` / `playwright_readability` |
| `http_status` / `final_url` / `error` | 抓取元数据 |

### `articles.fulltext_status`

列表角标用冗余字段，避免 join 大表。

权威正文在 `article_fulltexts`；旧 `articles.content` 仅兼容 / RSS 暂存，不再作为展示权威源。

## 配置（`system_jobs` · `fulltext.fetch`）

```json
{
  "enabled": true,
  "minStars": 2,
  "maxBytes": 500000,
  "minTextLength": 200,
  "usePlaywrightFallback": true,
  "concurrency": 3,
  "retryFailedDays": 3,
  "backfillLimit": 80
}
```

- 默认 cron：`40 */3 * * *`（积压补扫）
- 主触发：评分完成后钩子入队
- Admin「定时任务」可启停、改 config、手动补扫 / 停止
- 环境变量：`FULLTEXT_ENABLED=0` 关闭；`FULLTEXT_CONCURRENCY` 覆盖并发

## API

| 接口 | 说明 |
|------|------|
| `GET /api/feed-subscriptions/articles` | 列表含 `fulltext_status` |
| `GET /api/feed-subscriptions/articles/:id` | 详情含 `fulltext_html`；翻译成功时含 `fulltext_html_zh` / `fulltext_translation_segments` |
| `POST /api/feed-subscriptions/articles/:id/fulltext` | 阅读器菜单手动抓取单篇（`force`，同步返回） |
| `POST /api/feed-subscriptions/articles/:id/fulltext/translate` | 正文分段翻译（`force` / `auto`） |
| `POST /api/admin/jobs/fulltext.fetch/trigger` | 手动积压补扫 |

## 代码入口

- [`backend/src/services/fulltext/`](../backend/src/services/fulltext/)：config / extract / fetch / service / queue
- 彭博：[`extractBloomberg.ts`](../backend/src/services/fulltext/extractBloomberg.ts)
  - 优先 `article/api/story/slug/...`
  - 遇 PerimeterX 403 时回退 **Jina Reader**（`r.jina.ai`，需本机代理）拿试读段
  - 再不行才 Playwright；RSS description 阈值对彭博放宽到约 60 词
- 评分钩子：[`scoringService.ts`](../backend/src/services/importance/scoringService.ts)
- RSS 全文：[`crawler.ts`](../backend/src/services/crawler.ts) `content:encoded`
- Worker 启动：[`index.ts`](../backend/src/index.ts) `startFulltextWorker()`

## 运维

```bash
feedgen restart backend
# Admin → 定时任务 →「原文正文抓取」→ 立即运行
```

## 阅读器原文面板

列表布局（仅标题 / 列表 / 卡片 / 板报）与右侧「原文面板」正交：布局菜单内用 **显示原文面板** 开关，不改变列表 class。

| 能力 | 说明 |
|------|------|
| 正文标签 | `fulltext_status=success` 时拉取并 `sanitizeArticleHtml` 后渲染 HTML；未抓取显示空态 |
| 原文标签 | iframe 加载 `article.url`；面板内提供「新窗口打开」 |
| 无法嵌入站点 | 知乎/微博/头条/彭博等设有防嵌套策略，**浏览器禁止 iframe**，无法简单绕过；面板显示引导并建议新窗口或看「正文」 |
| 读正文 / 原文 | 分别打开面板并切到对应标签 |
| 默认标签 | 有成功正文用「正文」，否则有 url 用「原文」 |
| 窄屏 | 面板改为覆盖层，禁用分隔拖拽，右上角关闭 |
| 持久化 | `reader.sidePanel.open` / `width` / `tab` / `reader.fulltext.viewMode` |
| 旧布局迁移 | `columns` → 列表 + 面板开；`columns-iframe` → 同上且默认「原文」标签 |

## 正文翻译

挂在 `article_fulltexts`（与英文正文 1:1）：

| 字段 | 说明 |
|------|------|
| `body_html_zh` / `body_text_zh` | 中文正文 |
| `translation_status` | `none` / `pending` / `success` / `failed` / `skipped` |
| `translation_segments` | `[{en,zh,tag}]` 段落对照 |
| `translation_source_hash` | 原文 hash；正文重抓后清空译文 |

- **自动**：Feed `needs_translation` 且已配置翻译 API，打开「正文」且尚无中文 → `POST .../fulltext/translate`（`auto:true`）
- **手动**：面板「翻译正文 / 重新翻译」
- **展示**（`reader.fulltext.viewMode`）：`zh` 仅中文 · `stacked` 上英下中 · `parallel` 段落对照
- **切分**：HTML 块（`p/h2/h3/li/blockquote`），调用用户级 `textTranslateEnToZh`
- 实现：[`fulltextTranslate.ts`](../backend/src/services/fulltext/fulltextTranslate.ts)

## 非目标（本轮）

- 按站 CSS 选择器库
- 正文级 AI 重摘要 / 句子级对齐
- 爬虫事务内同步抓正文
- 物理删除已抓正文（星级下降不删）
- 正文翻译后台队列（量大后再迁 Bull）

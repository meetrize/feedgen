# FeedGen 规则导入 / 导出

导出与导入**私有源配置**（原生 RSS + 可视化爬虫规则），采用本应用专有格式 `feedgen-rules`，覆盖代理、图标、分组、爬虫策略等扩展字段。不含文章内容与爬取历史。

## 规则包格式（feedgen-rules）

- 推荐文件名：`*.feedgen.json`（亦接受 `.json`）
- 顶层字段：

| 字段 | 说明 |
|------|------|
| `format` | 固定 `feedgen-rules` |
| `version` | 当前为 `1` |
| `exported_at` | ISO 时间 |
| `app` | 固定 `feedgen` |
| `include_secrets` | 导出时是否包含 Cookie |
| `groups` | `{ name, icon }` 分组列表 |
| `feeds` | 规则条目数组 |

### 每条 feed 字段

| 字段 | 说明 |
|------|------|
| `kind` / `source_type` | `native`（RSS）或 `parsed`（爬虫规则） |
| `title` / `description` / `url` | 基础信息 |
| `feed_type` | 如 `rss` |
| `update_interval` | 秒 |
| `use_proxy` | 是否走代理 |
| `needs_translation` | 是否自动翻译 |
| `favicon_url` / `favicon_custom_text` / `favicon_custom_bg` | 图标 |
| `is_active` | 是否启用 |
| `group_name` | 所属分组名 |
| `sort_order` | 排序 |
| `selector_rules` | parsed 源的选择器规则（visual / legacy） |
| `auth_cookie` | 可选；默认导出不含 |
| `crawler_strategy` | `{ strategy_mode, min_interval, max_interval, failure_threshold, auto_disable_enabled, note }` |

## API

需登录（`Authorization: Bearer <token>`）。

### 导出

`GET /api/feeds/rules/export`

Query：

- `include_secrets=0|1`（默认 0）
- `feed_ids=1,2,3`（可选，选中导出）
- `source_types=native,parsed`（可选）

响应为规则包 JSON，并带下载用 `Content-Disposition`。

### 导入

`POST /api/feeds/rules/import`

Body：

```json
{
  "bundle": { "format": "feedgen-rules", "version": 1, "feeds": [], "groups": [] },
  "include_secrets": false,
  "on_duplicate": "replace"
}
```

也可直接 POST 规则包本体；此时用 query `include_secrets` / `on_duplicate` 控制行为。

**指纹匹配：** URL + `source_type` + 规范化 `selector_rules`（比对时忽略 Cookie）。

**`on_duplicate` 冲突策略：**

| 值 | 行为 |
|----|------|
| `replace`（默认） | 覆盖可移植字段（标题、间隔、规则、代理、图标、分组、策略等），不改文章与反爬运行时状态 |
| `skip` | 跳过已存在条目 |
| `create_new` | 仍创建为新源（允许重复） |

响应报告：`created` / `updated` / `skipped` / `failed` / `groups_created` / `on_duplicate` / `details[]`。

## 前端入口

- [我的 feeds](../frontend/my-feeds.html)：顶部 **导出规则** / **导入规则**；表格可勾选后「仅选中导出」
- [设置 → 订阅设置](../frontend/settings.html)：同等能力

# Feed 规则导入 / 导出

导出与导入**私有源配置**（原生 RSS + 可视化爬虫规则），不含文章内容与爬取历史。

## 规则包格式

- 文件：`.json` / `.feedgen.json`
- 顶层字段：

| 字段 | 说明 |
|------|------|
| `format` | 固定 `feedgen-rules` |
| `version` | 当前为 `1` |
| `include_secrets` | 导出时是否包含 Cookie |
| `groups` | `{ name, icon }` 分组列表 |
| `feeds` | 规则条目数组 |

每条 feed 含：`title`、`url`、`source_type`（`native` / `parsed`）、`selector_rules`（parsed）、`update_interval`、`group_name`、`crawler_strategy` 等。默认不含 `auth_cookie`。

## API

需登录（`Authorization: Bearer <token>`）。

### 导出

`GET /api/feeds/rules/export`

Query：

- `include_secrets=0|1`（默认 0）
- `feed_ids=1,2,3`（可选）
- `source_types=native,parsed`（可选）

响应为规则包 JSON，并带下载用 `Content-Disposition`。

### 导入

`POST /api/feeds/rules/import`

Body：

```json
{
  "bundle": { "format": "feedgen-rules", "version": 1, "feeds": [], "groups": [] },
  "include_secrets": false
}
```

也可直接 POST 规则包本体；此时用 query `include_secrets=1` 控制是否写入 Cookie。

**冲突策略：** 按源指纹（URL + 类型 + 规范化 selector_rules，比对时忽略 Cookie）匹配当前用户私有源：

- 已存在 → **覆盖**可移植字段（标题、间隔、规则、分组、策略等），不改文章与反爬运行时状态
- 不存在 → **新建**（不自动触发首爬）

响应报告：`created` / `updated` / `failed` / `groups_created` / `details[]`。

## 前端入口

[我的 feeds](../frontend/my-feeds.html) 页顶部：**导出规则** / **导入规则**。

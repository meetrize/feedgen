# 文章自动刷新通知

> 目标：阅读器自动刷新发现新文章时，以不打断浏览的方式提示「N 条新文章」，并在 MeoBrowser 中可弹出 macOS 系统通知。  
> 状态：设计已定；实现见本文验收清单。  
> 关联：MeoBrowser [`docs/minimal-browser/page-notification-bridge-design.md`](/www/wwwroot/meobrowser/meobrowser/docs/minimal-browser/page-notification-bridge-design.md)

---

## 1. 产品行为

| 项 | 决定 |
|----|------|
| 触发 | 仅**自动刷新**且 `newCount > 0`；手动刷新不弹 |
| 页内 | 上方工具栏正中气泡 `#reader-refresh-toast`，约 2s 淡出，`pointer-events: none` |
| 声音 | 保留现有 `playReaderRefreshSound` |
| 系统通知 | 存在 `webkit.messageHandlers.meoPageNotify` 时额外投递；否则静默跳过 |
| 文案 | 首行「N 条新文章」，其后每条新标题各占一行（页内 toast 与系统通知相同） |

不与复制标题用的居中 `#copy-toast` 共用 DOM，避免互相抢占。

---

## 2. 刷新与计数

自动刷新路径（既有）：

```
scheduleReaderAutoRefresh
  → performReaderDataRefresh({ silent: true, playSound: true })
       → snapshot → loadArticles / refreshBulletinCards
       → countNewArticlesSince → notifyReaderRefresh
```

### 2.1 `collectNewArticlesSince(prevSnapshot, prevTotal)` → `{ count, titles }`

| 模式 | 规则 |
|------|------|
| 列表 | `count = max(totalDelta, idDelta, titles.length)`；`titles` 为当前页 id ∉ prevSnapshot 的展示标题 |
| 快讯 | id 差集；标题取自板报 DOM `.bulletin-feed-article-title` |
| 无新文 | `count === 0` → 不 toast、不系统通知、不响铃 |

通知正文：`N 条新文章` + 换行 + 每条标题一行。若 `count > titles.length`（部分新文不在本页），末行附「…另有 M 条未在本页」。

Toast 展示时长随行数加长（约 2.5～8s）。

---

## 3. 页内 Toast

- 元素：`#reader-refresh-toast`（按需创建，挂到 `.article-reader-content-head`）
- 位置：工具栏行水平/垂直居中（`left/top: 50%` + `translate(-50%, -50%)`）
- 样式：深底白字；`white-space: pre-line` 支持多行标题
- 时长：随行数约 2.5～8s
- 入口：`showRefreshToast(message)`

---

## 4. MeoBrowser 桥客户端

```js
function tryMeoPageNotify(opts) {
  var handler = window.webkit
    && window.webkit.messageHandlers
    && window.webkit.messageHandlers.meoPageNotify;
  if (!handler || typeof handler.postMessage !== 'function') return false;
  try {
    handler.postMessage({
      type: 'notify',
      title: opts.title || 'FeedGen',
      body: opts.body || '',
      tag: opts.tag || 'feedgen-refresh',
      count: opts.count || 0
    });
    return true;
  } catch (e) {
    return false;
  }
}
```

`notifyReaderRefresh(newCount)`：

1. `showRefreshToast(newCount + ' 条新文章')`
2. `tryMeoPageNotify({ title: 'FeedGen', body: ..., tag: 'feedgen-refresh', count })`
3. `playReaderRefreshSound()`

任意浏览器可验收 toast；仅 MeoBrowser 有系统通知。

非 `localhost` / `127.0.0.1` 部署时，需在 MeoBrowser 的 `NSUserDefaults` 键 `PageNotifyAllowedHosts` 中加入 feedgen 主机名（字符串数组），例如 `defaults write … PageNotifyAllowedHosts -array your.feedgen.host`。

---

## 5. 改动文件

| 文件 | 改动 |
|------|------|
| `frontend/article-reader.js` | 计数、toast、桥客户端、刷新路径接线 |
| `frontend/styles.css` | `#reader-refresh-toast` 样式 |

后端 API 无需变更。

---

## 6. 验收清单

- [ ] 自动刷新且有新文：上方工具栏正中出现「N 条新文章」及各标题（每行一条），随后消失，可同时听到提示音
- [ ] 自动刷新无新文：无 toast、无音
- [ ] 手动刷新：无 toast（即使有新文）
- [ ] 复制标题 toast 与刷新 toast 互不干扰
- [ ] Safari / Chrome：仅页内 toast
- [ ] MeoBrowser + 已授权通知 + 主机在允许列表：额外出现 macOS 系统通知
- [ ] 快讯模式同样按 id 差集计数并提示

# 金融产品标签 — 分步 AI 开发提示词

设计文档：[FINANCE_PRODUCT_TAGS.md](./FINANCE_PRODUCT_TAGS.md)

**全程约束**

- 系统级词典，不写入 `user_tags` / 不污染 `articles` 列
- 主源 stock-sdk，补源 yfinance
- 运维：`feedgen restart backend`
- 路由前缀：`/api/admin/finance`

---

## 步骤 0：设计文档

已交付：`docs/FINANCE_PRODUCT_TAGS.md`、本文档。

---

## 步骤 1：Prisma 模型与 migration

新增表：`finance_instruments`、`finance_aliases`、`article_finance_instruments`、`finance_sync_jobs`、`finance_app_settings`。  
在 `Article` 增加 `finance_instruments` 关系。

验收：`npx prisma migrate deploy` + `db:generate` 成功。

---

## 步骤 2：词典同步（stock-sdk）

实现 `FinanceDictSyncService`、`chart_symbol` 映射、同步 job 记录。  
依赖：`npm i stock-sdk`。

---

## 步骤 3：匹配引擎 + 队列

AC 索引、`FinanceMatchService`、Bull `finance-match` / `finance-sync`、爬虫入库 enqueue。

---

## 步骤 4：Admin API + 面板

`finance-admin.ts`、`admin-finance.js`、`#panel-finance`。

---

## 步骤 5：阅读器 chip

文章列表 `finance_instruments`、`.finance-chip`、点击打开 K 线。

---

## 步骤 6：yfinance 补源

`scripts/yfinance_sync.py` + Sync 合并逻辑。

---

## 步骤 7：运维文档

`SERVICE.md` 环境变量与依赖说明；定时同步启动。

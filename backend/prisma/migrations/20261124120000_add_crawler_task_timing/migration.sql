-- 可视化爬虫排队 / 执行耗时拆分，便于区分「假慢」与真实抓取时间
ALTER TABLE "crawler_task_histories"
  ADD COLUMN IF NOT EXISTS "queue_wait_ms" INTEGER,
  ADD COLUMN IF NOT EXISTS "execute_ms" INTEGER;

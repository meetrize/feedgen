-- 爬虫任务执行历史（调度器 / 队列落库，供管理后台查看）
CREATE TABLE "crawler_task_histories" (
  "id" SERIAL NOT NULL,
  "feed_id" INTEGER NOT NULL,
  "mode" VARCHAR(32) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "started_at" TIMESTAMP(6) NOT NULL,
  "finished_at" TIMESTAMP(6),
  "duration_ms" INTEGER,
  "new_articles_count" INTEGER NOT NULL DEFAULT 0,
  "error_message" TEXT,
  CONSTRAINT "crawler_task_histories_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_crawler_task_histories_feed_started"
  ON "crawler_task_histories"("feed_id", "started_at" DESC);

CREATE INDEX "idx_crawler_task_histories_started_at"
  ON "crawler_task_histories"("started_at" DESC);

ALTER TABLE "crawler_task_histories"
  ADD CONSTRAINT "crawler_task_histories_feed_id_fkey"
  FOREIGN KEY ("feed_id") REFERENCES "feeds"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

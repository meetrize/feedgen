-- Article duplicate fields
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "title_norm" VARCHAR(500);
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "title_simhash" BIGINT;
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "dup_cluster_id" INTEGER;
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "dup_is_primary" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "dup_checked_at" TIMESTAMP(6);

CREATE INDEX IF NOT EXISTS "idx_articles_dup_checked" ON "articles"("dup_checked_at");
CREATE INDEX IF NOT EXISTS "idx_articles_dup_cluster" ON "articles"("dup_cluster_id");
CREATE INDEX IF NOT EXISTS "idx_articles_title_norm_pub" ON "articles"("title_norm", "pub_date");
CREATE INDEX IF NOT EXISTS "idx_articles_title_simhash" ON "articles"("title_simhash");

CREATE TABLE IF NOT EXISTS "article_dup_clusters" (
  "id" SERIAL NOT NULL,
  "run_day" DATE NOT NULL,
  "primary_article_id" INTEGER NOT NULL,
  "member_count" INTEGER NOT NULL DEFAULT 1,
  "sample_title" VARCHAR(500) NOT NULL,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "article_dup_clusters_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_article_dup_clusters_day_count"
  ON "article_dup_clusters"("run_day", "member_count" DESC);
CREATE INDEX IF NOT EXISTS "idx_article_dup_clusters_primary"
  ON "article_dup_clusters"("primary_article_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'articles_dup_cluster_id_fkey'
  ) THEN
    ALTER TABLE "articles"
      ADD CONSTRAINT "articles_dup_cluster_id_fkey"
      FOREIGN KEY ("dup_cluster_id") REFERENCES "article_dup_clusters"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "system_jobs" (
  "id" SERIAL NOT NULL,
  "key" VARCHAR(64) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "description" VARCHAR(500),
  "cron" VARCHAR(64) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "queue_name" VARCHAR(80),
  "config" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "system_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "system_jobs_key_key" UNIQUE ("key")
);

CREATE TABLE IF NOT EXISTS "system_job_runs" (
  "id" SERIAL NOT NULL,
  "job_key" VARCHAR(64) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "progress" INTEGER NOT NULL DEFAULT 0,
  "progress_text" VARCHAR(255),
  "started_at" TIMESTAMP(6),
  "finished_at" TIMESTAMP(6),
  "error" TEXT,
  "stats" JSONB,
  "triggered_by" VARCHAR(32) NOT NULL DEFAULT 'cron',
  "bull_job_id" VARCHAR(80),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "system_job_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_system_job_runs_job_created"
  ON "system_job_runs"("job_key", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_system_job_runs_status"
  ON "system_job_runs"("status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'system_job_runs_job_key_fkey'
  ) THEN
    ALTER TABLE "system_job_runs"
      ADD CONSTRAINT "system_job_runs_job_key_fkey"
      FOREIGN KEY ("job_key") REFERENCES "system_jobs"("key")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

INSERT INTO "system_jobs" ("key", "name", "description", "cron", "enabled", "queue_name", "config")
VALUES (
  'dedup.daily',
  '文章标题查重（按日）',
  '异步扫描当日文章近重复标题，标记转载簇；不影响爬虫主路径',
  '15 */2 * * *',
  true,
  'dedup-queue',
  '{"hammingMax":3,"jaccardMin":0.88,"forceRebuild":false}'::jsonb
)
ON CONFLICT ("key") DO NOTHING;

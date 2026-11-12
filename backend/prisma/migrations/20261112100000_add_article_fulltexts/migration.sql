-- Article fulltext status pointer
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "fulltext_status" VARCHAR(32);
CREATE INDEX IF NOT EXISTS "idx_articles_fulltext_status" ON "articles"("fulltext_status");

CREATE TABLE IF NOT EXISTS "article_fulltexts" (
  "article_id" INTEGER NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "body_html" TEXT,
  "body_text" TEXT,
  "word_count" INTEGER NOT NULL DEFAULT 0,
  "byte_size" INTEGER NOT NULL DEFAULT 0,
  "extractor" VARCHAR(40),
  "http_status" INTEGER,
  "final_url" VARCHAR(1000),
  "error" TEXT,
  "fetched_at" TIMESTAMP(6),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "article_fulltexts_pkey" PRIMARY KEY ("article_id")
);

CREATE INDEX IF NOT EXISTS "idx_article_fulltexts_status_updated"
  ON "article_fulltexts"("status", "updated_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'article_fulltexts_article_id_fkey'
  ) THEN
    ALTER TABLE "article_fulltexts"
      ADD CONSTRAINT "article_fulltexts_article_id_fkey"
      FOREIGN KEY ("article_id") REFERENCES "articles"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

INSERT INTO "system_jobs" ("key", "name", "description", "cron", "enabled", "queue_name", "config")
VALUES (
  'fulltext.fetch',
  '原文正文抓取',
  '重要度达标后异步抓取原文正文；定时补扫积压',
  '40 */3 * * *',
  true,
  'fulltext-queue',
  '{"enabled":true,"minStars":2,"maxBytes":500000,"minTextLength":200,"usePlaywrightFallback":true,"concurrency":3,"retryFailedDays":3,"backfillLimit":80}'::jsonb
)
ON CONFLICT ("key") DO NOTHING;

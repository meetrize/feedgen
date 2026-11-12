-- 正文中文翻译字段（挂在 article_fulltexts，1:1）
ALTER TABLE "article_fulltexts"
  ADD COLUMN IF NOT EXISTS "body_html_zh" TEXT,
  ADD COLUMN IF NOT EXISTS "body_text_zh" TEXT,
  ADD COLUMN IF NOT EXISTS "translation_status" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "translation_error" TEXT,
  ADD COLUMN IF NOT EXISTS "translated_at" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "translation_source_hash" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "translation_segments" JSONB;

CREATE INDEX IF NOT EXISTS "idx_article_fulltexts_translation_status"
  ON "article_fulltexts"("translation_status");

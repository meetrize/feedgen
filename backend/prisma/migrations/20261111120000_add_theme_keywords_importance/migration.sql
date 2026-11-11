-- 主题重要程度（1–5），默认 3
ALTER TABLE "user_tags"
  ADD COLUMN IF NOT EXISTS "importance" INTEGER NOT NULL DEFAULT 3;

UPDATE "user_tags"
  SET "importance" = 3
  WHERE "importance" IS NULL OR "importance" < 1 OR "importance" > 5;

ALTER TABLE "user_tags"
  ADD CONSTRAINT "user_tags_importance_check"
  CHECK ("importance" >= 1 AND "importance" <= 5);

-- 主题关联关键词
CREATE TABLE IF NOT EXISTS "user_tag_keywords" (
  "id" SERIAL NOT NULL,
  "tag_id" INTEGER NOT NULL,
  "keyword" VARCHAR(80) NOT NULL,
  "keyword_norm" VARCHAR(80) NOT NULL,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_tag_keywords_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ux_user_tag_keywords_tag_norm"
  ON "user_tag_keywords"("tag_id", "keyword_norm");

CREATE INDEX IF NOT EXISTS "idx_user_tag_keywords_tag"
  ON "user_tag_keywords"("tag_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_tag_keywords_tag_id_fkey'
  ) THEN
    ALTER TABLE "user_tag_keywords"
      ADD CONSTRAINT "user_tag_keywords_tag_id_fkey"
      FOREIGN KEY ("tag_id") REFERENCES "user_tags"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

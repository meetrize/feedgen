-- Feed 列表排序：数值越小越靠前
ALTER TABLE "feeds" ADD COLUMN IF NOT EXISTS "sort_order" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "idx_feeds_user_sort_order" ON "feeds"("user_id", "sort_order");

-- 按当前展示习惯回填：同一用户内 created_at 越新 sort_order 越小（排在前面）
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY created_at DESC NULLS LAST, id DESC
    ) - 1 AS rn
  FROM "feeds"
)
UPDATE "feeds" AS f
SET "sort_order" = ranked.rn
FROM ranked
WHERE f.id = ranked.id;

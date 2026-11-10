-- 分组显示顺序：数值越小越靠前
ALTER TABLE "user_feed_groups" ADD COLUMN IF NOT EXISTS "sort_order" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "idx_user_feed_groups_user_sort_order"
  ON "user_feed_groups"("user_id", "sort_order");

-- 按当前展示习惯回填：同一用户内 created_at 越早 sort_order 越小（排在前面）
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) - 1 AS rn
  FROM "user_feed_groups"
)
UPDATE "user_feed_groups" AS g
SET "sort_order" = ranked.rn
FROM ranked
WHERE g.id = ranked.id;

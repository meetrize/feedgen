-- feeds 新增来源类型和分组字段
ALTER TABLE "feeds" ADD COLUMN "source_type" VARCHAR(20) NOT NULL DEFAULT 'native';
ALTER TABLE "feeds" ADD COLUMN "group_id" INTEGER NULL;

CREATE INDEX "idx_feeds_source_type" ON "feeds"("source_type");
CREATE INDEX "idx_feeds_group_id" ON "feeds"("group_id");

ALTER TABLE "feeds"
  ADD CONSTRAINT "feeds_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "user_feed_groups"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

-- 删除用户订阅关系表（改为直接存入 feeds）
DROP TABLE IF EXISTS "user_feed_subscriptions";

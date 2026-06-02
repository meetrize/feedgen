-- 用户订阅分组表
CREATE TABLE "user_feed_groups" (
  "id" SERIAL NOT NULL,
  "user_id" INTEGER NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_feed_groups_pkey" PRIMARY KEY ("id")
);

-- 用户订阅关系表
CREATE TABLE "user_feed_subscriptions" (
  "id" SERIAL NOT NULL,
  "user_id" INTEGER NOT NULL,
  "feed_id" INTEGER NOT NULL,
  "group_id" INTEGER,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_feed_subscriptions_pkey" PRIMARY KEY ("id")
);

-- 唯一约束和索引
CREATE UNIQUE INDEX "ux_user_feed_groups_user_name"
  ON "user_feed_groups"("user_id", "name");
CREATE INDEX "idx_user_feed_groups_user_id"
  ON "user_feed_groups"("user_id");

CREATE UNIQUE INDEX "ux_user_feed_subscriptions_user_feed"
  ON "user_feed_subscriptions"("user_id", "feed_id");
CREATE INDEX "idx_user_feed_subscriptions_user_id"
  ON "user_feed_subscriptions"("user_id");
CREATE INDEX "idx_user_feed_subscriptions_group_id"
  ON "user_feed_subscriptions"("group_id");
CREATE INDEX "idx_user_feed_subscriptions_feed_id"
  ON "user_feed_subscriptions"("feed_id");

-- 外键约束
ALTER TABLE "user_feed_groups"
  ADD CONSTRAINT "user_feed_groups_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "user_feed_subscriptions"
  ADD CONSTRAINT "user_feed_subscriptions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "user_feed_subscriptions"
  ADD CONSTRAINT "user_feed_subscriptions_feed_id_fkey"
  FOREIGN KEY ("feed_id") REFERENCES "feeds"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "user_feed_subscriptions"
  ADD CONSTRAINT "user_feed_subscriptions_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "user_feed_groups"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

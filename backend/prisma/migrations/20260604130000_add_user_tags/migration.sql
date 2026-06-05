-- 用户文章标签词汇表
CREATE TABLE "user_tags" (
  "id" SERIAL NOT NULL,
  "user_id" INTEGER NOT NULL,
  "name" VARCHAR(50) NOT NULL,
  "slug" VARCHAR(60),
  "color" VARCHAR(16),
  "icon" VARCHAR(50),
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_tags_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_user_tags_user_name"
  ON "user_tags"("user_id", "name");

CREATE INDEX "idx_user_tags_user_sort"
  ON "user_tags"("user_id", "sort_order");

ALTER TABLE "user_tags"
  ADD CONSTRAINT "user_tags_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- 用户文章与标签关联
CREATE TABLE "user_article_tags" (
  "user_id" INTEGER NOT NULL,
  "article_id" INTEGER NOT NULL,
  "tag_id" INTEGER NOT NULL,
  "source" VARCHAR(20) NOT NULL DEFAULT 'manual',
  "tagged_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_article_tags_pkey" PRIMARY KEY ("user_id", "article_id", "tag_id")
);

CREATE INDEX "idx_user_article_tags_user_tag_time"
  ON "user_article_tags"("user_id", "tag_id", "tagged_at" DESC);

CREATE INDEX "idx_user_article_tags_user_article"
  ON "user_article_tags"("user_id", "article_id");

ALTER TABLE "user_article_tags"
  ADD CONSTRAINT "user_article_tags_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "user_article_tags"
  ADD CONSTRAINT "user_article_tags_article_id_fkey"
  FOREIGN KEY ("article_id") REFERENCES "articles"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "user_article_tags"
  ADD CONSTRAINT "user_article_tags_tag_id_fkey"
  FOREIGN KEY ("tag_id") REFERENCES "user_tags"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

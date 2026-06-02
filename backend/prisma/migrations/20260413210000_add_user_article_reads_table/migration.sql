-- 用户文章已读关系表（按 user_id + article_id 去重）
CREATE TABLE "user_article_reads" (
  "user_id" INTEGER NOT NULL,
  "article_id" INTEGER NOT NULL,
  "read_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_article_reads_pkey" PRIMARY KEY ("user_id", "article_id")
);

-- 已读记录查询索引（用于按用户查询最近已读）
CREATE INDEX "idx_user_article_reads_user_read_at"
  ON "user_article_reads"("user_id", "read_at" DESC);

-- 外键约束（随用户/文章删除级联清理）
ALTER TABLE "user_article_reads"
  ADD CONSTRAINT "user_article_reads_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "user_article_reads"
  ADD CONSTRAINT "user_article_reads_article_id_fkey"
  FOREIGN KEY ("article_id") REFERENCES "articles"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- 文章列表查询索引（按 feed 拉取并按发布时间排序）
CREATE INDEX "idx_articles_feed_pub_date_id"
  ON "articles"("feed_id", "pub_date" DESC, "id" DESC);

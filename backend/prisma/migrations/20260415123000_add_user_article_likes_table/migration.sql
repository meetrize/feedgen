-- 用户文章喜欢关系表（按 user_id + article_id 去重）
CREATE TABLE "user_article_likes" (
  "user_id" INTEGER NOT NULL,
  "article_id" INTEGER NOT NULL,
  "liked_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_article_likes_pkey" PRIMARY KEY ("user_id", "article_id")
);

-- 喜欢记录查询索引（用于按用户查询最近喜欢）
CREATE INDEX "idx_user_article_likes_user_liked_at"
  ON "user_article_likes"("user_id", "liked_at" DESC);

-- 外键约束（随用户/文章删除级联清理）
ALTER TABLE "user_article_likes"
  ADD CONSTRAINT "user_article_likes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "user_article_likes"
  ADD CONSTRAINT "user_article_likes_article_id_fkey"
  FOREIGN KEY ("article_id") REFERENCES "articles"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

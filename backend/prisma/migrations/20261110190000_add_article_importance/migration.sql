-- 文章重要度评分（系统级，1–5 星）
CREATE TABLE "article_importance" (
  "id" SERIAL NOT NULL,
  "article_id" INTEGER NOT NULL,
  "stars" INTEGER NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "factors" JSONB,
  "model_version" VARCHAR(32),
  "scored_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "article_importance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "article_importance_article_id_key"
  ON "article_importance"("article_id");

CREATE INDEX "idx_article_importance_stars_scored"
  ON "article_importance"("stars", "scored_at" DESC);

CREATE INDEX "idx_article_importance_score"
  ON "article_importance"("score" DESC);

ALTER TABLE "article_importance"
  ADD CONSTRAINT "article_importance_article_id_fkey"
  FOREIGN KEY ("article_id") REFERENCES "articles"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- 信源权威权重（按域名或 Feed）
CREATE TABLE "importance_source_weights" (
  "id" SERIAL NOT NULL,
  "host" VARCHAR(255),
  "feed_id" INTEGER,
  "weight" DOUBLE PRECISION NOT NULL DEFAULT 50,
  "note" VARCHAR(255),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "importance_source_weights_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_importance_source_weights_host"
  ON "importance_source_weights"("host");

CREATE UNIQUE INDEX "ux_importance_source_weights_feed"
  ON "importance_source_weights"("feed_id");

CREATE INDEX "idx_importance_source_weights_weight"
  ON "importance_source_weights"("weight");

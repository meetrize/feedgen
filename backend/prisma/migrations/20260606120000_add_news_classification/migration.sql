-- 新闻主题类别（系统级，Admin 管理）
CREATE TABLE "news_categories" (
  "id" SERIAL NOT NULL,
  "code" VARCHAR(64) NOT NULL,
  "name" VARCHAR(128) NOT NULL,
  "description" TEXT,
  "color" VARCHAR(16),
  "status" VARCHAR(16) NOT NULL DEFAULT 'active',
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "news_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "news_categories_code_key"
  ON "news_categories"("code");

CREATE INDEX "idx_news_categories_status_sort"
  ON "news_categories"("status", "sort_order");

-- 类别示例标题（冷启动）
CREATE TABLE "news_category_examples" (
  "id" SERIAL NOT NULL,
  "category_id" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "news_category_examples_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_news_category_examples_category"
  ON "news_category_examples"("category_id");

ALTER TABLE "news_category_examples"
  ADD CONSTRAINT "news_category_examples_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "news_categories"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- 类别原型向量（冷启动兜底）
CREATE TABLE "news_category_prototypes" (
  "id" SERIAL NOT NULL,
  "category_id" INTEGER NOT NULL,
  "embedding" BYTEA NOT NULL,
  "example_count" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "news_category_prototypes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "news_category_prototypes_category_id_key"
  ON "news_category_prototypes"("category_id");

ALTER TABLE "news_category_prototypes"
  ADD CONSTRAINT "news_category_prototypes_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "news_categories"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- 文章 AI 分类结果（每篇文章保留最新一条）
CREATE TABLE "article_classifications" (
  "id" SERIAL NOT NULL,
  "article_id" INTEGER NOT NULL,
  "category_id" INTEGER,
  "confidence" DOUBLE PRECISION,
  "model_version" VARCHAR(32),
  "need_review" BOOLEAN NOT NULL DEFAULT false,
  "classified_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "article_classifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "article_classifications_article_id_key"
  ON "article_classifications"("article_id");

CREATE INDEX "idx_article_classifications_category"
  ON "article_classifications"("category_id");

CREATE INDEX "idx_article_classifications_review"
  ON "article_classifications"("need_review", "classified_at" DESC);

ALTER TABLE "article_classifications"
  ADD CONSTRAINT "article_classifications_article_id_fkey"
  FOREIGN KEY ("article_id") REFERENCES "articles"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "article_classifications"
  ADD CONSTRAINT "article_classifications_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "news_categories"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

-- 人工标注记录（训练数据核心）
CREATE TABLE "classification_annotations" (
  "id" SERIAL NOT NULL,
  "article_id" INTEGER NOT NULL,
  "category_id" INTEGER NOT NULL,
  "labeled_by" INTEGER,
  "source" VARCHAR(20) NOT NULL DEFAULT 'manual',
  "model_version" VARCHAR(32),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "classification_annotations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_classification_annotations_category"
  ON "classification_annotations"("category_id");

CREATE INDEX "idx_classification_annotations_article"
  ON "classification_annotations"("article_id", "created_at" DESC);

ALTER TABLE "classification_annotations"
  ADD CONSTRAINT "classification_annotations_article_id_fkey"
  FOREIGN KEY ("article_id") REFERENCES "articles"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "classification_annotations"
  ADD CONSTRAINT "classification_annotations_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "news_categories"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "classification_annotations"
  ADD CONSTRAINT "classification_annotations_labeled_by_fkey"
  FOREIGN KEY ("labeled_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

-- 训练任务
CREATE TABLE "classification_training_jobs" (
  "id" SERIAL NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "stage" VARCHAR(32),
  "train_count" INTEGER,
  "val_count" INTEGER,
  "category_count" INTEGER,
  "trigger_reason" VARCHAR(128),
  "metrics_json" TEXT,
  "model_version" VARCHAR(32),
  "error_msg" TEXT,
  "started_at" TIMESTAMP(6),
  "finished_at" TIMESTAMP(6),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "classification_training_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_classification_training_jobs_status"
  ON "classification_training_jobs"("status", "created_at" DESC);

-- 模型版本
CREATE TABLE "classification_model_versions" (
  "id" SERIAL NOT NULL,
  "version" VARCHAR(32) NOT NULL,
  "path" TEXT NOT NULL,
  "metrics" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "classification_model_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "classification_model_versions_version_key"
  ON "classification_model_versions"("version");

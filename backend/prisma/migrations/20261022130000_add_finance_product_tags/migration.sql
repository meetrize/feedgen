-- 金融产品规范词典
CREATE TABLE "finance_instruments" (
  "id" SERIAL NOT NULL,
  "symbol" VARCHAR(64) NOT NULL,
  "chart_symbol" VARCHAR(64) NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "name_en" VARCHAR(255),
  "market" VARCHAR(16) NOT NULL,
  "asset_type" VARCHAR(16) NOT NULL DEFAULT 'stock',
  "exchange" VARCHAR(32),
  "currency" VARCHAR(8),
  "source" VARCHAR(32) NOT NULL DEFAULT 'stock_sdk',
  "status" VARCHAR(16) NOT NULL DEFAULT 'active',
  "priority" INTEGER NOT NULL DEFAULT 100,
  "meta" JSONB,
  "synced_at" TIMESTAMP(6),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "finance_instruments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_finance_instruments_market_symbol"
  ON "finance_instruments"("market", "symbol");

CREATE INDEX "idx_finance_instruments_status_market"
  ON "finance_instruments"("status", "market");

CREATE INDEX "idx_finance_instruments_asset_type"
  ON "finance_instruments"("asset_type");

-- 关键词别名
CREATE TABLE "finance_aliases" (
  "id" SERIAL NOT NULL,
  "instrument_id" INTEGER NOT NULL,
  "keyword" VARCHAR(255) NOT NULL,
  "keyword_norm" VARCHAR(255) NOT NULL,
  "kind" VARCHAR(16) NOT NULL DEFAULT 'alias',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "source" VARCHAR(16) NOT NULL DEFAULT 'auto',
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "finance_aliases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_finance_aliases_keyword_norm"
  ON "finance_aliases"("keyword_norm");

CREATE INDEX "idx_finance_aliases_instrument"
  ON "finance_aliases"("instrument_id");

CREATE INDEX "idx_finance_aliases_enabled"
  ON "finance_aliases"("enabled");

ALTER TABLE "finance_aliases"
  ADD CONSTRAINT "finance_aliases_instrument_id_fkey"
  FOREIGN KEY ("instrument_id") REFERENCES "finance_instruments"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- 文章与金融产品关联
CREATE TABLE "article_finance_instruments" (
  "article_id" INTEGER NOT NULL,
  "instrument_id" INTEGER NOT NULL,
  "matched_keyword" VARCHAR(255) NOT NULL,
  "matched_field" VARCHAR(32) NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "matched_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "article_finance_instruments_pkey" PRIMARY KEY ("article_id", "instrument_id")
);

CREATE INDEX "idx_article_finance_instruments_instrument"
  ON "article_finance_instruments"("instrument_id");

CREATE INDEX "idx_article_finance_instruments_article_time"
  ON "article_finance_instruments"("article_id", "matched_at" DESC);

ALTER TABLE "article_finance_instruments"
  ADD CONSTRAINT "article_finance_instruments_article_id_fkey"
  FOREIGN KEY ("article_id") REFERENCES "articles"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "article_finance_instruments"
  ADD CONSTRAINT "article_finance_instruments_instrument_id_fkey"
  FOREIGN KEY ("instrument_id") REFERENCES "finance_instruments"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- 同步任务
CREATE TABLE "finance_sync_jobs" (
  "id" SERIAL NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
  "mode" VARCHAR(16) NOT NULL DEFAULT 'full',
  "trigger" VARCHAR(16) NOT NULL DEFAULT 'manual',
  "source" VARCHAR(64),
  "fetched_count" INTEGER NOT NULL DEFAULT 0,
  "created_count" INTEGER NOT NULL DEFAULT 0,
  "updated_count" INTEGER NOT NULL DEFAULT 0,
  "disabled_count" INTEGER NOT NULL DEFAULT 0,
  "alias_count" INTEGER NOT NULL DEFAULT 0,
  "error_msg" TEXT,
  "started_at" TIMESTAMP(6),
  "finished_at" TIMESTAMP(6),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "finance_sync_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_finance_sync_jobs_status"
  ON "finance_sync_jobs"("status", "created_at" DESC);

-- 应用设置
CREATE TABLE "finance_app_settings" (
  "key" VARCHAR(64) NOT NULL,
  "value" TEXT NOT NULL,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "finance_app_settings_pkey" PRIMARY KEY ("key")
);

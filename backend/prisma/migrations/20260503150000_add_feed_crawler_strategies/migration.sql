CREATE TABLE IF NOT EXISTS "feed_crawler_strategies" (
    "id" SERIAL PRIMARY KEY,
    "feed_id" INTEGER NOT NULL UNIQUE,
    "strategy_mode" VARCHAR(32) NOT NULL DEFAULT 'auto',
    "recommended_interval" INTEGER,
    "min_interval" INTEGER NOT NULL DEFAULT 1800,
    "max_interval" INTEGER NOT NULL DEFAULT 86400,
    "cooldown_until" TIMESTAMP(6),
    "failure_threshold" INTEGER NOT NULL DEFAULT 3,
    "auto_disable_enabled" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "feed_crawler_strategies_feed_id_fkey" FOREIGN KEY ("feed_id") REFERENCES "feeds"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "idx_feed_crawler_strategies_cooldown_until" ON "feed_crawler_strategies"("cooldown_until");

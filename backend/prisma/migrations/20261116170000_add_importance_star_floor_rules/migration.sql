-- 重要度星级保底规则（可配置：政策/宏观/地缘/灾害等）
CREATE TABLE "importance_star_floor_rules" (
  "id" SERIAL NOT NULL,
  "rule_key" VARCHAR(64) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "description" VARCHAR(500),
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "floor_stars" INTEGER NOT NULL,
  "subject_keywords" JSONB NOT NULL DEFAULT '[]',
  "signal_keywords" JSONB NOT NULL DEFAULT '[]',
  "exclude_keywords" JSONB NOT NULL DEFAULT '[]',
  "skip_local_agency" BOOLEAN NOT NULL DEFAULT false,
  "sort_order" INTEGER NOT NULL DEFAULT 100,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "importance_star_floor_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "importance_star_floor_rules_floor_stars_check" CHECK ("floor_stars" >= 1 AND "floor_stars" <= 5)
);

CREATE UNIQUE INDEX "ux_importance_star_floor_rules_key"
  ON "importance_star_floor_rules"("rule_key");

CREATE INDEX "idx_importance_star_floor_rules_enabled_sort"
  ON "importance_star_floor_rules"("enabled", "sort_order");

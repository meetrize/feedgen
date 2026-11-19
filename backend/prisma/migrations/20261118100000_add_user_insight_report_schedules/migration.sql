CREATE TABLE IF NOT EXISTS "user_insight_report_schedules" (
  "id" SERIAL NOT NULL,
  "user_id" INTEGER NOT NULL,
  "recipe_id" INTEGER NOT NULL,
  "name" VARCHAR(80),
  "min_stars" INTEGER NOT NULL DEFAULT 3,
  "frequency" VARCHAR(16) NOT NULL,
  "weekday" INTEGER,
  "time_local" VARCHAR(5) NOT NULL,
  "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "last_run_at" TIMESTAMP(6),
  "last_status" VARCHAR(32),
  "last_error" TEXT,
  "last_run_id" INTEGER,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_insight_report_schedules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_insight_report_schedules_user_enabled"
  ON "user_insight_report_schedules"("user_id", "enabled");

CREATE INDEX IF NOT EXISTS "idx_insight_report_schedules_due"
  ON "user_insight_report_schedules"("enabled", "time_local");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_insight_report_schedules_user_id_fkey'
  ) THEN
    ALTER TABLE "user_insight_report_schedules"
      ADD CONSTRAINT "user_insight_report_schedules_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_insight_report_schedules_recipe_id_fkey'
  ) THEN
    ALTER TABLE "user_insight_report_schedules"
      ADD CONSTRAINT "user_insight_report_schedules_recipe_id_fkey"
      FOREIGN KEY ("recipe_id") REFERENCES "user_insight_recipes"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

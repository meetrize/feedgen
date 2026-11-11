CREATE TABLE IF NOT EXISTS "user_insight_recipe_runs" (
  "id" SERIAL NOT NULL,
  "user_id" INTEGER NOT NULL,
  "recipe_id" INTEGER NOT NULL,
  "scope_key" VARCHAR(191) NOT NULL,
  "scope_label" VARCHAR(255) NOT NULL,
  "run_day" DATE NOT NULL,
  "title_count" INTEGER NOT NULL DEFAULT 0,
  "content" TEXT NOT NULL,
  "model" VARCHAR(80),
  "prompt_version" VARCHAR(32),
  "recipe_name_snapshot" VARCHAR(80) NOT NULL,
  "input_fingerprint" VARCHAR(64),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_insight_recipe_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_insight_recipe_runs_lookup"
  ON "user_insight_recipe_runs"("user_id", "recipe_id", "scope_key", "run_day", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_insight_recipe_runs_user_created"
  ON "user_insight_recipe_runs"("user_id", "created_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_insight_recipe_runs_user_id_fkey'
  ) THEN
    ALTER TABLE "user_insight_recipe_runs"
      ADD CONSTRAINT "user_insight_recipe_runs_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_insight_recipe_runs_recipe_id_fkey'
  ) THEN
    ALTER TABLE "user_insight_recipe_runs"
      ADD CONSTRAINT "user_insight_recipe_runs_recipe_id_fkey"
      FOREIGN KEY ("recipe_id") REFERENCES "user_insight_recipes"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

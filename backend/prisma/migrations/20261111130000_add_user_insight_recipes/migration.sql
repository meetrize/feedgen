CREATE TABLE IF NOT EXISTS "user_insight_recipes" (
  "id" SERIAL NOT NULL,
  "user_id" INTEGER NOT NULL,
  "builtin_key" VARCHAR(32),
  "name" VARCHAR(80) NOT NULL,
  "description" VARCHAR(255),
  "icon" VARCHAR(50),
  "system_prompt" TEXT NOT NULL,
  "user_prompt_template" TEXT NOT NULL,
  "context_fields" JSONB NOT NULL DEFAULT '["title"]',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "is_builtin" BOOLEAN NOT NULL DEFAULT false,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_insight_recipes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ux_user_insight_recipes_user_builtin"
  ON "user_insight_recipes"("user_id", "builtin_key");

CREATE INDEX IF NOT EXISTS "idx_user_insight_recipes_user_sort"
  ON "user_insight_recipes"("user_id", "sort_order");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_insight_recipes_user_id_fkey'
  ) THEN
    ALTER TABLE "user_insight_recipes"
      ADD CONSTRAINT "user_insight_recipes_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

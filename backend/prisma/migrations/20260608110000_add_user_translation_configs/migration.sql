CREATE TABLE "user_translation_configs" (
  "user_id" INTEGER NOT NULL,
  "secret_id" VARCHAR(128) NOT NULL,
  "secret_key" VARCHAR(128) NOT NULL,
  "region" VARCHAR(32) NOT NULL DEFAULT 'ap-guangzhou',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_translation_configs_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "user_translation_configs"
  ADD CONSTRAINT "user_translation_configs_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

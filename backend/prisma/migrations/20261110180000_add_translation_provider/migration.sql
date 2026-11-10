ALTER TABLE "user_translation_configs"
  ADD COLUMN "provider" VARCHAR(32) NOT NULL DEFAULT 'tencent',
  ADD COLUMN "base_url" VARCHAR(500),
  ADD COLUMN "api_token" VARCHAR(256);

ALTER TABLE "user_translation_configs"
  ALTER COLUMN "secret_id" SET DEFAULT '',
  ALTER COLUMN "secret_key" SET DEFAULT '';

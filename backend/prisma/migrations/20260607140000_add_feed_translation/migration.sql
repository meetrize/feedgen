ALTER TABLE "feeds" ADD COLUMN "needs_translation" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "articles" ADD COLUMN "title_zh" VARCHAR(500);
ALTER TABLE "articles" ADD COLUMN "description_zh" TEXT;

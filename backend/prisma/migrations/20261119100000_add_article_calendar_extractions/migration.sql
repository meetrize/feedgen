-- CreateTable
CREATE TABLE "article_calendar_extractions" (
    "article_id" INTEGER NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "title_hit" BOOLEAN NOT NULL DEFAULT false,
    "had_body" BOOLEAN NOT NULL DEFAULT false,
    "events_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "content_fingerprint" VARCHAR(64),
    "processed_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_calendar_extractions_pkey" PRIMARY KEY ("article_id")
);

-- CreateIndex
CREATE INDEX "idx_article_calendar_extractions_status" ON "article_calendar_extractions"("status", "processed_at");

-- CreateIndex
CREATE INDEX "idx_articles_created_at" ON "articles"("created_at");

-- AddForeignKey
ALTER TABLE "article_calendar_extractions" ADD CONSTRAINT "article_calendar_extractions_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

import { getPrisma } from '../server';

/** 爬虫执行历史（crawler_task_histories），供调度器与 API 触发的爬取共用 */
export async function recordCrawlerTaskHistory(params: {
  feedId: number;
  mode: string;
  status: 'success' | 'failed' | 'skipped' | 'queued';
  startedAt: Date;
  /** 排队中可为 null（尚未结束） */
  finishedAt: Date | null;
  newArticlesCount?: number;
  errorMessage?: string | null;
}) {
  let err = params.errorMessage;
  if (err && err.length > 8000) {
    err = `${err.slice(0, 8000)}…`;
  }
  const duration_ms =
    params.finishedAt == null
      ? null
      : Math.max(0, params.finishedAt.getTime() - params.startedAt.getTime());

  const data = {
    feed_id: params.feedId,
    mode: params.mode,
    status: params.status,
    started_at: params.startedAt,
    finished_at: params.finishedAt,
    duration_ms,
    new_articles_count: params.newArticlesCount ?? 0,
    error_message: err ?? null,
  };

  try {
    const prisma = await getPrisma();
    await prisma.crawlerTaskHistory.create({ data });
  } catch (e) {
    console.error('[CrawlerTaskHistory] Prisma create 失败，尝试 SQL 回退:', e);
    try {
      const prisma = await getPrisma();
      await prisma.$executeRaw`
        INSERT INTO "crawler_task_histories" ("feed_id", "mode", "status", "started_at", "finished_at", "duration_ms", "new_articles_count", "error_message")
        VALUES (${data.feed_id}, ${data.mode}, ${data.status}, ${data.started_at}, ${data.finished_at}, ${data.duration_ms}, ${data.new_articles_count}, ${data.error_message})
      `;
    } catch (e2) {
      console.error('[CrawlerTaskHistory] SQL 回退仍失败:', e2);
    }
  }
}

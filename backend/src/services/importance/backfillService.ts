import { prisma } from '../../server';
import { isImportanceEnabled } from './importanceConfig';
import { scoreArticleImportance } from './scoringService';

export type FastBackfillOptions = {
  feed_id?: number;
  since?: string;
  only_unscored?: boolean;
  /** 单轮拉取条数，默认 2000 */
  batch_size?: number;
  /** 并行评分数，默认 12 */
  concurrency?: number;
  /** 最多处理条数，0/不传 = 不限制直到扫完 */
  max_total?: number;
  /** 历史回填默认跳过聚类以提速 */
  skip_cluster?: boolean;
  onProgress?: (p: {
    processed: number;
    succeeded: number;
    failed: number;
    batch: number;
  }) => void;
};

export type FastBackfillResult = {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: boolean;
  skip_cluster: boolean;
};

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) break;
      const item = items[i];
      if (item === undefined) break;
      results[i] = await worker(item, i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function fetchNextBatchIds(input: {
  feed_id?: number;
  since?: string;
  only_unscored: boolean;
  take: number;
  afterId?: number;
}): Promise<number[]> {
  const where: any = {};
  if (input.feed_id != null && Number.isFinite(input.feed_id)) {
    where.feed_id = input.feed_id;
  }
  if (input.since?.trim()) {
    const sinceDate = new Date(input.since.trim());
    if (!Number.isNaN(sinceDate.getTime())) {
      where.created_at = { gte: sinceDate };
    }
  }
  if (input.only_unscored) {
    where.importance = null;
  }
  if (input.afterId != null) {
    where.id = { ...(where.id || {}), lt: input.afterId };
  }

  const rows = await prisma.article.findMany({
    where,
    select: { id: true },
    orderBy: { id: 'desc' },
    take: input.take,
  });
  return rows.map((r: { id: number }) => r.id);
}

/**
 * 进程内高速回填：跳过跨源聚类（可选）、高并发、按批游标扫库。
 * 适合历史文章一次性打分；聚类可在 ML 可用后再精修。
 */
export async function runImportanceFastBackfill(
  options: FastBackfillOptions = {},
): Promise<FastBackfillResult> {
  if (!isImportanceEnabled()) {
    return { processed: 0, succeeded: 0, failed: 0, skipped: true, skip_cluster: true };
  }

  const onlyUnscored = options.only_unscored !== false;
  const skipCluster = options.skip_cluster !== false;
  const batchSize = Math.min(Math.max(Number(options.batch_size) || 2000, 50), 5000);
  const concurrency = Math.min(Math.max(Number(options.concurrency) || 12, 1), 32);
  const maxTotal = Math.max(Number(options.max_total) || 0, 0);

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let batch = 0;
  let afterId: number | undefined;

  while (true) {
    if (maxTotal > 0 && processed >= maxTotal) break;

    const take =
      maxTotal > 0 ? Math.min(batchSize, maxTotal - processed) : batchSize;
    const fetchOpts: {
      feed_id?: number;
      since?: string;
      only_unscored: boolean;
      take: number;
      afterId?: number;
    } = {
      only_unscored: onlyUnscored,
      take,
    };
    if (options.feed_id != null) fetchOpts.feed_id = options.feed_id;
    if (options.since) fetchOpts.since = options.since;
    if (afterId != null) fetchOpts.afterId = afterId;

    const ids = await fetchNextBatchIds(fetchOpts);
    if (!ids.length) break;

    batch += 1;
    afterId = ids[ids.length - 1];

    const outcomes = await mapPool(ids, concurrency, async (articleId) => {
      try {
        await scoreArticleImportance(articleId, { skipCluster });
        return true;
      } catch (error) {
        console.warn(
          `[ImportanceBackfill] 评分失败 articleId=${articleId}:`,
          error instanceof Error ? error.message : String(error),
        );
        return false;
      }
    });

    for (const ok of outcomes) {
      processed += 1;
      if (ok) succeeded += 1;
      else failed += 1;
    }

    options.onProgress?.({ processed, succeeded, failed, batch });
    console.log(
      `[ImportanceBackfill] batch=${batch} processed=${processed} ok=${succeeded} fail=${failed} concurrency=${concurrency} skipCluster=${skipCluster}`,
    );

    if (ids.length < take) break;
  }

  return { processed, succeeded, failed, skipped: false, skip_cluster: skipCluster };
}

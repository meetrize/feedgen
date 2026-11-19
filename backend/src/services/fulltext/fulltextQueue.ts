import Queue from 'bull';

import { prisma } from '../../server';
import {
  FULLTEXT_JOB_KEY,
  FULLTEXT_QUEUE_NAME,
  isFulltextEnvEnabled,
  parseFulltextConfig,
} from './fulltextConfig';
import {
  fetchArticleFulltextGuarded,
  getFulltextConfig,
  runFulltextBackfill,
  shouldEnqueueFulltext,
} from './fulltextService';

export type FulltextJobData =
  | { type: 'article'; articleId: number; force?: boolean }
  | { type: 'backfill'; runId: number };

const bullRedisOptions = { maxRetriesPerRequest: null };

let fulltextQueue: Queue.Queue<FulltextJobData>;
let isRedisAvailable = true;
let workerStarted = false;

try {
  fulltextQueue = new Queue<FulltextJobData>(
    FULLTEXT_QUEUE_NAME,
    process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    {
      redis: bullRedisOptions,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    },
  );

  let redisErrorLogged = false;
  fulltextQueue.on('error', (error: Error) => {
    const msg = error.message || '';
    if (
      msg.includes('max retries per request') ||
      msg.includes('MaxRetriesPerRequest') ||
      msg.includes('ECONNREFUSED')
    ) {
      isRedisAvailable = false;
      if (!redisErrorLogged) {
        console.warn('[FulltextQueue] Redis 不可用，正文抓取入队将跳过');
        redisErrorLogged = true;
      }
      return;
    }
    console.error('[FulltextQueue] 队列错误:', msg);
  });
} catch (error: unknown) {
  console.error(
    '[FulltextQueue] 初始化失败:',
    error instanceof Error ? error.message : String(error),
  );
  fulltextQueue = new Queue<FulltextJobData>(
    FULLTEXT_QUEUE_NAME,
    process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    { redis: bullRedisOptions },
  );
}

async function isRunCancelled(runId: number): Promise<boolean> {
  const run = await prisma.systemJobRun.findUnique({
    where: { id: runId },
    select: { status: true },
  });
  return run?.status === 'cancelled';
}

async function markRun(
  runId: number,
  data: {
    status?: string;
    progress?: number;
    progress_text?: string | null;
    started_at?: Date | null;
    finished_at?: Date | null;
    error?: string | null;
    stats?: object | null;
    bull_job_id?: string | null;
  },
) {
  await prisma.systemJobRun.update({
    where: { id: runId },
    data: data as any,
  });
}

export async function addFulltextJob(
  articleId: number,
  opts?: { force?: boolean; delayMs?: number },
): Promise<Queue.Job<FulltextJobData> | null> {
  if (!isFulltextEnvEnabled() || !isRedisAvailable) return null;
  if (!Number.isInteger(articleId) || articleId <= 0) return null;

  try {
    const payload: FulltextJobData = {
      type: 'article',
      articleId,
      ...(opts?.force ? { force: true } : {}),
    };
    const jobOpts: Queue.JobOptions = {
      jobId: `fulltext-article-${articleId}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: 100,
    };
    if (opts?.delayMs && opts.delayMs > 0) jobOpts.delay = opts.delayMs;
    return await fulltextQueue.add(payload, jobOpts);
  } catch (error) {
    // jobId 冲突时视为已在队列
    const msg = error instanceof Error ? error.message : String(error);
    if (/Job.*already exists|duplicate/i.test(msg)) return null;
    console.error(
      `[FulltextQueue] 入队失败 articleId=${articleId}:`,
      msg,
    );
    return null;
  }
}

/** 重要度评分完成后调用 */
export async function maybeEnqueueFulltextAfterScore(
  articleId: number,
  stars: number,
): Promise<void> {
  try {
    if (!isFulltextEnvEnabled() || !isRedisAvailable) return;
    const cfg = await getFulltextConfig();
    if (!(await shouldEnqueueFulltext(articleId, stars, cfg))) return;
    await addFulltextJob(articleId);
  } catch (error) {
    console.warn(
      `[FulltextQueue] 评分后入队失败 articleId=${articleId}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function enqueueFulltextBackfill(runId: number): Promise<Queue.Job<FulltextJobData> | null> {
  if (!isFulltextEnvEnabled() || !isRedisAvailable) return null;
  try {
    const jobRow = await prisma.systemJob.findUnique({
      where: { key: FULLTEXT_JOB_KEY },
      select: { config: true },
    });
    const cfg = parseFulltextConfig(jobRow?.config);
    const job = await fulltextQueue.add(
      { type: 'backfill', runId },
      {
        jobId: `fulltext-backfill-${runId}`,
        // Bull 层硬超时：略大于任务超时，兜底僵尸 active job
        timeout: cfg.jobTimeoutMs + 60_000,
        attempts: 1,
      },
    );
    await markRun(runId, { status: 'queued', bull_job_id: String(job.id) });
    return job;
  } catch (error) {
    await markRun(runId, {
      status: 'failed',
      finished_at: new Date(),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function cancelFulltextRun(runId: number): Promise<boolean> {
  const run = await prisma.systemJobRun.findUnique({ where: { id: runId } });
  if (!run) return false;
  if (run.status === 'success' || run.status === 'failed' || run.status === 'cancelled') {
    return false;
  }
  await markRun(runId, {
    status: 'cancelled',
    progress_text: '取消中…',
    finished_at: new Date(),
  });
  if (run.bull_job_id) {
    try {
      const job = await fulltextQueue.getJob(run.bull_job_id);
      if (job) {
        const state = await job.getState();
        if (state === 'waiting' || state === 'delayed') await job.remove();
      }
    } catch {
      /* ignore */
    }
  }
  return true;
}

/** 回收因进程重启/挂死留下的 running|queued 记录，以及过久的 pending 正文 */
export async function recoverStaleFulltextRuns(): Promise<number> {
  const jobRow = await prisma.systemJob.findUnique({
    where: { key: FULLTEXT_JOB_KEY },
    select: { config: true },
  });
  const cfg = parseFulltextConfig(jobRow?.config);
  const cutoff = new Date(Date.now() - cfg.staleRunMinutes * 60_000);

  const staleRuns = await prisma.systemJobRun.findMany({
    where: {
      job_key: FULLTEXT_JOB_KEY,
      status: { in: ['running', 'queued'] },
      OR: [
        { started_at: { lt: cutoff } },
        { AND: [{ started_at: null }, { created_at: { lt: cutoff } }] },
      ],
    },
    select: { id: true, status: true },
  });

  for (const run of staleRuns) {
    await markRun(run.id, {
      status: 'failed',
      finished_at: new Date(),
      progress_text: '超时中止（僵尸任务回收）',
      error: `超过 ${cfg.staleRunMinutes} 分钟仍为 ${run.status}，判定为进程中断或挂死`,
    });
  }

  // 正文一直 pending：抓取中途挂死
  const pendingCutoff = new Date(Date.now() - Math.max(cfg.articleTimeoutMs * 2, 5 * 60_000));
  const stalePendingRows = await prisma.articleFulltext.findMany({
    where: {
      status: 'pending',
      updated_at: { lt: pendingCutoff },
    },
    select: { article_id: true },
    take: 500,
  });
  const pendingIds = stalePendingRows.map((r: { article_id: number }) => r.article_id);
  if (pendingIds.length) {
    await prisma.articleFulltext.updateMany({
      where: { article_id: { in: pendingIds } },
      data: {
        status: 'failed',
        error: '抓取超时中止（pending 过久）',
        updated_at: new Date(),
      },
    });
    await prisma.article.updateMany({
      where: { id: { in: pendingIds } },
      data: { fulltext_status: 'failed', updated_at: new Date() },
    });
  }

  if (staleRuns.length || pendingIds.length) {
    console.warn(
      `[FulltextQueue] 回收僵尸：runs=${staleRuns.length} pendingArticles=${pendingIds.length}`,
    );
  }
  return staleRuns.length;
}

export function startFulltextWorker(): void {
  if (workerStarted) return;
  if (!isFulltextEnvEnabled()) {
    console.log('[FulltextQueue] worker disabled (FULLTEXT_ENABLED=0)');
    return;
  }
  workerStarted = true;

  // concurrency 在启动时取默认；运行时 config 仍作用于单任务逻辑
  const concurrency = Math.min(
    Math.max(Number(process.env.FULLTEXT_CONCURRENCY) || 3, 1),
    8,
  );

  void recoverStaleFulltextRuns().catch((err) => {
    console.warn(
      '[FulltextQueue] 僵尸回收失败:',
      err instanceof Error ? err.message : String(err),
    );
  });

  fulltextQueue.process(concurrency, async (job) => {
    const data = job.data;

    if (data.type === 'article') {
      const cfg = await getFulltextConfig();
      return fetchArticleFulltextGuarded(data.articleId, cfg, { force: !!data.force });
    }

    // backfill with system_job_runs progress
    const runId = data.runId;
    if (await isRunCancelled(runId)) return { cancelled: true };

    await markRun(runId, {
      status: 'running',
      started_at: new Date(),
      progress: 0,
      progress_text: '开始补扫',
    });

    const jobRow = await prisma.systemJob.findUnique({
      where: { key: FULLTEXT_JOB_KEY },
      select: { config: true },
    });
    const cfg = parseFulltextConfig(jobRow?.config);

    try {
      const result = await runFulltextBackfill({
        config: cfg,
        shouldCancel: () => isRunCancelled(runId),
        onProgress: async (p) => {
          if (await isRunCancelled(runId)) return;
          await markRun(runId, {
            progress: p.progress,
            progress_text: p.progressText,
            stats: p.stats,
          });
        },
      });

      if (result.cancelled || (await isRunCancelled(runId))) {
        await markRun(runId, {
          status: 'cancelled',
          finished_at: new Date(),
          progress_text: '已取消',
          stats: result,
        });
        return result;
      }

      if (result.timedOut) {
        await markRun(runId, {
          status: 'failed',
          progress: 100,
          progress_text: `任务超时（已处理 ${result.processed}/${result.total}）`,
          finished_at: new Date(),
          stats: result,
          error: `补扫超过 ${Math.round(cfg.jobTimeoutMs / 60000)} 分钟，已中止`,
        });
        return result;
      }

      await markRun(runId, {
        status: 'success',
        progress: 100,
        progress_text: '完成',
        finished_at: new Date(),
        stats: result,
        error: null,
      });
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await markRun(runId, {
        status: 'failed',
        finished_at: new Date(),
        error: msg,
        progress_text: '失败',
      });
      throw error;
    }
  });

  console.log(`[FulltextQueue] worker started (concurrency=${concurrency})`);
}

export function getFulltextQueue(): Queue.Queue<FulltextJobData> {
  return fulltextQueue;
}

export { FULLTEXT_JOB_KEY, FULLTEXT_QUEUE_NAME };

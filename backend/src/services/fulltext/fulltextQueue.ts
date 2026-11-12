import Queue from 'bull';

import { prisma } from '../../server';
import {
  FULLTEXT_JOB_KEY,
  FULLTEXT_QUEUE_NAME,
  isFulltextEnvEnabled,
  parseFulltextConfig,
} from './fulltextConfig';
import {
  fetchArticleFulltext,
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
    const job = await fulltextQueue.add(
      { type: 'backfill', runId },
      { jobId: `fulltext-backfill-${runId}` },
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

  fulltextQueue.process(concurrency, async (job) => {
    const data = job.data;

    if (data.type === 'article') {
      const result = await fetchArticleFulltext(data.articleId, {
        force: !!data.force,
      });
      return result;
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

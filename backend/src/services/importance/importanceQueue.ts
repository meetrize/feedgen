import Queue from 'bull';

import { isImportanceEnabled } from './importanceConfig';
import { scoreArticleImportance } from './scoringService';

export interface ImportanceJobData {
  articleId: number;
  skipCluster?: boolean;
}

const QUEUE_NAME = 'importance-queue';
const bullRedisOptions = { maxRetriesPerRequest: null };

let importanceQueue: Queue.Queue<ImportanceJobData>;
let isRedisAvailable = true;
let workerStarted = false;

try {
  importanceQueue = new Queue<ImportanceJobData>(
    QUEUE_NAME,
    process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    {
      redis: bullRedisOptions,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    },
  );

  let redisErrorLogged = false;
  importanceQueue.on('error', (error: Error) => {
    const msg = error.message || '';
    if (
      msg.includes('max retries per request') ||
      msg.includes('MaxRetriesPerRequest') ||
      msg.includes('ECONNREFUSED')
    ) {
      isRedisAvailable = false;
      if (!redisErrorLogged) {
        console.warn('[ImportanceQueue] Redis 不可用，重要度入队将跳过');
        redisErrorLogged = true;
      }
      return;
    }
    console.error('[ImportanceQueue] 队列错误:', msg);
  });
} catch (error: unknown) {
  console.error(
    '[ImportanceQueue] 初始化失败:',
    error instanceof Error ? error.message : String(error),
  );
  importanceQueue = new Queue<ImportanceJobData>(
    QUEUE_NAME,
    process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    { redis: bullRedisOptions },
  );
}

export async function addImportanceJob(
  articleId: number,
  opts?: { delayMs?: number; skipCluster?: boolean },
): Promise<Queue.Job<ImportanceJobData> | null> {
  if (!isImportanceEnabled()) return null;
  if (!isRedisAvailable) return null;
  if (!Number.isInteger(articleId) || articleId <= 0) return null;

  try {
    const data: ImportanceJobData = { articleId };
    if (opts?.skipCluster != null) data.skipCluster = !!opts.skipCluster;
    const jobOpts: Queue.JobOptions = {
      jobId: `importance-${articleId}-${Date.now()}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
    };
    if (opts?.delayMs && opts.delayMs > 0) jobOpts.delay = opts.delayMs;
    return await importanceQueue.add(data, jobOpts);
  } catch (error) {
    console.error(
      `[ImportanceQueue] 入队失败 articleId=${articleId}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

export async function enqueueImportanceBatch(
  articleIds: number[],
  opts?: { skipCluster?: boolean },
): Promise<{ enqueued: number }> {
  if (!isImportanceEnabled() || !isRedisAvailable) return { enqueued: 0 };
  const uniqueIds = [...new Set(articleIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (!uniqueIds.length) return { enqueued: 0 };

  try {
    const jobs = await importanceQueue.addBulk(
      uniqueIds.map((articleId) => {
        const data: ImportanceJobData = { articleId };
        if (opts?.skipCluster != null) data.skipCluster = !!opts.skipCluster;
        return {
          data,
          opts: {
            attempts: 3,
            backoff: { type: 'exponential' as const, delay: 2000 },
            removeOnComplete: 100,
          },
        };
      }),
    );
    return { enqueued: jobs.length };
  } catch (error) {
    console.error(
      '[ImportanceQueue] 批量入队失败，回退逐条入队:',
      error instanceof Error ? error.message : String(error),
    );
    const jobs = await Promise.all(
      uniqueIds.map((id) => {
        const jobOpts: { skipCluster?: boolean } = {};
        if (opts?.skipCluster != null) jobOpts.skipCluster = !!opts.skipCluster;
        return addImportanceJob(id, jobOpts);
      }),
    );
    return { enqueued: jobs.filter(Boolean).length };
  }
}

export function startImportanceWorker(): void {
  if (workerStarted) return;
  workerStarted = true;

  if (!isImportanceEnabled()) {
    console.log('[ImportanceQueue] IMPORTANCE_ENABLED=0，worker 未启动');
    return;
  }
  if (!isRedisAvailable) {
    console.warn('[ImportanceQueue] Redis 不可用，worker 未启动');
    return;
  }

  const concurrency = Math.min(
    Math.max(Number(process.env.IMPORTANCE_CONCURRENCY) || 8, 1),
    32,
  );

  console.log(`Starting importance worker (concurrency=${concurrency})...`);
  importanceQueue.process(concurrency, async (job: Queue.Job<ImportanceJobData>) => {
    const articleId = job.data.articleId;
    console.log(`[ImportanceQueue] 处理评分任务 articleId=${articleId} jobId=${job.id}`);
    await scoreArticleImportance(articleId, {
      skipCluster: !!job.data.skipCluster,
    });
  });

  importanceQueue.on('completed', (job: Queue.Job<ImportanceJobData>) => {
    console.log(`[ImportanceQueue] 任务完成 jobId=${job.id} articleId=${job.data.articleId}`);
  });

  importanceQueue.on('failed', (job: Queue.Job<ImportanceJobData> | undefined, err: Error) => {
    console.error(
      `[ImportanceQueue] 任务失败 jobId=${job?.id ?? 'unknown'} articleId=${job?.data.articleId ?? 'unknown'}:`,
      err.message,
    );
  });

  console.log('Importance worker started');
}

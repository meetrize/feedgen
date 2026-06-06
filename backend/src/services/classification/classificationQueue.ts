import Queue from 'bull';

import { classifyArticle } from './classificationService';

export interface ClassificationJobData {
  articleId: number;
}

const QUEUE_NAME = 'classification-queue';
const bullRedisOptions = { maxRetriesPerRequest: null };

let classificationQueue: Queue.Queue<ClassificationJobData>;
let isRedisAvailable = true;
let workerStarted = false;

function isClassificationEnabled(): boolean {
  return process.env.CLASSIFICATION_ENABLED !== '0';
}

try {
  classificationQueue = new Queue<ClassificationJobData>(
    QUEUE_NAME,
    process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    {
      redis: bullRedisOptions,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    },
  );

  let redisErrorLogged = false;
  classificationQueue.on('error', (error: Error) => {
    const msg = error.message || '';
    if (msg.includes('max retries per request') || msg.includes('MaxRetriesPerRequest')) {
      isRedisAvailable = false;
      if (!redisErrorLogged) {
        console.warn(
          '[ClassificationQueue] Redis 连接异常，已标记不可用；请检查 REDIS_URL 与 Redis 服务',
        );
        redisErrorLogged = true;
      }
      return;
    }
    if (!redisErrorLogged && msg.includes('ECONNREFUSED')) {
      console.warn('[ClassificationQueue] Redis 不可用，分类队列入队将跳过');
      redisErrorLogged = true;
      isRedisAvailable = false;
    } else if (!msg.includes('ECONNREFUSED')) {
      console.error('[ClassificationQueue] 队列错误:', msg);
    }
  });
} catch (error: unknown) {
  console.error(
    '[ClassificationQueue] 初始化失败:',
    error instanceof Error ? error.message : String(error),
  );
  classificationQueue = new Queue<ClassificationJobData>(
    QUEUE_NAME,
    process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    {
      redis: bullRedisOptions,
      defaultJobOptions: {
        attempts: 1,
        backoff: { type: 'fixed', delay: 1000 },
      },
    },
  );
}

export async function addClassificationJob(
  articleId: number,
): Promise<Queue.Job<ClassificationJobData> | null> {
  if (!isClassificationEnabled()) {
    console.warn('[ClassificationQueue] CLASSIFICATION_ENABLED=0，跳过入队');
    return null;
  }
  if (!isRedisAvailable) {
    console.warn('[ClassificationQueue] Redis 不可用，无法入队');
    return null;
  }

  try {
    return await classificationQueue.add(
      { articleId },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
      },
    );
  } catch (error) {
    console.error(
      `[ClassificationQueue] 入队失败 articleId=${articleId}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

export async function enqueueClassificationBatch(
  articleIds: number[],
): Promise<{ enqueued: number; job_ids: Array<string | number> }> {
  const uniqueIds = [...new Set(articleIds.filter((id) => Number.isInteger(id) && id > 0))];
  const jobs = await Promise.all(uniqueIds.map((articleId) => addClassificationJob(articleId)));
  const validJobs = jobs.filter((job): job is Queue.Job<ClassificationJobData> => job != null);

  return {
    enqueued: validJobs.length,
    job_ids: validJobs.map((job) => job.id),
  };
}

export function startClassificationWorker(): void {
  if (workerStarted) {
    return;
  }
  workerStarted = true;

  if (!isClassificationEnabled()) {
    console.log('[ClassificationQueue] CLASSIFICATION_ENABLED=0，分类 worker 未启动');
    return;
  }

  console.log('Starting classification worker...');

  if (!isRedisAvailable) {
    console.warn('[ClassificationQueue] Redis 不可用，分类 worker 未启动');
    return;
  }

  classificationQueue.process(1, async (job: Queue.Job<ClassificationJobData>) => {
    const articleId = job.data.articleId;
    console.log(`[ClassificationQueue] 处理分类任务 articleId=${articleId} jobId=${job.id}`);
    await classifyArticle(articleId);
  });

  classificationQueue.on('completed', (job: Queue.Job<ClassificationJobData>) => {
    console.log(`[ClassificationQueue] 任务完成 jobId=${job.id} articleId=${job.data.articleId}`);
  });

  classificationQueue.on('failed', (job: Queue.Job<ClassificationJobData> | undefined, err: Error) => {
    console.error(
      `[ClassificationQueue] 任务失败 jobId=${job?.id ?? 'unknown'} articleId=${job?.data.articleId ?? 'unknown'}:`,
      err.message,
    );
  });

  console.log('Classification worker started');
}

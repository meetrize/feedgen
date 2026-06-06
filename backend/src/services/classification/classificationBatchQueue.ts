import Queue from 'bull';

import { classifyArticle } from './classificationService';

export interface BatchClassificationJobData {
  articleIds: number[];
  processed: number;
  succeeded: number;
  failed: number;
}

const QUEUE_NAME = 'classification-batch-queue';
const bullRedisOptions = { maxRetriesPerRequest: null };
const BATCH_CONCURRENCY = Math.min(
  Math.max(Number(process.env.CLASSIFICATION_BATCH_CONCURRENCY || 2), 1),
  5,
);

let batchQueue: Queue.Queue<BatchClassificationJobData>;
let isRedisAvailable = true;
let workerStarted = false;

function isClassificationEnabled(): boolean {
  return process.env.CLASSIFICATION_ENABLED !== '0';
}

try {
  batchQueue = new Queue<BatchClassificationJobData>(
    QUEUE_NAME,
    process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    {
      redis: bullRedisOptions,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 30,
        removeOnFail: 30,
      },
    },
  );

  let redisErrorLogged = false;
  batchQueue.on('error', (error: Error) => {
    const msg = error.message || '';
    if (msg.includes('max retries per request') || msg.includes('MaxRetriesPerRequest')) {
      isRedisAvailable = false;
      if (!redisErrorLogged) {
        console.warn('[ClassificationBatchQueue] Redis 连接异常，批量队列不可用');
        redisErrorLogged = true;
      }
      return;
    }
    if (!redisErrorLogged && msg.includes('ECONNREFUSED')) {
      isRedisAvailable = false;
      redisErrorLogged = true;
    } else if (!msg.includes('ECONNREFUSED')) {
      console.error('[ClassificationBatchQueue] 队列错误:', msg);
    }
  });
} catch (error: unknown) {
  console.error(
    '[ClassificationBatchQueue] 初始化失败:',
    error instanceof Error ? error.message : String(error),
  );
  batchQueue = new Queue<BatchClassificationJobData>(
    QUEUE_NAME,
    process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    { redis: bullRedisOptions },
  );
}

export async function enqueueBatchClassificationJob(
  articleIds: number[],
): Promise<Queue.Job<BatchClassificationJobData> | null> {
  if (!isClassificationEnabled()) {
    console.warn('[ClassificationBatchQueue] CLASSIFICATION_ENABLED=0，跳过入队');
    return null;
  }
  if (!isRedisAvailable) {
    console.warn('[ClassificationBatchQueue] Redis 不可用，无法入队');
    return null;
  }

  const uniqueIds = [...new Set(articleIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (!uniqueIds.length) {
    return null;
  }

  try {
    return await batchQueue.add({
      articleIds: uniqueIds,
      processed: 0,
      succeeded: 0,
      failed: 0,
    });
  } catch (error) {
    console.error(
      '[ClassificationBatchQueue] 入队失败:',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

export async function getBatchClassificationJob(
  jobId: string | number,
): Promise<Queue.Job<BatchClassificationJobData> | null> {
  if (!isRedisAvailable) {
    return null;
  }
  try {
    const job = await batchQueue.getJob(jobId);
    return job ?? null;
  } catch (error) {
    console.error(
      `[ClassificationBatchQueue] 获取任务失败 jobId=${jobId}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

export function startBatchClassificationWorker(): void {
  if (workerStarted) {
    return;
  }
  workerStarted = true;

  if (!isClassificationEnabled()) {
    console.log('[ClassificationBatchQueue] CLASSIFICATION_ENABLED=0，批量 worker 未启动');
    return;
  }

  if (!isRedisAvailable) {
    console.warn('[ClassificationBatchQueue] Redis 不可用，批量 worker 未启动');
    return;
  }

  console.log(`Starting classification batch worker (concurrency=${BATCH_CONCURRENCY})...`);

  batchQueue.process(BATCH_CONCURRENCY, async (job: Queue.Job<BatchClassificationJobData>) => {
    const articleIds = job.data.articleIds || [];
    const total = articleIds.length;
    let processed = job.data.processed || 0;
    let succeeded = job.data.succeeded || 0;
    let failed = job.data.failed || 0;

    console.log(`[ClassificationBatchQueue] 开始批量任务 jobId=${job.id} total=${total}`);

    for (const articleId of articleIds) {
      try {
        await classifyArticle(articleId);
        succeeded += 1;
      } catch (error) {
        failed += 1;
        console.error(
          `[ClassificationBatchQueue] 分类失败 articleId=${articleId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
      processed += 1;
      const progress = total > 0 ? Math.round((processed / total) * 100) : 100;
      await job.update({
        ...job.data,
        processed,
        succeeded,
        failed,
      });
      await job.progress(progress);
    }

    console.log(
      `[ClassificationBatchQueue] 批量任务完成 jobId=${job.id} succeeded=${succeeded} failed=${failed}`,
    );
  });

  batchQueue.on('completed', (job: Queue.Job<BatchClassificationJobData>) => {
    console.log(`[ClassificationBatchQueue] 任务完成 jobId=${job.id}`);
  });

  batchQueue.on('failed', (job: Queue.Job<BatchClassificationJobData> | undefined, err: Error) => {
    console.error(
      `[ClassificationBatchQueue] 任务失败 jobId=${job?.id ?? 'unknown'}:`,
      err.message,
    );
  });

  console.log('Classification batch worker started');
}

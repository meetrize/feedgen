import Queue from 'bull';

import { matchArticleById } from './financeMatchService';

export interface FinanceMatchJobData {
  articleId: number;
}

const QUEUE_NAME = 'finance-match-queue';
const bullRedisOptions = { maxRetriesPerRequest: null };

let financeMatchQueue: Queue.Queue<FinanceMatchJobData>;
let isRedisAvailable = true;
let workerStarted = false;

function isMatchEnabled(): boolean {
  return process.env.FINANCE_MATCH_ENABLED !== '0';
}

try {
  financeMatchQueue = new Queue<FinanceMatchJobData>(
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
  financeMatchQueue.on('error', (error: Error) => {
    const msg = error.message || '';
    if (
      msg.includes('max retries per request') ||
      msg.includes('MaxRetriesPerRequest') ||
      msg.includes('ECONNREFUSED')
    ) {
      isRedisAvailable = false;
      if (!redisErrorLogged) {
        console.warn('[FinanceMatchQueue] Redis 不可用，金融匹配入队将跳过');
        redisErrorLogged = true;
      }
      return;
    }
    console.error('[FinanceMatchQueue] 队列错误:', msg);
  });
} catch (error: unknown) {
  console.error(
    '[FinanceMatchQueue] 初始化失败:',
    error instanceof Error ? error.message : String(error),
  );
  financeMatchQueue = new Queue<FinanceMatchJobData>(
    QUEUE_NAME,
    process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    { redis: bullRedisOptions },
  );
}

export async function addFinanceMatchJob(
  articleId: number,
): Promise<Queue.Job<FinanceMatchJobData> | null> {
  if (!isMatchEnabled()) return null;
  if (!isRedisAvailable) return null;
  try {
    return await financeMatchQueue.add(
      { articleId },
      { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 100 },
    );
  } catch (error) {
    console.error(
      `[FinanceMatchQueue] 入队失败 articleId=${articleId}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

export async function enqueueFinanceMatchBatch(
  articleIds: number[],
): Promise<{ enqueued: number }> {
  const uniqueIds = [...new Set(articleIds.filter((id) => Number.isInteger(id) && id > 0))];
  const jobs = await Promise.all(uniqueIds.map((id) => addFinanceMatchJob(id)));
  return { enqueued: jobs.filter(Boolean).length };
}

export function startFinanceMatchWorker(): void {
  if (workerStarted) return;
  workerStarted = true;

  if (!isMatchEnabled()) {
    console.log('[FinanceMatchQueue] FINANCE_MATCH_ENABLED=0，worker 未启动');
    return;
  }
  if (!isRedisAvailable) {
    console.warn('[FinanceMatchQueue] Redis 不可用，worker 未启动');
    return;
  }

  console.log('Starting finance match worker...');
  financeMatchQueue.process(2, async (job: Queue.Job<FinanceMatchJobData>) => {
    await matchArticleById(job.data.articleId);
  });
  console.log('Finance match worker started');
}

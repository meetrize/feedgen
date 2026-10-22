import Queue from 'bull';

import { runFinanceDictSync, type SyncMode, type SyncTrigger } from './financeDictSyncService';
import { backfillFinanceMatch } from './financeMatchService';

export interface FinanceSyncJobData {
  mode: SyncMode;
  trigger: SyncTrigger;
  includeFunds?: boolean;
  includeYfinance?: boolean;
  rematchDays?: number;
}

const QUEUE_NAME = 'finance-sync-queue';
const bullRedisOptions = { maxRetriesPerRequest: null };

let financeSyncQueue: Queue.Queue<FinanceSyncJobData>;
let isRedisAvailable = true;
let workerStarted = false;
let schedulerStarted = false;

try {
  financeSyncQueue = new Queue<FinanceSyncJobData>(
    QUEUE_NAME,
    process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    {
      redis: bullRedisOptions,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 50,
        removeOnFail: 50,
      },
    },
  );

  let redisErrorLogged = false;
  financeSyncQueue.on('error', (error: Error) => {
    const msg = error.message || '';
    if (msg.includes('ECONNREFUSED') || msg.includes('max retries')) {
      isRedisAvailable = false;
      if (!redisErrorLogged) {
        console.warn('[FinanceSyncQueue] Redis 不可用');
        redisErrorLogged = true;
      }
      return;
    }
    console.error('[FinanceSyncQueue] 错误:', msg);
  });
} catch (error: unknown) {
  console.error(
    '[FinanceSyncQueue] 初始化失败:',
    error instanceof Error ? error.message : String(error),
  );
  financeSyncQueue = new Queue<FinanceSyncJobData>(
    QUEUE_NAME,
    process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    { redis: bullRedisOptions },
  );
}

export async function enqueueFinanceDictSync(
  data: FinanceSyncJobData,
): Promise<Queue.Job<FinanceSyncJobData> | null> {
  if (!isRedisAvailable) {
    // Redis 不可用时同步执行
    await runFinanceDictSync({
      mode: data.mode,
      trigger: data.trigger,
      ...(data.includeFunds != null ? { includeFunds: data.includeFunds } : {}),
      ...(data.includeYfinance != null ? { includeYfinance: data.includeYfinance } : {}),
    });
    return null;
  }
  return financeSyncQueue.add(data, { jobId: `finance-sync-${Date.now()}` });
}

export function startFinanceSyncWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  if (!isRedisAvailable) {
    console.warn('[FinanceSyncQueue] Redis 不可用，sync worker 未启动');
    return;
  }

  console.log('Starting finance sync worker...');
  financeSyncQueue.process(1, async (job: Queue.Job<FinanceSyncJobData>) => {
    const data = job.data;
    console.log(`[FinanceSyncQueue] 开始同步 mode=${data.mode} trigger=${data.trigger}`);
    await runFinanceDictSync({
      mode: data.mode,
      trigger: data.trigger,
      ...(data.includeFunds != null ? { includeFunds: data.includeFunds } : {}),
      ...(data.includeYfinance != null ? { includeYfinance: data.includeYfinance } : {}),
    });
    const days = data.rematchDays ?? 7;
    if (days > 0) {
      const since = new Date(Date.now() - days * 86400000);
      const result = await backfillFinanceMatch({ since, limit: 2000 });
      console.log(
        `[FinanceSyncQueue] 重匹配完成 processed=${result.processed} matched=${result.matched_articles}`,
      );
    }
  });
  console.log('Finance sync worker started');
}

/** 定时词典同步（默认 24h） */
export function startFinanceDictSyncScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  if (process.env.FINANCE_DICT_SYNC_ENABLED === '0') {
    console.log('[FinanceSync] 定时同步已关闭 (FINANCE_DICT_SYNC_ENABLED=0)');
    return;
  }

  const intervalMs = Number(process.env.FINANCE_DICT_SYNC_INTERVAL_MS) || 86400000;
  console.log(`[FinanceSync] 定时同步已启动 intervalMs=${intervalMs}`);

  setInterval(() => {
    enqueueFinanceDictSync({
      mode: 'incremental',
      trigger: 'scheduled',
      includeFunds: true,
      includeYfinance: true,
      rematchDays: 3,
    }).catch((err) => {
      console.error(
        '[FinanceSync] 定时入队失败:',
        err instanceof Error ? err.message : String(err),
      );
    });
  }, intervalMs);
}

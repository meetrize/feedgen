import Queue from 'bull';

import { prisma } from '../../server';
import {
  DEFAULT_DEDUP_CONFIG,
  DedupConfig,
  formatLocalDay,
  runDedupBackfill,
  runDedupForDay,
} from './dedupService';

export const DEDUP_QUEUE_NAME = 'dedup-queue';
export const DEDUP_JOB_KEY = 'dedup.daily';

export type DedupJobData =
  | {
      type: 'day';
      runId: number;
      run_day: string;
      config?: Partial<DedupConfig>;
    }
  | {
      type: 'backfill';
      runId: number;
      from: string;
      to: string;
      config?: Partial<DedupConfig>;
    };

const bullRedisOptions = { maxRetriesPerRequest: null };

let dedupQueue: Queue.Queue<DedupJobData>;
let isRedisAvailable = true;
let workerStarted = false;

function isDedupEnabled(): boolean {
  return process.env.DEDUP_ENABLED !== '0';
}

try {
  dedupQueue = new Queue<DedupJobData>(DEDUP_QUEUE_NAME, process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    redis: bullRedisOptions,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 100,
    },
  });

  let redisErrorLogged = false;
  dedupQueue.on('error', (error: Error) => {
    const msg = error.message || '';
    if (
      msg.includes('max retries per request') ||
      msg.includes('MaxRetriesPerRequest') ||
      msg.includes('ECONNREFUSED')
    ) {
      isRedisAvailable = false;
      if (!redisErrorLogged) {
        console.warn('[DedupQueue] Redis 不可用，查重入队将跳过');
        redisErrorLogged = true;
      }
      return;
    }
    console.error('[DedupQueue] 队列错误:', msg);
  });
} catch (error: unknown) {
  console.error('[DedupQueue] 初始化失败:', error instanceof Error ? error.message : String(error));
  dedupQueue = new Queue<DedupJobData>(DEDUP_QUEUE_NAME, process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    redis: bullRedisOptions,
  });
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

export async function enqueueDedupDay(params: {
  runId: number;
  run_day?: string;
  config?: Partial<DedupConfig>;
}): Promise<Queue.Job<DedupJobData> | null> {
  if (!isDedupEnabled() || !isRedisAvailable) return null;
  const run_day = params.run_day || formatLocalDay();
  try {
    const payload: DedupJobData = {
      type: 'day',
      runId: params.runId,
      run_day,
      ...(params.config ? { config: params.config } : {}),
    };
    const job = await dedupQueue.add(payload, { jobId: `dedup-day-${params.runId}` });
    await markRun(params.runId, { status: 'queued', bull_job_id: String(job.id) });
    return job;
  } catch (error) {
    console.error('[DedupQueue] 入队失败:', error instanceof Error ? error.message : String(error));
    await markRun(params.runId, {
      status: 'failed',
      finished_at: new Date(),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function enqueueDedupBackfill(params: {
  runId: number;
  from: string;
  to: string;
  config?: Partial<DedupConfig>;
}): Promise<Queue.Job<DedupJobData> | null> {
  if (!isDedupEnabled() || !isRedisAvailable) return null;
  try {
    const payload: DedupJobData = {
      type: 'backfill',
      runId: params.runId,
      from: params.from,
      to: params.to,
      ...(params.config ? { config: params.config } : {}),
    };
    const job = await dedupQueue.add(payload, { jobId: `dedup-backfill-${params.runId}` });
    await markRun(params.runId, { status: 'queued', bull_job_id: String(job.id) });
    return job;
  } catch (error) {
    console.error('[DedupQueue] 回填入队失败:', error instanceof Error ? error.message : String(error));
    await markRun(params.runId, {
      status: 'failed',
      finished_at: new Date(),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function cancelDedupRun(runId: number): Promise<boolean> {
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
      const job = await dedupQueue.getJob(run.bull_job_id);
      if (job) {
        const state = await job.getState();
        if (state === 'waiting' || state === 'delayed') {
          await job.remove();
        }
      }
    } catch {
      /* ignore */
    }
  }
  return true;
}

export function startDedupWorker(): void {
  if (workerStarted) return;
  if (!isDedupEnabled()) {
    console.log('[DedupQueue] worker disabled (DEDUP_ENABLED=0)');
    return;
  }
  workerStarted = true;

  dedupQueue.process(1, async (job) => {
    const data = job.data;
    const runId = data.runId;

    if (await isRunCancelled(runId)) {
      return { cancelled: true };
    }

    await markRun(runId, {
      status: 'running',
      started_at: new Date(),
      progress: 0,
      progress_text: '开始处理',
    });

    const jobRow = await prisma.systemJob.findUnique({
      where: { key: DEDUP_JOB_KEY },
      select: { config: true },
    });
    const storedCfg = (jobRow?.config || {}) as Partial<DedupConfig>;
    const cfg = { ...DEFAULT_DEDUP_CONFIG, ...storedCfg, ...(data.config || {}) };

    try {
      const shouldCancel = () => isRunCancelled(runId);
      const onProgress = async (p: {
        progress: number;
        progressText: string;
        stats: Record<string, number>;
      }) => {
        if (await isRunCancelled(runId)) return;
        await markRun(runId, {
          progress: p.progress,
          progress_text: p.progressText,
          stats: p.stats,
        });
      };

      let result: Record<string, number | boolean>;
      if (data.type === 'backfill') {
        result = await runDedupBackfill(data.from, data.to, cfg, { shouldCancel, onProgress });
      } else {
        result = await runDedupForDay(data.run_day, cfg, { shouldCancel, onProgress });
      }

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
      console.error('[DedupQueue] job 失败:', msg);
      await markRun(runId, {
        status: 'failed',
        finished_at: new Date(),
        error: msg,
        progress_text: '失败',
      });
      throw error;
    }
  });

  console.log('[DedupQueue] worker started (concurrency=1)');
}

export function getDedupQueue(): Queue.Queue<DedupJobData> {
  return dedupQueue;
}

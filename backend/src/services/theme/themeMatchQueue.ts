import Queue from 'bull';

import { backfillThemesForUser, matchThemesForArticle } from './themeMatchService';
import { markThemeRematchQueued } from './themeRematchProgress';

export type ThemeMatchJobData =
  | { type: 'article'; articleId: number }
  | { type: 'user_backfill'; userId: number; limit?: number; tagId?: number };

const QUEUE_NAME = 'theme-match-queue';
const bullRedisOptions = { maxRetriesPerRequest: null };

let themeMatchQueue: Queue.Queue<ThemeMatchJobData>;
let isRedisAvailable = true;
let workerStarted = false;

function isMatchEnabled(): boolean {
  return process.env.THEME_MATCH_ENABLED !== '0';
}

try {
  themeMatchQueue = new Queue<ThemeMatchJobData>(
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
  themeMatchQueue.on('error', (error: Error) => {
    const msg = error.message || '';
    if (
      msg.includes('max retries per request') ||
      msg.includes('MaxRetriesPerRequest') ||
      msg.includes('ECONNREFUSED')
    ) {
      isRedisAvailable = false;
      if (!redisErrorLogged) {
        console.warn('[ThemeMatchQueue] Redis 不可用，主题匹配入队将跳过');
        redisErrorLogged = true;
      }
      return;
    }
    console.error('[ThemeMatchQueue] 队列错误:', msg);
  });
} catch (error: unknown) {
  console.error(
    '[ThemeMatchQueue] 初始化失败:',
    error instanceof Error ? error.message : String(error),
  );
  themeMatchQueue = new Queue<ThemeMatchJobData>(
    QUEUE_NAME,
    process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    { redis: bullRedisOptions },
  );
}

export async function addThemeMatchJob(
  articleId: number,
): Promise<Queue.Job<ThemeMatchJobData> | null> {
  if (!isMatchEnabled()) return null;
  if (!isRedisAvailable) return null;
  if (!Number.isInteger(articleId) || articleId <= 0) return null;
  try {
    return await themeMatchQueue.add(
      { type: 'article', articleId },
      {
        jobId: `theme-article-${articleId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
      },
    );
  } catch (error) {
    console.error(
      `[ThemeMatchQueue] 入队失败 articleId=${articleId}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

export async function addThemeBackfillJob(
  userId: number,
  options?: { limit?: number; tagId?: number },
): Promise<Queue.Job<ThemeMatchJobData> | null> {
  if (!isMatchEnabled()) return null;
  if (!isRedisAvailable) return null;
  if (!Number.isInteger(userId) || userId <= 0) return null;
  const buildPayload = (): Extract<ThemeMatchJobData, { type: 'user_backfill' }> => {
    const payload: Extract<ThemeMatchJobData, { type: 'user_backfill' }> = {
      type: 'user_backfill',
      userId,
    };
    if (typeof options?.limit === 'number' && Number.isFinite(options.limit)) {
      payload.limit = Math.floor(options.limit);
    }
    if (typeof options?.tagId === 'number' && Number.isInteger(options.tagId) && options.tagId > 0) {
      payload.tagId = options.tagId;
    }
    return payload;
  };

  try {
    const payload = buildPayload();
    const scope = payload.tagId ? `tag-${payload.tagId}` : 'all';
    const jobId = `theme-backfill-${userId}-${scope}`;

    // 清理已完成/失败的同名任务，避免 jobId 占坑导致无法再次关联
    try {
      const existing = await themeMatchQueue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state === 'completed' || state === 'failed') {
          await existing.remove();
        } else if (state === 'active' || state === 'waiting' || state === 'delayed') {
          markThemeRematchQueued(userId, payload.tagId ?? null);
          return existing;
        }
      }
    } catch {
      // ignore lookup errors
    }

    markThemeRematchQueued(userId, payload.tagId ?? null);
    return await themeMatchQueue.add(payload, {
      jobId,
      // 优先于单篇匹配，尽快开始全量回扫
      priority: 1,
      attempts: 2,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: 50,
    });
  } catch (error) {
    // jobId 冲突时改用时间戳再入队一次
    const msg = error instanceof Error ? error.message : String(error);
    if (/Job .* already exists|already exists/i.test(msg)) {
      try {
        const payload = buildPayload();
        const scope = payload.tagId ? `tag-${payload.tagId}` : 'all';
        markThemeRematchQueued(userId, payload.tagId ?? null);
        return await themeMatchQueue.add(payload, {
          jobId: `theme-backfill-${userId}-${scope}-${Date.now()}`,
          priority: 1,
          attempts: 2,
          backoff: { type: 'exponential', delay: 3000 },
          removeOnComplete: 50,
        });
      } catch (retryError) {
        console.error(
          `[ThemeMatchQueue] 回扫入队失败 userId=${userId}:`,
          retryError instanceof Error ? retryError.message : String(retryError),
        );
        return null;
      }
    }
    console.error(`[ThemeMatchQueue] 回扫入队失败 userId=${userId}:`, msg);
    return null;
  }
}

export async function enqueueThemeMatchBatch(
  articleIds: number[],
): Promise<{ enqueued: number }> {
  const uniqueIds = [...new Set(articleIds.filter((id) => Number.isInteger(id) && id > 0))];
  const jobs = await Promise.all(uniqueIds.map((id) => addThemeMatchJob(id)));
  return { enqueued: jobs.filter(Boolean).length };
}

export function startThemeMatchWorker(): void {
  if (workerStarted) return;
  workerStarted = true;

  if (!isMatchEnabled()) {
    console.log('[ThemeMatchQueue] THEME_MATCH_ENABLED=0，worker 未启动');
    return;
  }
  if (!isRedisAvailable) {
    console.warn('[ThemeMatchQueue] Redis 不可用，worker 未启动');
    return;
  }

  console.log('Starting theme match worker...');
  // 全量回扫较重，concurrency=1，避免与单篇匹配互相抢 DB
  themeMatchQueue.process(1, async (job: Queue.Job<ThemeMatchJobData>) => {
    const data = job.data;
    if (data.type === 'user_backfill') {
      const result = await backfillThemesForUser(data.userId, {
        ...(data.limit != null ? { limit: data.limit } : {}),
        ...(data.tagId != null ? { tagId: data.tagId } : {}),
      });
      console.log(
        `[ThemeMatchQueue] 回扫完成 userId=${data.userId}` +
          `${data.tagId != null ? ` tagId=${data.tagId}` : ''}` +
          ` scanned=${result.scanned}/${result.total} matched=${result.matched}`,
      );
      return;
    }
    await matchThemesForArticle(data.articleId);
  });
  console.log('Theme match worker started');
}

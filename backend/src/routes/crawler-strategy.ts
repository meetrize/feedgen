import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../server';
import { runManualCrawlForFeed } from '../workers/crawlerWorker';

type HistoryRow = {
  feed_id: number;
  status: string;
  mode: string;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: number | null;
  new_articles_count: number;
  error_message: string | null;
};

const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 604800;

function clampInterval(value: number, min = MIN_INTERVAL_SECONDS, max = MAX_INTERVAL_SECONDS) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function classifyFailureReason(message?: string | null) {
  const raw = String(message || '').trim();
  const lower = raw.toLowerCase();
  if (!raw) return '—';
  if (
    lower.includes('antibotdetectederror') ||
    lower.includes('captcha') ||
    lower.includes('geetest') ||
    lower.includes('cloudflare') ||
    lower.includes('access denied') ||
    raw.includes('反爬') ||
    raw.includes('验证') ||
    raw.includes('人机') ||
    raw.includes('访问受限')
  ) return '反爬/验证码';
  if (lower.includes('timeout') || raw.includes('超时')) return '访问超时';
  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('network')) return '网络错误';
  if (lower.includes('prisma') || lower.includes('database')) return '数据库错误';
  return raw.slice(0, 80);
}

function recommendInterval(currentInterval: number, histories: HistoryRow[], antiBotStatus?: string | null) {
  const finished = histories.filter((h) => h.finished_at != null);
  const recent = finished.slice(0, 20);
  const total = recent.length;
  if (total === 0) return currentInterval;

  const failed = recent.filter((h) => h.status === 'failed').length;
  const antiBot = recent.filter((h) => classifyFailureReason(h.error_message) === '反爬/验证码').length;
  const timeout = recent.filter((h) => classifyFailureReason(h.error_message) === '访问超时').length;
  const success = recent.filter((h) => h.status === 'success').length;
  const avgNewArticles = success > 0
    ? recent.filter((h) => h.status === 'success').reduce((sum, h) => sum + (h.new_articles_count || 0), 0) / success
    : 0;

  let recommended = currentInterval || 1800;
  if (antiBotStatus && antiBotStatus !== 'normal') recommended = Math.max(recommended, 21600);
  if (antiBot > 0) recommended = Math.max(recommended, antiBot >= 2 ? 43200 : 21600);
  else if (timeout >= 2) recommended = Math.max(recommended, 7200);
  else if (failed / total >= 0.5) recommended = Math.max(recommended, 10800);
  else if (success >= 5 && failed === 0 && avgNewArticles >= 3) recommended = Math.max(900, Math.floor(recommended * 0.75));
  else if (success >= 5 && avgNewArticles < 0.5) recommended = Math.max(recommended, 7200);

  return clampInterval(recommended);
}

function summarizeHistories(histories: HistoryRow[], currentInterval: number, antiBotStatus?: string | null) {
  const recent = histories.slice(0, 20);
  const total = recent.length;
  const successCount = recent.filter((h) => h.status === 'success').length;
  const failedCount = recent.filter((h) => h.status === 'failed').length;
  const last = recent[0] || null;
  // 仅当最近一次执行失败时展示失败原因，避免修复后仍显示历史 Playwright 报错
  const lastFailure = last?.status === 'failed' ? last : null;
  const durations = recent.map((h) => h.duration_ms).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const avgDurationMs = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
  const successRate = total > 0 ? Math.round((successCount / total) * 100) : null;

  return {
    total_runs: total,
    success_count: successCount,
    failed_count: failedCount,
    success_rate: successRate,
    avg_duration_ms: avgDurationMs,
    last_status: last?.status || null,
    last_run_at: last?.started_at || null,
    last_finished_at: last?.finished_at || null,
    last_new_articles_count: last?.new_articles_count ?? null,
    last_failure_reason: classifyFailureReason(lastFailure?.error_message),
    last_failure_message: lastFailure?.error_message || null,
    recommended_interval: recommendInterval(currentInterval, histories, antiBotStatus),
  };
}

async function requireUserId(req: any, res: any) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).send({ error: 'Authentication required' });
    return null;
  }
  const decoded: any = await req.jwtVerify();
  return Number(decoded.userId);
}

export const crawlerStrategyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (req: any, res: any) => {
    try {
      const userId = await requireUserId(req, res);
      if (!userId) return;

      const feeds = await prisma.feed.findMany({
        where: { user_id: userId },
        include: { crawler_strategy: true },
        orderBy: [{ source_type: 'asc' }, { updated_at: 'desc' }],
      });
      const feedIds = feeds.map((feed: any) => feed.id);
      const histories = feedIds.length > 0
        ? await prisma.crawlerTaskHistory.findMany({
            where: { feed_id: { in: feedIds } },
            orderBy: { started_at: 'desc' },
            take: Math.max(100, feedIds.length * 20),
          })
        : [];

      const historiesByFeed = new Map<number, HistoryRow[]>();
      for (const history of histories as HistoryRow[]) {
        const arr = historiesByFeed.get(history.feed_id) || [];
        if (arr.length < 20) arr.push(history);
        historiesByFeed.set(history.feed_id, arr);
      }

      const items = feeds.map((feed: any) => {
        const currentInterval = feed.update_interval || 1800;
        const summary = summarizeHistories(historiesByFeed.get(feed.id) || [], currentInterval, feed.anti_bot_status);
        const strategy = feed.crawler_strategy;
        return {
          id: feed.id,
          title: feed.title,
          url: feed.url,
          favicon_url: feed.favicon_url || null,
          favicon_custom_text: feed.favicon_custom_text || null,
          favicon_custom_bg: feed.favicon_custom_bg || null,
          source_type: feed.source_type,
          is_active: feed.is_active,
          current_interval: currentInterval,
          last_fetched_at: feed.last_fetched_at,
          auth_cookie: feed.auth_cookie || null,
          anti_bot_status: feed.anti_bot_status,
          anti_bot_detected_at: feed.anti_bot_detected_at,
          anti_bot_message: feed.anti_bot_message,
          strategy: strategy ? {
            strategy_mode: strategy.strategy_mode,
            recommended_interval: strategy.recommended_interval ?? summary.recommended_interval,
            min_interval: strategy.min_interval,
            max_interval: strategy.max_interval,
            cooldown_until: strategy.cooldown_until,
            failure_threshold: strategy.failure_threshold,
            auto_disable_enabled: strategy.auto_disable_enabled,
            note: strategy.note,
          } : {
            strategy_mode: 'auto',
            recommended_interval: summary.recommended_interval,
            min_interval: 1800,
            max_interval: 86400,
            cooldown_until: null,
            failure_threshold: 3,
            auto_disable_enabled: false,
            note: null,
          },
          stats: summary,
        };
      });

      return { items };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Failed to fetch crawler strategies' });
    }
  });

  fastify.put('/:feedId', async (req: any, res: any) => {
    try {
      const userId = await requireUserId(req, res);
      if (!userId) return;

      const feedId = Number(req.params.feedId);
      if (!Number.isInteger(feedId) || feedId <= 0) {
        return res.status(400).send({ error: 'feedId 无效' });
      }

      const feed = await prisma.feed.findFirst({ where: { id: feedId, user_id: userId } });
      if (!feed) return res.status(404).send({ error: 'Feed not found' });

      const body = req.body as {
        update_interval?: number;
        strategy_mode?: string;
        recommended_interval?: number | null;
        min_interval?: number;
        max_interval?: number;
        cooldown_until?: string | null;
        failure_threshold?: number;
        auto_disable_enabled?: boolean;
        note?: string | null;
        apply_recommended?: boolean;
        auth_cookie?: string | null;
      };

      const feedUpdate: any = { updated_at: new Date() };
      let interval = body.update_interval;
      if (body.apply_recommended && body.recommended_interval != null) interval = body.recommended_interval;
      if (interval !== undefined) {
        const n = Number(interval);
        if (!Number.isFinite(n) || n < MIN_INTERVAL_SECONDS || n > MAX_INTERVAL_SECONDS) {
          return res.status(400).send({ error: '更新间隔需在 60～604800 秒之间' });
        }
        feedUpdate.update_interval = Math.floor(n);
      }
      if (body.auth_cookie !== undefined) {
        feedUpdate.auth_cookie = body.auth_cookie == null || body.auth_cookie === '' ? null : String(body.auth_cookie).slice(0, 8000);
      }

      const strategyData: any = { updated_at: new Date() };
      if (body.strategy_mode !== undefined) {
        const mode = String(body.strategy_mode).trim();
        if (!['auto', 'manual', 'cooldown', 'disabled'].includes(mode)) {
          return res.status(400).send({ error: 'strategy_mode 仅支持 auto/manual/cooldown/disabled' });
        }
        strategyData.strategy_mode = mode;
        if (mode === 'disabled') feedUpdate.is_active = false;
      }
      if (body.recommended_interval !== undefined) {
        strategyData.recommended_interval = body.recommended_interval == null ? null : clampInterval(Number(body.recommended_interval));
      }
      if (body.min_interval !== undefined) strategyData.min_interval = clampInterval(Number(body.min_interval));
      if (body.max_interval !== undefined) strategyData.max_interval = clampInterval(Number(body.max_interval));
      if (body.cooldown_until !== undefined) {
        if (body.cooldown_until == null || body.cooldown_until === '') {
          strategyData.cooldown_until = null;
        } else {
          const d = new Date(body.cooldown_until);
          if (Number.isNaN(d.getTime())) return res.status(400).send({ error: 'cooldown_until 时间无效' });
          strategyData.cooldown_until = d;
        }
      }
      if (body.failure_threshold !== undefined) {
        const n = Number(body.failure_threshold);
        if (!Number.isInteger(n) || n < 1 || n > 20) return res.status(400).send({ error: 'failure_threshold 需在 1～20 之间' });
        strategyData.failure_threshold = n;
      }
      if (body.auto_disable_enabled !== undefined) strategyData.auto_disable_enabled = Boolean(body.auto_disable_enabled);
      if (body.note !== undefined) strategyData.note = body.note == null ? null : String(body.note).slice(0, 2000);

      const [updatedFeed, strategy] = await prisma.$transaction([
        prisma.feed.update({ where: { id: feedId }, data: feedUpdate }),
        prisma.feedCrawlerStrategy.upsert({
          where: { feed_id: feedId },
          create: {
            feed_id: feedId,
            strategy_mode: strategyData.strategy_mode || 'manual',
            recommended_interval: strategyData.recommended_interval,
            min_interval: strategyData.min_interval ?? 1800,
            max_interval: strategyData.max_interval ?? 86400,
            cooldown_until: strategyData.cooldown_until,
            failure_threshold: strategyData.failure_threshold ?? 3,
            auto_disable_enabled: strategyData.auto_disable_enabled ?? false,
            note: strategyData.note,
          },
          update: strategyData,
        }),
      ]);

      return { feed: updatedFeed, strategy };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Failed to update crawler strategy' });
    }
  });

  fastify.post('/:feedId/crawl', async (req: any, res: any) => {
    try {
      const userId = await requireUserId(req, res);
      if (!userId) return;

      const feedId = Number(req.params.feedId);
      if (!Number.isInteger(feedId) || feedId <= 0) {
        return res.status(400).send({ error: 'feedId 无效' });
      }

      const feed = await prisma.feed.findFirst({ where: { id: feedId, user_id: userId } });
      if (!feed) return res.status(404).send({ error: 'Feed not found' });

      const result = await runManualCrawlForFeed(feedId);
      return result;
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Failed to trigger crawl' });
    }
  });
};

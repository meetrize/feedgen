import Queue from 'bull';
import { CrawlerService } from '../services/crawler';
import { recordCrawlerTaskHistory } from '../services/crawlerTaskHistory';
import { crawlLog, connectionErrorMessage, type CrawlLogLine, type ManualCrawlResult } from '../services/crawlRunResult';
import { makeFeedLogger } from '../services/crawlRunProgress';
import { testTargetConnection } from '../services/targetConnection';
import { createCaptchaTicket } from '../services/captchaRelay';

import { getPrisma } from '../server';
import { articlesForDbInsert } from '../utils/articleInsertOrder';
import { pubDateForDb } from '../utils/pubDate';

// 定义任务接口
interface CrawlJobData {
  feedId: number;
  url: string;
  selectors: any;
  isDynamic: boolean;
}

const TITLE_DUPLICATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function getUrlHost(rawUrl?: string | null): string | null {
  if (!rawUrl) return null;
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

function isSameSiteOrFeed(article: { feed_id?: number; feedId?: number; url?: string | null; link?: string | null }, feedId: number, itemUrl?: string | null): boolean {
  const articleFeedId = article.feed_id ?? article.feedId;
  if (articleFeedId === feedId) return true;
  const articleHost = getUrlHost(article.url || article.link || null);
  const itemHost = getUrlHost(itemUrl || null);
  return !!articleHost && !!itemHost && articleHost === itemHost;
}

function isAntiBotError(error: unknown): boolean {
  if (!error) return false;
  const err = error as { name?: string; message?: string; response?: { status?: number; data?: unknown } };
  if (err.name === 'AntiBotDetectedError') return true;
  const status = err.response?.status;
  if (status === 403 || status === 429) return true;
  const responseText = typeof err.response?.data === 'string' ? err.response.data : '';
  const message = `${String(err.message || error)} ${responseText.slice(0, 2000)}`.toLowerCase();
  return [
    'antibotdetectederror',
    '检测到反爬',
    '反爬挑战页',
    'captcha',
    '人机',
    '访问受限',
    '请完成验证',
    'geetest',
    'cloudflare',
    'access denied',
  ].some((token) => message.includes(token.toLowerCase()));
}

function getCrawlerFailureStatus(error: unknown): 'detected' | 'failed' {
  return isAntiBotError(error) ? 'detected' : 'failed';
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function markFeedCrawlerFailureStatus(prisma: any, feedId: number, error: unknown) {
  const now = new Date();
  const status = getCrawlerFailureStatus(error);
  await prisma.feed.update({
    where: { id: feedId },
    data: {
      anti_bot_status: status,
      anti_bot_detected_at: now,
      anti_bot_message: getErrorMessage(error),
      last_fetched_at: now,
    },
  });

  if (status === 'detected') {
    const strategy = await prisma.feedCrawlerStrategy.findUnique({ where: { feed_id: feedId } }).catch(() => null);
    const cooldownSeconds = Math.max(21600, Number(strategy?.recommended_interval || strategy?.min_interval || 21600));
    await prisma.feedCrawlerStrategy.upsert({
      where: { feed_id: feedId },
      create: {
        feed_id: feedId,
        strategy_mode: 'cooldown',
        recommended_interval: cooldownSeconds,
        cooldown_until: new Date(now.getTime() + cooldownSeconds * 1000),
      },
      update: {
        strategy_mode: 'cooldown',
        recommended_interval: cooldownSeconds,
        cooldown_until: new Date(now.getTime() + cooldownSeconds * 1000),
        updated_at: now,
      },
    }).catch((strategyError: unknown) => {
      console.error(`[Scheduler] 更新 Feed ${feedId} 反爬冷却策略失败:`, strategyError);
    });

    // 创建人工打码 ticket（仅当上游未创建时）
    const err = error as { screenshot?: Buffer; signals?: string[]; message?: string; pageUrl?: string; _captchaTicketCreated?: boolean };
    if (err.screenshot && !err._captchaTicketCreated) {
      try {
        const feed = await prisma.feed.findUnique({ where: { id: feedId }, select: { title: true, url: true } });
        createCaptchaTicket({
          feedId,
          feedTitle: feed?.title || `Feed #${feedId}`,
          targetUrl: feed?.url || '',
          pageUrl: err.pageUrl || feed?.url || '',
          screenshotBase64: err.screenshot.toString('base64'),
          signals: err.signals || [],
        });
      } catch (ticketError) {
        console.error(`[captchaRelay] 创建打码 ticket 失败:`, ticketError);
      }
    }
  }
}

async function clearFeedAntiBotStatus(prisma: any, feedId: number) {
  await prisma.feed.update({
    where: { id: feedId },
    data: {
      anti_bot_status: 'normal',
      anti_bot_detected_at: null,
      anti_bot_message: null,
    },
  });
}

async function findDuplicateArticleByUrlOrRecentTitle(
  prisma: any,
  params: { feedId: number; title: string; url?: string | null; urlField: 'url' | 'link'; feedField: 'feed_id' | 'feedId' }
) {
  const { feedId, title, url, urlField, feedField } = params;
  const urlDuplicate = url
    ? await prisma.article.findFirst({
        where: {
          [feedField]: feedId,
          [urlField]: url,
        },
      })
    : null;
  if (urlDuplicate) return urlDuplicate;

  const recentTitleCandidates = await prisma.article.findMany({
    where: {
      title,
      created_at: {
        gte: new Date(Date.now() - TITLE_DUPLICATE_WINDOW_MS),
      },
    },
    select: {
      id: true,
      feed_id: true,
      title: true,
      url: true,
      created_at: true,
    },
  });

  return recentTitleCandidates.find((article: any) => isSameSiteOrFeed(article, feedId, url || null)) || null;
}

// 尝试初始化Redis队列，但限制重试以避免无限重试
let crawlQueue: Queue.Queue;

// Bull 默认只对 bclient/subscriber 设 maxRetriesPerRequest:null，主 client 仍为 20；
// Redis 短暂不可达时主连接上的命令会触发 MaxRetriesPerRequestError，进而未处理的 Promise rejection 导致进程退出。
/** 与 Bull/ioredis 推荐一致：避免主连接命令在断线时 20 次重试后 reject 拖垮进程 */
const bullRedisOptions = { maxRetriesPerRequest: null };

// 须在队列 error 回调之前声明，避免极端同步路径下访问 TDZ
let isRedisAvailable = true;

try {
  crawlQueue = new Queue('crawl job', process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    redis: bullRedisOptions,
    defaultJobOptions: {
      attempts: 2, // 减少重试次数
      backoff: {
        type: 'fixed',
        delay: 2000,
      },
      timeout: 15000, // 减少超时时间
    },
    settings: {
      // 限制重试队列的大小
      maxStalledCount: 1, // 最大停滞计数
      stalledInterval: 30000, // 检查停滞作业的间隔
    }
  });

  // 为队列添加错误处理，避免无限重试
  let redisErrorLogged = false; // 标记是否已记录Redis错误
  crawlQueue.on('error', (error: Error) => {
    const msg = error.message || '';
    // ioredis：主连接命令重试耗尽（在未配置 null 时）；降级为与超时路径一致
    if (msg.includes('max retries per request') || msg.includes('MaxRetriesPerRequest')) {
      isRedisAvailable = false;
      if (!redisErrorLogged) {
        console.warn(
          '[CrawlerQueue] Redis 连接异常（已达命令重试上限），已标记 Redis 不可用；请检查 REDIS_URL 与 Redis 服务是否稳定'
        );
        redisErrorLogged = true;
      }
      return;
    }
    // 只记录一次Redis连接错误，避免日志刷屏
    if (!redisErrorLogged && msg.includes('ECONNREFUSED')) {
      console.warn('Redis is not available. Please make sure Redis server is running. Queue operations will fail silently.');
      redisErrorLogged = true;
    } else if (!msg.includes('ECONNREFUSED')) {
      console.error('Queue error:', msg);
    }
  });
} catch (error: unknown) {
  console.error('Failed to initialize Redis queue:', (error as Error).message);
  // 如果Redis完全无法初始化，创建一个基本的队列实例
  crawlQueue = new Queue('crawl job', process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    redis: bullRedisOptions,
    defaultJobOptions: {
      attempts: 1, // 最小重试次数
      backoff: {
        type: 'fixed',
        delay: 1000,
      },
      timeout: 5000,
    }
  });
}

// 定义任务接口
interface CrawlJobData {
  feedId: number;
  url: string;
  selectors: any;
  isDynamic: boolean;
}

// 添加任务到队列
export const addCrawlJob = async (jobData: CrawlJobData): Promise<Queue.Job | null> => {
  if (!isRedisAvailable) {
    console.warn('Cannot add crawl job - Redis is not available');
    return null;
  }
  
  try {
    const job = await crawlQueue.add(jobData, {
      attempts: 2, // 减少重试次数
      backoff: {
        type: 'fixed',
        delay: 2000,
      },
      timeout: 15000, // 减少超时时间
    });
    return job;
  } catch (error) {
    console.error('Failed to add crawl job:', error);
    // 如果添加任务失败，假定Redis不可用
    isRedisAvailable = false;
    return null;
  }
};

// 处理队列任务
const processCrawlJob = async (job: Queue.Job<CrawlJobData>) => {
  const { feedId, url, selectors, isDynamic } = job.data;
  const startedAt = new Date();
  let newCount = 0;
  const prisma = await getPrisma();

  try {
    console.log(`Processing crawl job for feed ID: ${feedId}, URL: ${url}`);
    
    // 更新feed状态为正在处理（使用is_active字段表示处理状态）
    await prisma.feed.update({
      where: { id: feedId },
      data: { is_active: false },
    });
    
    // 执行爬取
    const results = await CrawlerService.crawl(url, selectors, isDynamic);
    
    // 保存爬取结果到数据库（倒序入库，与源站 DOM 自上而下顺序一致）
    for (const item of articlesForDbInsert(results)) {
      const normalizedTitle = item.title.trim();
      // 检查是否已存在相同链接或相同标题的文章
      const existingArticle = await prisma.article.findFirst({
        where: {
          feedId,
          OR: [
            { link: item.link },
            { title: normalizedTitle },
          ],
        },
      });
      
      if (!existingArticle) {
        // 如果不存在，则创建新文章
        await prisma.article.create({
          data: {
            feedId,
            title: normalizedTitle,
            link: item.link,
            description: item.description || null,  // 使用null而不是undefined
            pubDate: item.pubDate || null,
            cachedAt: new Date(),
            expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000), // 6小时后过期
          },
        });
        newCount++;
      }
    }
    
    // 更新feed的最后抓取时间，并清除历史反爬/失败标记
    await prisma.feed.update({
      where: { id: feedId },
      data: {
        last_fetched_at: new Date(),
        is_active: true,
        anti_bot_status: 'normal',
        anti_bot_detected_at: null,
        anti_bot_message: null,
      },
    });
    
    console.log(`Successfully processed crawl job for feed ID: ${feedId}`);
    const finishedOk = new Date();
    await recordCrawlerTaskHistory({
      feedId,
      mode: 'queue',
      status: 'success',
      startedAt,
      finishedAt: finishedOk,
      newArticlesCount: newCount,
    });
    
    return { success: true, itemsProcessed: results.length };
  } catch (error) {
    console.error(`Error processing crawl job for feed ID: ${feedId}`, error);
    const finishedErr = new Date();
    await recordCrawlerTaskHistory({
      feedId,
      mode: 'queue',
      status: 'failed',
      startedAt,
      finishedAt: finishedErr,
      newArticlesCount: newCount,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    
    try {
      // 所有抓取失败都写入状态字段；命中反爬时标记 detected，其他失败标记 failed
      await markFeedCrawlerFailureStatus(prisma, feedId, error);
    } catch (updateError) {
      console.error(`Failed to update feed status after error for feed ID: ${feedId}`, updateError);
    }
    
    throw error;
  }
};

// 启动工作进程
export const startCrawlerWorker = () => {
  console.log('Starting crawler worker...');
  
  if (isRedisAvailable) {
    crawlQueue.process(async (job: Queue.Job<CrawlJobData>) => {
      return processCrawlJob(job);
    });
    
    // 监听队列事件
    crawlQueue.on('completed', (job: Queue.Job) => {
      console.log(`Job ${job.id} completed successfully`);
    });
    
    crawlQueue.on('failed', (job: Queue.Job | undefined, err: Error) => {
      console.error(`Job ${job?.id} failed with error:`, err.message);
    });
    
    // 定期清理已完成的任务（保留最近1小时的）
    setInterval(() => {
      if (typeof crawlQueue.clean === 'function') {
        crawlQueue.clean(3600000, 'completed'); // 清理1小时前的完成任务
      }
    }, 3600000); // 每小时执行一次
  } else {
    console.warn('Crawler worker not started - Redis is not available');
  }
  
  console.log('Crawler worker started');
};

type FeedLogFn = ReturnType<typeof makeFeedLogger>;

async function failConnectionCrawl(
  feed: { id: number },
  mode: string,
  log: FeedLogFn,
  logs: ManualCrawlResult['logs'],
  startedAt: Date,
  targetUrl: string | null,
  errMsg: string,
): Promise<ManualCrawlResult> {
  log('error', `无法连接目标网站：${errMsg}`);
  const prisma = await getPrisma();
  await markFeedCrawlerFailureStatus(prisma, feed.id, new Error(errMsg)).catch(() => {});
  const finishedAt = new Date();
  await recordCrawlerTaskHistory({
    feedId: feed.id,
    mode,
    status: 'failed',
    startedAt,
    finishedAt,
    errorMessage: errMsg,
  });
  return {
    mode,
    status: 'failed',
    message: errMsg,
    logs,
    connected: false,
    targetUrl,
    errorMessage: errMsg,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };
}

/** 连接预检；失败时返回完整 ManualCrawlResult，成功时返回 null */
async function ensureTargetReachable(
  feed: { id: number },
  mode: string,
  log: FeedLogFn,
  logs: ManualCrawlResult['logs'],
  startedAt: Date,
  targetUrl: string | null,
): Promise<ManualCrawlResult | null> {
  log('info', '正在测试与目标网站的连接（超时 5 秒）…');
  const conn = await testTargetConnection(targetUrl || '');
  if (conn.ok) {
    log('ok', `连接测试通过（HTTP ${conn.statusCode}，目标网站可访问）`);
    return null;
  }
  return failConnectionCrawl(feed, mode, log, logs, startedAt, targetUrl, conn.message);
}

// 直接执行可视化规则爬取（不依赖Redis）
async function crawlVisualFeed(feed: any, onLogLine?: (line: CrawlLogLine) => void): Promise<ManualCrawlResult> {
  const { crawlWithVisualSelectors } = await import('../services/visualCrawler');
  const rules = feed.selector_rules as any;
  const startedAt = new Date();
  const logs: ManualCrawlResult['logs'] = [];
  const log = makeFeedLogger(logs, onLogLine);
  const targetUrl = feed.url || null;
  log('info', `目标 URL：${targetUrl || '—'}`);

  if (!rules?.listSelector) {
    const finishedAt = new Date();
    const errMsg = '缺少 selector_rules.listSelector，未执行爬取';
    log('warn', errMsg);
    await recordCrawlerTaskHistory({
      feedId: feed.id,
      mode: 'visual',
      status: 'skipped',
      startedAt,
      finishedAt,
      errorMessage: errMsg,
    });
    return {
      mode: 'visual',
      status: 'skipped',
      message: errMsg,
      logs,
      targetUrl,
      errorMessage: errMsg,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  }

  const prisma = await getPrisma();
  try {
    const connFail = await ensureTargetReachable(feed, 'visual', log, logs, startedAt, targetUrl);
    if (connFail) return connFail;

    log('info', '正在启动浏览器并加载页面…');
    console.log(`[Scheduler] 开始爬取可视化Feed ID: ${feed.id}, URL: ${feed.url}`);
    const articles = await crawlWithVisualSelectors(feed.url, rules);
    log('ok', '已成功加载目标页面');
    log('info', `页面解析完成，共匹配 ${articles.length} 条内容`);

    let newCount = 0;
    for (const item of articlesForDbInsert(articles)) {
      const normalizedTitle = (item.title || '无标题').trim();
      const existing = await findDuplicateArticleByUrlOrRecentTitle(prisma, {
        feedId: feed.id,
        title: normalizedTitle,
        url: item.url || null,
        urlField: 'url',
        feedField: 'feed_id',
      });
      if (existing) continue;

      try {
        await prisma.article.create({
          data: {
            feed_id: feed.id,
            title: normalizedTitle,
            description: item.description || null,
            url: item.url || null,
            thumbnail_url: item.thumbnail_url || null,
            author: item.author || null,
            pub_date: pubDateForDb(item.pub_date),
            created_at: new Date(),
            updated_at: new Date(),
          }
        });
        newCount++;
      } catch (createErr) {
        console.warn(`[Scheduler] Feed ${feed.id} 单条入库跳过: ${normalizedTitle}`, createErr);
      }
    }

    await prisma.feed.update({
      where: { id: feed.id },
      data: {
        last_fetched_at: new Date(),
        anti_bot_status: 'normal',
        anti_bot_detected_at: null,
        anti_bot_message: null,
      }
    });
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    log('ok', `爬取完成：解析 ${articles.length} 条，新增入库 ${newCount} 条`);
    console.log(`[Scheduler] Feed ${feed.id} 爬取完成，新增 ${newCount} 篇文章`);
    await recordCrawlerTaskHistory({
      feedId: feed.id,
      mode: 'visual',
      status: 'success',
      startedAt,
      finishedAt,
      newArticlesCount: newCount,
    });
    return {
      mode: 'visual',
      status: 'success',
      message: `爬取成功，解析 ${articles.length} 条，新增 ${newCount} 条`,
      logs,
      connected: true,
      targetUrl,
      parsedCount: articles.length,
      newArticlesCount: newCount,
      durationMs,
    };
  } catch (error) {
    console.error(`[Scheduler] Feed ${feed.id} 爬取失败:`, error);
    const errMsg = connectionErrorMessage(error);
    log('error', `爬取失败：${errMsg}`);
    await markFeedCrawlerFailureStatus(prisma, feed.id, error).catch((updateError) => {
      console.error(`[Scheduler] 更新 Feed ${feed.id} 抓取失败状态失败:`, updateError);
    });
    const finishedAt = new Date();
    await recordCrawlerTaskHistory({
      feedId: feed.id,
      mode: 'visual',
      status: 'failed',
      startedAt,
      finishedAt,
      errorMessage: errMsg,
    });
    return {
      mode: 'visual',
      status: 'failed',
      message: errMsg,
      logs,
      connected: false,
      targetUrl,
      errorMessage: errMsg,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  }
}

async function crawlNativeFeed(feed: any, onLogLine?: (line: CrawlLogLine) => void): Promise<ManualCrawlResult> {
  const startedAt = new Date();
  const logs: ManualCrawlResult['logs'] = [];
  const log = makeFeedLogger(logs, onLogLine);
  const targetUrl = feed.url || null;
  log('info', `目标 URL：${targetUrl || '—'}`);

  if (!feed.url) {
    const finishedAt = new Date();
    const errMsg = '缺少 feed.url，未执行抓取';
    log('warn', errMsg);
    await recordCrawlerTaskHistory({
      feedId: feed.id,
      mode: 'native',
      status: 'skipped',
      startedAt,
      finishedAt,
      errorMessage: errMsg,
    });
    return {
      mode: 'native',
      status: 'skipped',
      message: errMsg,
      logs,
      targetUrl,
      errorMessage: errMsg,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  }

  const prisma = await getPrisma();
  try {
    const connFail = await ensureTargetReachable(feed, 'native', log, logs, startedAt, targetUrl);
    if (connFail) return connFail;

    log('info', '正在下载并解析 Feed…');
    const { CrawlerService } = await import('../services/crawler');
    console.log(`[Scheduler] 开始抓取原生Feed ID: ${feed.id}, URL: ${feed.url}`);
    const items = await CrawlerService.crawlNativeFeed(feed.url);
    log('ok', 'Feed 下载成功（HTTP 响应正常）');
    log('info', `Feed 解析完成，共 ${items.length} 条条目`);

    let newCount = 0;
    for (const item of items) {
      const normalizedTitle = (item.title || '无标题').trim();
      const existing = await findDuplicateArticleByUrlOrRecentTitle(prisma, {
        feedId: feed.id,
        title: normalizedTitle,
        url: item.link || null,
        urlField: 'url',
        feedField: 'feed_id',
      });
      if (existing) continue;

      try {
        await prisma.article.create({
          data: {
            feed_id: feed.id,
            title: normalizedTitle,
            description: item.description || null,
            url: item.link || null,
            author: item.author || null,
            pub_date: pubDateForDb(item.pubDate),
            created_at: new Date(),
            updated_at: new Date(),
          }
        });
        newCount++;
      } catch (createErr) {
        console.warn(`[Scheduler] 原生Feed ${feed.id} 单条入库跳过: ${normalizedTitle}`, createErr);
      }
    }

    await prisma.feed.update({
      where: { id: feed.id },
      data: {
        last_fetched_at: new Date(),
        anti_bot_status: 'normal',
        anti_bot_detected_at: null,
        anti_bot_message: null,
      }
    });
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    log('ok', `爬取完成：解析 ${items.length} 条，新增入库 ${newCount} 条`);
    console.log(`[Scheduler] 原生Feed ${feed.id} 抓取完成，新增 ${newCount} 篇文章`);
    await recordCrawlerTaskHistory({
      feedId: feed.id,
      mode: 'native',
      status: 'success',
      startedAt,
      finishedAt,
      newArticlesCount: newCount,
    });
    return {
      mode: 'native',
      status: 'success',
      message: `爬取成功，解析 ${items.length} 条，新增 ${newCount} 条`,
      logs,
      connected: true,
      targetUrl,
      parsedCount: items.length,
      newArticlesCount: newCount,
      durationMs,
    };
  } catch (error) {
    console.error(`[Scheduler] 原生Feed ${feed.id} 抓取失败:`, error);
    const errMsg = connectionErrorMessage(error);
    log('error', `连接或爬取失败：${errMsg}`);
    await markFeedCrawlerFailureStatus(prisma, feed.id, error).catch((updateError) => {
      console.error(`[Scheduler] 更新原生 Feed ${feed.id} 抓取失败状态失败:`, updateError);
    });
    const finishedAt = new Date();
    await recordCrawlerTaskHistory({
      feedId: feed.id,
      mode: 'native',
      status: 'failed',
      startedAt,
      finishedAt,
      errorMessage: errMsg,
    });
    return {
      mode: 'native',
      status: 'failed',
      message: errMsg,
      logs,
      connected: false,
      targetUrl,
      errorMessage: errMsg,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  }
}

/**
 * 管理后台手动触发：忽略更新间隔，立即按 Feed 类型执行一次爬取（与调度器逻辑一致）
 */
export async function runManualCrawlForFeed(
  feedId: number,
  options?: { onLogLine?: (line: CrawlLogLine) => void },
): Promise<ManualCrawlResult> {
  const prisma = await getPrisma();
  const feed = await prisma.feed.findUnique({ where: { id: feedId } });
  if (!feed) {
    throw new Error('Feed 不存在');
  }

  const onLogLine = options?.onLogLine;

  if (feed.source_type === 'native') {
    return crawlNativeFeed(feed, onLogLine);
  }

  if (feed.selector_rules && typeof feed.selector_rules === 'object' && (feed.selector_rules as any).listSelector) {
    return crawlVisualFeed(feed, onLogLine);
  }

  const logs: ManualCrawlResult['logs'] = [];
  const log = makeFeedLogger(logs, onLogLine);
  const startedAt = new Date();
  const targetUrl = feed.url || null;
  log('info', `目标 URL：${targetUrl || '—'}`);

  const connFail = await ensureTargetReachable(feed, 'queue', log, logs, startedAt, targetUrl);
  if (connFail) return connFail;

  log('info', '正在将任务加入 Redis 队列…');

  const job = await addCrawlJob({
    feedId: feed.id,
    url: feed.url || '',
    selectors: feed.selector_rules,
    isDynamic: false,
  });

  if (job) {
    const now = new Date();
    await recordCrawlerTaskHistory({
      feedId: feed.id,
      mode: 'queue',
      status: 'queued',
      startedAt: now,
      finishedAt: null,
      newArticlesCount: 0,
      errorMessage: null,
    });
    log('ok', `已加入队列（任务 ID: ${job.id}），等待 Worker 执行`);
    log('info', '可通过爬取日志轮询查看最终连接与入库结果');
    return {
      mode: 'queue',
      status: 'queued',
      message: '已加入队列异步爬取（Bull）',
      logs,
      targetUrl: feed.url || null,
    };
  }

  throw new Error('Redis 不可用或入队失败；请为该 Feed 配置可视化规则（listSelector）或使用原生 RSS URL');
}

// 定时任务：检查需要更新的feeds
export const scheduleCrawlJobs = async () => {
  try {
    const prisma = await getPrisma();

    const feeds = await prisma.feed.findMany({
      where: { is_active: true },
    });
    
    const now = new Date();
    
    for (const feed of feeds) {
      const lastFetched = feed.last_fetched_at || new Date(0);
      const interval = (feed.update_interval || 1800) * 1000;
      const nextUpdate = new Date(lastFetched.getTime() + interval);
      const strategy = await prisma.feedCrawlerStrategy.findUnique({ where: { feed_id: feed.id } }).catch(() => null);
      const cooldownUntil = strategy?.cooldown_until ? new Date(strategy.cooldown_until) : null;
      
      if (nextUpdate > now) continue;
      if (cooldownUntil && cooldownUntil > now) continue;
      if (strategy?.strategy_mode === 'disabled') continue;

      // 原生 feed：直接按 feed URL 抓取
      if (feed.source_type === 'native') {
        await crawlNativeFeed(feed);
        continue;
      }

      // 本地解析 feed（parsed）：按选择器规则抓取
      if (feed.selector_rules && typeof feed.selector_rules === 'object' && (feed.selector_rules as any).listSelector) {
        await crawlVisualFeed(feed);
        continue;
      }

      // 传统爬取：通过Redis队列
      const queueStartedAt = new Date();
      const job = await addCrawlJob({
        feedId: feed.id,
        url: feed.url || '',
        selectors: feed.selector_rules,
        isDynamic: false,
      });

      if (job) {
        console.log(`[Scheduler] 已调度爬取任务 Feed ID: ${feed.id}`);
      } else {
        const queueFinishedAt = new Date();
        await recordCrawlerTaskHistory({
          feedId: feed.id,
          mode: 'queue',
          status: 'failed',
          startedAt: queueStartedAt,
          finishedAt: queueFinishedAt,
          errorMessage: 'Redis 不可用或入队失败，未执行 Bull 爬取',
        });
      }
    }
  } catch (error) {
    console.error('[Scheduler] 调度出错:', error);
  }
};

// 启动定时任务
export const startScheduler = () => {
  console.log('Starting scheduler...');
  scheduleCrawlJobs();
  // 每分钟检查一次
  setInterval(scheduleCrawlJobs, 60000);
  console.log('Scheduler started');
};

/** 保证可被 JSON.stringify，避免 Fastify 在 reply 阶段因不可序列化字段整接口 500 */
function jsonSafe<T>(value: T): T | null {
  try {
    return JSON.parse(
      JSON.stringify(value, (_k, val) => (typeof val === 'bigint' ? String(val) : val))
    ) as T;
  } catch {
    return null;
  }
}

function safeJobProgress(raw: unknown): number | string {
  if (raw == null) return 0;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (typeof raw === 'number' || typeof raw === 'string') {
    return raw;
  }
  const s = jsonSafe(raw);
  return s != null ? JSON.stringify(s) : 0;
}

/** Redis 不可达时 Bull 可能长时间不 reject，导致管理接口一直 pending */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Redis/Bull 操作超时（${ms}ms）`)), ms);
    promise
      .then((v) => {
        clearTimeout(t);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(t);
        reject(e);
      });
  });
}

const queueSnapshotTimeoutMs = Math.max(
  1000,
  Math.min(30000, Number(process.env.CRAWL_QUEUE_SNAPSHOT_TIMEOUT_MS) || 5000)
);

export async function getCrawlerQueueSnapshot(limit: number = 100) {
  const safeLimit = Math.max(1, Math.min(limit, 300));
  if (!isRedisAvailable) {
    return {
      redisAvailable: false,
      counts: {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: 0,
      },
      jobs: [],
    };
  }

  try {
    const [counts, jobs] = await withTimeout(
      Promise.all([
        crawlQueue.getJobCounts(),
        crawlQueue.getJobs(
          ['active', 'waiting', 'delayed', 'failed', 'completed'],
          0,
          safeLimit - 1,
          false
        ),
      ]),
      queueSnapshotTimeoutMs
    );
    const mappedJobs = jobs.map((job) => {
      let progressVal: number | string = 0;
      try {
        const raw = typeof job.progress === 'function' ? job.progress() : 0;
        progressVal = safeJobProgress(raw);
      } catch {
        progressVal = 0;
      }
      const row = {
        id: job.id,
        state: job.finishedOn
          ? job.failedReason
            ? 'failed'
            : 'completed'
          : job.processedOn
            ? 'active'
            : job.opts?.delay && job.opts.delay > 0
              ? 'delayed'
              : 'waiting',
        data: job.data,
        attemptsMade: job.attemptsMade,
        opts: job.opts,
        progress: progressVal,
        timestamp: job.timestamp,
        processedOn: job.processedOn || null,
        finishedOn: job.finishedOn || null,
        failedReason: job.failedReason || null,
        stacktrace: Array.isArray(job.stacktrace) ? job.stacktrace : [],
        returnvalue: job.returnvalue ?? null,
      };
      const safe = jsonSafe(row);
      if (safe) {
        return safe;
      }
      // opts / returnvalue 等偶发循环引用时降级为最小字段
      return {
        id: job.id,
        state: row.state,
        data: jsonSafe(job.data),
        attemptsMade: job.attemptsMade ?? 0,
        opts: null,
        progress: typeof progressVal === 'number' || typeof progressVal === 'string' ? progressVal : 0,
        timestamp: job.timestamp ?? null,
        processedOn: job.processedOn || null,
        finishedOn: job.finishedOn || null,
        failedReason: typeof job.failedReason === 'string' ? job.failedReason : null,
        stacktrace: [],
        returnvalue: null,
        _note: '任务对象含不可 JSON 序列化内容，已省略部分字段',
      };
    });

    const safeCounts = jsonSafe(counts) ?? counts;

    return {
      redisAvailable: true,
      counts: safeCounts,
      jobs: mappedJobs,
    };
  } catch (error: any) {
    const msg = error?.message || '读取队列任务失败';
    if (String(msg).includes('超时')) {
      isRedisAvailable = false;
      console.warn(
        '[CrawlerQueue] 队列快照超时，已标记 Redis 不可用（避免管理接口长时间阻塞）；请检查 REDIS_URL 或启动 Redis'
      );
    }
    return {
      redisAvailable: false,
      error: msg,
      counts: {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: 0,
      },
      jobs: [],
    };
  }
}
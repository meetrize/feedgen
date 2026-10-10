import { server } from './server';
import { startBatchClassificationWorker } from './services/classification/classificationBatchQueue';
import { startClassificationWorker } from './services/classification/classificationQueue';
import { startTrainingWorker } from './services/classification/trainingQueue';
import { migrateLegacyGlobalConfigToAdmins } from './services/translation/translationConfig';
import { startCrawlerWorker, startScheduler } from './workers/crawlerWorker';

async function main() {
  try {
    await migrateLegacyGlobalConfigToAdmins();

    // 启动爬虫工作进程
    startCrawlerWorker();

    // 启动新闻分类队列 worker
    startClassificationWorker();

    // 启动批量分类队列 worker（限并发）
    startBatchClassificationWorker();

    // 启动训练队列 worker（concurrency=1）
    startTrainingWorker();
    
    // 启动调度器（低内存服务器可设 DISABLE_CRAWLER_SCHEDULER=1 暂停定时爬取）
    if (process.env.DISABLE_CRAWLER_SCHEDULER !== '1') {
      startScheduler();
    } else {
      console.log('Crawler scheduler disabled (DISABLE_CRAWLER_SCHEDULER=1)');
    }
    
    // 启动HTTP服务器
    // 服务器已经在server.ts中启动，这里主要是为了组织代码
    console.log('All services started successfully');
  } catch (error) {
    console.error('Failed to start services:', error);
    process.exit(1);
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}\n${err.stack || ''}`;
  return String(err ?? '');
}

/** 爬虫/Redis/网络等瞬时错误：只打日志，不退出进程，避免 API 连带不可用 */
function isTransientRuntimeError(err: unknown): boolean {
  const msg = errorText(err);
  return /Target page, context or browser has been closed|browser has been closed|Protocol error|cdpSession\.send|net::ERR_|TimeoutError|Navigation timeout|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|MaxRetriesPerRequestError|max retries per request|WritableIterable is closed|Browser closed|Executable doesn't exist/i.test(
    msg,
  );
}

function isFatalProcessError(err: unknown): boolean {
  const msg = errorText(err);
  return /out of memory|ENOMEM|heap out of memory|Cannot find module|listen EADDRINUSE/i.test(msg);
}

// 默认保持进程存活；仅致命错误退出，交给 systemd Restart=always 拉起
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  if (isTransientRuntimeError(err)) {
    console.error('[process] 忽略瞬时异常，保持服务运行');
    return;
  }
  if (isFatalProcessError(err)) {
    console.error('[process] 致命异常，退出由 systemd 重启');
    process.exit(1);
  }
  console.error('[process] 非致命未捕获异常，保持服务运行（请检查日志）');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  if (isTransientRuntimeError(reason) || !isFatalProcessError(reason)) {
    console.error('[process] 忽略未处理 Promise 拒绝，保持服务运行');
    return;
  }
  console.error('[process] 致命 Promise 拒绝，退出由 systemd 重启');
  process.exit(1);
});

// 启动应用
main();
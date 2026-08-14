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

function isTransientBrowserError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /Target page, context or browser has been closed|browser has been closed|Protocol error|cdpSession\.send|net::ERR_|TimeoutError|Navigation timeout/i.test(
    msg,
  );
}

// Playwright/爬虫偶发错误不应拖垮整个 API；仅对未知致命错误退出，交给 systemd 拉起
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  if (isTransientBrowserError(err)) {
    console.error('[process] 忽略瞬时浏览器异常，保持服务运行');
    return;
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  if (isTransientBrowserError(reason)) {
    console.error('[process] 忽略瞬时浏览器 Promise 拒绝，保持服务运行');
    return;
  }
  // 非瞬时错误仍退出，由 systemd Restart=on-failure 自动恢复
  process.exit(1);
});

// 启动应用
main();
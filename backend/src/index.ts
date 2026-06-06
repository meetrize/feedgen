import { server } from './server';
import { startBatchClassificationWorker } from './services/classification/classificationBatchQueue';
import { startClassificationWorker } from './services/classification/classificationQueue';
import { startTrainingWorker } from './services/classification/trainingQueue';
import { startCrawlerWorker, startScheduler } from './workers/crawlerWorker';

async function main() {
  try {
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

// 处理未捕获的异常
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// 启动应用
main();
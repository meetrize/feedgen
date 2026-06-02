import { server } from './server';
import { startCrawlerWorker, startScheduler } from './workers/crawlerWorker';

async function main() {
  try {
    // 启动爬虫工作进程
    startCrawlerWorker();
    
    // 启动调度器
    startScheduler();
    
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
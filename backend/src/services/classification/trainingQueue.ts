import Queue from 'bull';

import { runTrainingJob } from './trainingService';

export interface TrainingJobData {
  jobId: number;
}

const QUEUE_NAME = 'classification-train-queue';
const bullRedisOptions = { maxRetriesPerRequest: null };

let trainingQueue: Queue.Queue<TrainingJobData>;
let isRedisAvailable = true;
let workerStarted = false;

try {
  trainingQueue = new Queue<TrainingJobData>(
    QUEUE_NAME,
    process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    {
      redis: bullRedisOptions,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 20,
        removeOnFail: 20,
      },
    },
  );

  let redisErrorLogged = false;
  trainingQueue.on('error', (error: Error) => {
    const msg = error.message || '';
    if (msg.includes('max retries per request') || msg.includes('MaxRetriesPerRequest')) {
      isRedisAvailable = false;
      if (!redisErrorLogged) {
        console.warn('[TrainingQueue] Redis 连接异常，训练队列不可用');
        redisErrorLogged = true;
      }
      return;
    }
    if (!redisErrorLogged && msg.includes('ECONNREFUSED')) {
      isRedisAvailable = false;
      redisErrorLogged = true;
    } else if (!msg.includes('ECONNREFUSED')) {
      console.error('[TrainingQueue] 队列错误:', msg);
    }
  });
} catch (error: unknown) {
  console.error(
    '[TrainingQueue] 初始化失败:',
    error instanceof Error ? error.message : String(error),
  );
  trainingQueue = new Queue<TrainingJobData>(
    QUEUE_NAME,
    process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    { redis: bullRedisOptions },
  );
}

export async function enqueueTrainingJob(jobId: number): Promise<Queue.Job<TrainingJobData> | null> {
  if (!isRedisAvailable) {
    console.warn('[TrainingQueue] Redis 不可用，无法入队训练任务');
    return null;
  }

  try {
    return await trainingQueue.add({ jobId });
  } catch (error) {
    console.error(
      `[TrainingQueue] 入队失败 jobId=${jobId}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

export function startTrainingWorker(): void {
  if (workerStarted) {
    return;
  }
  workerStarted = true;

  if (!isRedisAvailable) {
    console.warn('[TrainingQueue] Redis 不可用，训练 worker 未启动');
    return;
  }

  console.log('Starting classification training worker...');

  trainingQueue.process(1, async (job: Queue.Job<TrainingJobData>) => {
    console.log(`[TrainingQueue] 处理训练任务 jobId=${job.data.jobId}`);
    await runTrainingJob(job.data.jobId);
  });

  trainingQueue.on('completed', (job: Queue.Job<TrainingJobData>) => {
    console.log(`[TrainingQueue] 训练完成 jobId=${job.data.jobId}`);
  });

  trainingQueue.on('failed', (job: Queue.Job<TrainingJobData> | undefined, err: Error) => {
    console.error(
      `[TrainingQueue] 训练失败 jobId=${job?.data.jobId ?? 'unknown'}:`,
      err.message,
    );
  });

  console.log('Classification training worker started');
}

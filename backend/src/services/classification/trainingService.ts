import type { Prisma } from '@prisma/client';

import { prisma } from '../../server';
import * as mlClient from './mlClient';
import { enqueueTrainingJob } from './trainingQueue';

const MIN_TRAINING_SAMPLES = 20;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

export type TrainingJobSummary = {
  id: number;
  status: string;
  progress: number;
  stage: string | null;
  train_count: number | null;
  val_count: number | null;
  category_count: number | null;
  trigger_reason: string | null;
  metrics_json: string | null;
  model_version: string | null;
  error_msg: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
};

export type ModelVersionSummary = {
  id: number;
  version: string;
  path: string;
  metrics: string | null;
  is_active: boolean;
  created_at: Date;
};

type TrainingSample = {
  title: string;
  category_id: number;
  category_code: string;
};

async function loadLatestTrainingSamples(): Promise<TrainingSample[]> {
  const annotations = await prisma.classificationAnnotation.findMany({
    orderBy: [{ article_id: 'asc' }, { created_at: 'desc' }],
    include: {
      article: { select: { title: true } },
      category: { select: { id: true, code: true, status: true } },
    },
  });

  const latestByArticle = new Map<number, TrainingSample>();
  for (const row of annotations) {
    if (latestByArticle.has(row.article_id)) {
      continue;
    }
    const title = row.article.title?.trim();
    if (!title || row.category.status !== 'active') {
      continue;
    }
    latestByArticle.set(row.article_id, {
      title,
      category_id: row.category_id,
      category_code: row.category.code,
    });
  }

  return [...latestByArticle.values()];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toJobSummary(job: {
  id: number;
  status: string;
  progress: number;
  stage: string | null;
  train_count: number | null;
  val_count: number | null;
  category_count: number | null;
  trigger_reason: string | null;
  metrics_json: string | null;
  model_version: string | null;
  error_msg: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}): TrainingJobSummary {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    train_count: job.train_count,
    val_count: job.val_count,
    category_count: job.category_count,
    trigger_reason: job.trigger_reason,
    metrics_json: job.metrics_json,
    model_version: job.model_version,
    error_msg: job.error_msg,
    started_at: job.started_at,
    finished_at: job.finished_at,
    created_at: job.created_at,
  };
}

export async function startTraining(triggerReason = 'manual'): Promise<TrainingJobSummary> {
  const samples = await loadLatestTrainingSamples();
  if (samples.length < MIN_TRAINING_SAMPLES) {
    throw new Error(`训练样本不足，至少需要 ${MIN_TRAINING_SAMPLES} 条标注（当前 ${samples.length} 条）`);
  }

  const categoryCount = new Set(samples.map((item) => item.category_id)).size;
  if (categoryCount < 2) {
    throw new Error('训练至少需要 2 个不同类别');
  }

  const job = await prisma.classificationTrainingJob.create({
    data: {
      status: 'pending',
      progress: 0,
      stage: 'queued',
      train_count: samples.length,
      category_count: categoryCount,
      trigger_reason: triggerReason,
    },
  });

  const queued = await enqueueTrainingJob(job.id);
  if (!queued) {
    await prisma.classificationTrainingJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        error_msg: 'Redis 不可用，训练任务入队失败',
        finished_at: new Date(),
      },
    });
    throw new Error('Redis 不可用，训练任务入队失败');
  }

  return toJobSummary(job);
}

export async function runTrainingJob(jobId: number): Promise<void> {
  const job = await prisma.classificationTrainingJob.findUnique({ where: { id: jobId } });
  if (!job) {
    throw new Error('训练任务不存在');
  }

  const samples = await loadLatestTrainingSamples();
  if (samples.length < MIN_TRAINING_SAMPLES) {
    await prisma.classificationTrainingJob.update({
      where: { id: jobId },
      data: {
        status: 'failed',
        error_msg: `训练样本不足（${samples.length} 条）`,
        finished_at: new Date(),
      },
    });
    return;
  }

  await prisma.classificationTrainingJob.update({
    where: { id: jobId },
    data: {
      status: 'running',
      started_at: new Date(),
      progress: 0,
      stage: 'starting',
      train_count: samples.length,
      category_count: new Set(samples.map((item) => item.category_id)).size,
    },
  });

  try {
    await mlClient.startTraining(
      jobId,
      samples.map((item) => ({
        title: item.title,
        category_id: item.category_id,
        category_code: item.category_code,
      })),
    );

    const startedAt = Date.now();
    let lastProgress = 0;

    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
      const progress = await mlClient.getTrainingProgress(jobId);
      lastProgress = progress.progress;

      await prisma.classificationTrainingJob.update({
        where: { id: jobId },
        data: {
          progress: progress.progress,
          stage: progress.stage ?? null,
          status: progress.status === 'failed' ? 'failed' : 'running',
          error_msg: progress.error ?? null,
        },
      });

      if (progress.status === 'completed') {
        const metrics = progress.metrics ?? {};
        const version = progress.version;
        const modelPath = progress.path;

        if (!version || !modelPath) {
          throw new Error('训练完成但未返回模型版本或路径');
        }

        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await tx.classificationModelVersion.upsert({
            where: { version },
            create: {
              version,
              path: modelPath,
              metrics: JSON.stringify(metrics),
              is_active: false,
            },
            update: {
              path: modelPath,
              metrics: JSON.stringify(metrics),
            },
          });

          await tx.classificationTrainingJob.update({
            where: { id: jobId },
            data: {
              status: 'completed',
              progress: 100,
              stage: 'done',
              model_version: version,
              metrics_json: JSON.stringify(metrics),
              train_count: (metrics.train_count as number | undefined) ?? samples.length,
              val_count: (metrics.val_count as number | undefined) ?? null,
              category_count: (metrics.category_count as number | undefined) ?? null,
              finished_at: new Date(),
              error_msg: null,
            },
          });
        });
        return;
      }

      if (progress.status === 'failed') {
        await prisma.classificationTrainingJob.update({
          where: { id: jobId },
          data: {
            status: 'failed',
            progress: progress.progress,
            stage: progress.stage ?? 'failed',
            error_msg: progress.error ?? '训练失败',
            finished_at: new Date(),
          },
        });
        return;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    throw new Error(`训练超时（最后进度 ${lastProgress}%）`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.classificationTrainingJob.update({
      where: { id: jobId },
      data: {
        status: 'failed',
        error_msg: message,
        finished_at: new Date(),
      },
    });
    throw error;
  }
}

export async function listTrainingJobs(limit = 20): Promise<TrainingJobSummary[]> {
  const jobs = await prisma.classificationTrainingJob.findMany({
    orderBy: { created_at: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
  });
  return jobs.map(toJobSummary);
}

export async function getTrainingJob(jobId: number): Promise<TrainingJobSummary | null> {
  const job = await prisma.classificationTrainingJob.findUnique({ where: { id: jobId } });
  return job ? toJobSummary(job) : null;
}

export async function getActiveModel(): Promise<ModelVersionSummary | null> {
  const model = await prisma.classificationModelVersion.findFirst({
    where: { is_active: true },
    orderBy: { created_at: 'desc' },
  });
  if (!model) {
    return null;
  }
  return {
    id: model.id,
    version: model.version,
    path: model.path,
    metrics: model.metrics,
    is_active: model.is_active,
    created_at: model.created_at,
  };
}

export async function listModelVersions(): Promise<ModelVersionSummary[]> {
  const models = await prisma.classificationModelVersion.findMany({
    orderBy: { created_at: 'desc' },
  });
  return models.map((model: {
    id: number;
    version: string;
    path: string;
    metrics: string | null;
    is_active: boolean;
    created_at: Date;
  }) => ({
    id: model.id,
    version: model.version,
    path: model.path,
    metrics: model.metrics,
    is_active: model.is_active,
    created_at: model.created_at,
  }));
}

export async function publishModelVersion(version: string): Promise<ModelVersionSummary> {
  const model = await prisma.classificationModelVersion.findUnique({ where: { version } });
  if (!model) {
    throw new Error('模型版本不存在');
  }

  await mlClient.reloadModel(model.version, model.path);

  const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.classificationModelVersion.updateMany({
      data: { is_active: false },
      where: { is_active: true },
    });
    return tx.classificationModelVersion.update({
      where: { version },
      data: { is_active: true },
    });
  });

  return {
    id: updated.id,
    version: updated.version,
    path: updated.path,
    metrics: updated.metrics,
    is_active: updated.is_active,
    created_at: updated.created_at,
  };
}

import type { Prisma } from '@prisma/client';

import { prisma } from '../../server';
import {
  enqueueBatchClassificationJob,
  getBatchClassificationJob,
} from './classificationBatchQueue';

export type BatchClassifyInput = {
  article_ids?: number[];
  feed_id?: number;
  since?: string;
  only_unclassified?: boolean;
  limit?: number;
};

export type BatchClassifyResult = {
  job_id: string | number;
  total: number;
};

export type BatchClassifyProgress = {
  job_id: string | number;
  status: string;
  progress: number;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  error?: string | null;
};

const DEFAULT_BATCH_LIMIT = 5000;
const MAX_BATCH_LIMIT = 20000;

function parseSinceDate(raw: string): Date {
  const value = raw.trim();
  if (!value) {
    throw new Error('since 不能为空');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('since 日期格式无效');
  }
  return date;
}

export async function resolveBatchArticleIds(input: BatchClassifyInput): Promise<number[]> {
  if (input.article_ids?.length) {
    return [...new Set(input.article_ids.filter((id) => Number.isInteger(id) && id > 0))];
  }

  const where: Prisma.ArticleWhereInput = {};

  if (input.feed_id != null) {
    const feedId = Number(input.feed_id);
    if (!Number.isFinite(feedId) || feedId <= 0) {
      throw new Error('feed_id 无效');
    }
    const feed = await prisma.feed.findUnique({
      where: { id: feedId },
      select: { id: true },
    });
    if (!feed) {
      throw new Error('Feed 不存在');
    }
    where.feed_id = feedId;
  }

  if (input.since) {
    const sinceDate = parseSinceDate(input.since);
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      {
        OR: [{ created_at: { gte: sinceDate } }, { pub_date: { gte: sinceDate } }],
      },
    ];
  }

  const onlyUnclassified = input.only_unclassified !== false;
  if (onlyUnclassified) {
    where.classification = null;
  }

  const limitRaw = input.limit ?? DEFAULT_BATCH_LIMIT;
  const take = Math.min(Math.max(Number(limitRaw) || DEFAULT_BATCH_LIMIT, 1), MAX_BATCH_LIMIT);

  const rows = await prisma.article.findMany({
    where,
    select: { id: true },
    orderBy: [{ id: 'desc' }],
    take,
  });

  return rows.map((row: { id: number }) => row.id);
}

export async function submitBatchClassification(
  input: BatchClassifyInput,
): Promise<BatchClassifyResult> {
  const articleIds = await resolveBatchArticleIds(input);
  if (!articleIds.length) {
    throw new Error('没有符合条件的文章需要分类');
  }

  const job = await enqueueBatchClassificationJob(articleIds);
  if (!job) {
    throw new Error('Redis 不可用，批量分类任务入队失败');
  }

  return {
    job_id: job.id,
    total: articleIds.length,
  };
}

export async function getBatchClassificationProgress(
  jobId: string | number,
): Promise<BatchClassifyProgress | null> {
  const job = await getBatchClassificationJob(jobId);
  if (!job) {
    return null;
  }

  const data = job.data as { articleIds?: number[]; processed?: number; succeeded?: number; failed?: number };
  const total = data.articleIds?.length ?? 0;
  const processed = data.processed ?? 0;
  const succeeded = data.succeeded ?? 0;
  const failed = data.failed ?? 0;
  const progress = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : Number(job.progress() || 0);

  const state = await job.getState();
  const status = state === 'completed' ? 'completed' : state;

  return {
    job_id: job.id,
    status,
    progress,
    total,
    processed,
    succeeded,
    failed,
    error: job.failedReason || null,
  };
}

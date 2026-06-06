import type { Prisma } from '@prisma/client';

import { prisma } from '../../server';

export type PendingQuery = {
  need_review?: boolean;
  limit?: number;
  offset?: number;
  category_id?: number;
  feed_id?: number;
};

export type PendingItem = {
  article_id: number;
  title: string;
  feed_id: number;
  feed_title: string;
  ai_category: {
    id: number;
    code: string;
    name: string;
    color: string | null;
  } | null;
  confidence: number | null;
  need_review: boolean;
  classified_at: Date | null;
};

export type AnnotateInput = {
  article_ids: number[];
  category_id: number;
  labeled_by?: number;
};

export type AnnotateResultItem = {
  article_id: number;
  category_id: number;
  source: string;
  annotation_id: number;
};

export type AnnotationStats = {
  pending_review_count: number;
  annotated_today: number;
  by_category: Array<{
    category_id: number;
    code: string;
    name: string;
    annotation_count: number;
  }>;
};

function parsePagination(limit?: number, offset?: number) {
  const parsedLimit = Number(limit);
  const parsedOffset = Number(offset);
  return {
    limit: Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 200) : 50,
    offset: Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0,
  };
}

export async function listPending(query: PendingQuery = {}): Promise<{
  total: number;
  limit: number;
  offset: number;
  items: PendingItem[];
}> {
  const needReview = query.need_review !== false;
  const { limit, offset } = parsePagination(query.limit, query.offset);

  const where: Record<string, unknown> = {
    need_review: needReview,
    article: {},
  };

  if (query.category_id != null) {
    where.category_id = query.category_id;
  }

  if (query.feed_id != null) {
    (where.article as Record<string, unknown>).feed_id = query.feed_id;
  }

  const [total, rows] = await Promise.all([
    prisma.articleClassification.count({ where: where as any }),
    prisma.articleClassification.findMany({
      where: where as any,
      include: {
        article: {
          include: {
            feeds: { select: { id: true, title: true } },
          },
        },
        category: {
          select: { id: true, code: true, name: true, color: true },
        },
      },
      orderBy: [{ confidence: 'asc' }, { classified_at: 'desc' }],
      skip: offset,
      take: limit,
    }),
  ]);

  const items: PendingItem[] = rows.map((row: (typeof rows)[number]) => ({
    article_id: row.article_id,
    title: row.article.title,
    feed_id: row.article.feed_id,
    feed_title: row.article.feeds.title,
    ai_category: row.category
      ? {
          id: row.category.id,
          code: row.category.code,
          name: row.category.name,
          color: row.category.color,
        }
      : null,
    confidence: row.confidence,
    need_review: row.need_review,
    classified_at: row.classified_at,
  }));

  return { total, limit, offset, items };
}

export async function annotateArticles(input: AnnotateInput): Promise<AnnotateResultItem[]> {
  const articleIds = [...new Set(input.article_ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (!articleIds.length) {
    throw new Error('article_ids 不能为空');
  }

  const category = await prisma.newsCategory.findUnique({
    where: { id: input.category_id },
    select: { id: true, status: true },
  });
  if (!category) {
    throw new Error('类别不存在');
  }
  if (category.status !== 'active') {
    throw new Error('类别已禁用，无法标注');
  }

  const articles = await prisma.article.findMany({
    where: { id: { in: articleIds } },
    select: { id: true },
  });
  if (articles.length !== articleIds.length) {
    throw new Error('部分文章不存在');
  }

  const existingClassifications = await prisma.articleClassification.findMany({
    where: { article_id: { in: articleIds } },
    select: { article_id: true, category_id: true, model_version: true },
  });
  const existingByArticle = new Map<
    number,
    { article_id: number; category_id: number | null; model_version: string | null }
  >(existingClassifications.map((row: (typeof existingClassifications)[number]) => [row.article_id, row]));

  const results: AnnotateResultItem[] = [];

  for (const articleId of articleIds) {
    const existing = existingByArticle.get(articleId);
    const source =
      existing?.category_id != null && existing.category_id !== input.category_id
        ? 'corrected'
        : 'manual';

    const annotated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.articleClassification.upsert({
        where: { article_id: articleId },
        create: {
          article_id: articleId,
          category_id: input.category_id,
          confidence: 1.0,
          model_version: existing?.model_version ?? null,
          need_review: false,
          classified_at: new Date(),
        },
        update: {
          category_id: input.category_id,
          confidence: 1.0,
          need_review: false,
          classified_at: new Date(),
        },
      });

      const annotation = await tx.classificationAnnotation.create({
        data: {
          article_id: articleId,
          category_id: input.category_id,
          labeled_by: input.labeled_by ?? null,
          source,
          model_version: existing?.model_version ?? null,
        },
      });

      return annotation;
    });

    results.push({
      article_id: articleId,
      category_id: input.category_id,
      source,
      annotation_id: annotated.id,
    });
  }

  return results;
}

export async function getAnnotationStats(): Promise<AnnotationStats> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [pendingReviewCount, annotatedToday, categories, annotationGroups] = await Promise.all([
    prisma.articleClassification.count({ where: { need_review: true } }),
    prisma.classificationAnnotation.count({
      where: { created_at: { gte: todayStart } },
    }),
    prisma.newsCategory.findMany({
      where: { status: 'active' },
      select: { id: true, code: true, name: true },
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    }),
    prisma.classificationAnnotation.groupBy({
      by: ['category_id'],
      _count: { _all: true },
    }),
  ]);

  const countMap = new Map(
    annotationGroups.map((row: (typeof annotationGroups)[number]) => [
      row.category_id,
      row._count._all,
    ]),
  );

  return {
    pending_review_count: pendingReviewCount,
    annotated_today: annotatedToday,
    by_category: categories.map((category: (typeof categories)[number]) => ({
      category_id: category.id,
      code: category.code,
      name: category.name,
      annotation_count: countMap.get(category.id) ?? 0,
    })),
  };
}

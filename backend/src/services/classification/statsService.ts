import { prisma } from '../../server';
import { getAnnotationStats } from './annotationService';
import { getActiveModel } from './trainingService';

export type CategoryArticleCount = {
  category_id: number | null;
  code: string | null;
  name: string;
  color: string | null;
  article_count: number;
  need_review_count: number;
};

export type AccuracySampleItem = {
  article_id: number;
  title: string;
  human_category_id: number;
  human_category_name: string;
  human_category_code: string;
  ai_category_id: number | null;
  ai_category_name: string | null;
  ai_category_code: string | null;
  annotation_source: string;
  ai_match: boolean;
  confidence: number | null;
  annotated_at: Date;
};

export type ClassificationReport = {
  overview: {
    total_articles: number;
    total_classified: number;
    unclassified_count: number;
    pending_review_count: number;
    annotated_total: number;
    annotated_today: number;
    active_model_version: string | null;
    active_model_accuracy: number | null;
    active_model_macro_f1: number | null;
  };
  article_counts: CategoryArticleCount[];
  annotation_by_category: Array<{
    category_id: number;
    code: string;
    name: string;
    annotation_count: number;
  }>;
  accuracy_sample: {
    sample_size: number;
    agreement_count: number;
    corrected_count: number;
    agreement_rate: number | null;
    items: AccuracySampleItem[];
  };
};

const DEFAULT_SAMPLE_SIZE = 50;
const MAX_SAMPLE_SIZE = 200;

function parseMetrics(raw: string | null): { accuracy: number | null; macro_f1: number | null } {
  if (!raw) {
    return { accuracy: null, macro_f1: null };
  }
  try {
    const metrics = JSON.parse(raw) as { accuracy?: number; macro_f1?: number };
    return {
      accuracy: metrics.accuracy ?? null,
      macro_f1: metrics.macro_f1 ?? null,
    };
  } catch {
    return { accuracy: null, macro_f1: null };
  }
}

async function loadLatestAnnotationSamples(sampleSize: number): Promise<AccuracySampleItem[]> {
  const annotations = await prisma.classificationAnnotation.findMany({
    orderBy: [{ article_id: 'asc' }, { created_at: 'desc' }],
    include: {
      article: {
        select: {
          title: true,
          classification: {
            select: {
              category_id: true,
              confidence: true,
              category: {
                select: { id: true, name: true, code: true },
              },
            },
          },
        },
      },
      category: {
        select: { id: true, name: true, code: true },
      },
    },
  });

  const latestByArticle = new Map<number, (typeof annotations)[number]>();
  for (const row of annotations) {
    if (!latestByArticle.has(row.article_id)) {
      latestByArticle.set(row.article_id, row);
    }
  }

  const samples = [...latestByArticle.values()]
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
    .slice(0, sampleSize);

  return samples.map((row) => {
    const classification = row.article.classification;
    const aiMatch = row.source !== 'corrected';
    return {
      article_id: row.article_id,
      title: row.article.title?.trim() || `文章 #${row.article_id}`,
      human_category_id: row.category_id,
      human_category_name: row.category.name,
      human_category_code: row.category.code,
      ai_category_id: classification?.category_id ?? null,
      ai_category_name: classification?.category?.name ?? null,
      ai_category_code: classification?.category?.code ?? null,
      annotation_source: row.source,
      ai_match: aiMatch,
      confidence: classification?.confidence ?? null,
      annotated_at: row.created_at,
    };
  });
}

export async function getClassificationReport(sampleSizeInput?: number): Promise<ClassificationReport> {
  const sampleSize = Math.min(
    Math.max(Number(sampleSizeInput) || DEFAULT_SAMPLE_SIZE, 1),
    MAX_SAMPLE_SIZE,
  );

  const [
    annotationStats,
    activeModel,
    totalArticles,
    classifiedRows,
    classifiedWithCategory,
    classifiedGroups,
    needReviewGroups,
    annotatedTotal,
    sampleItems,
  ] = await Promise.all([
    getAnnotationStats(),
    getActiveModel(),
    prisma.article.count(),
    prisma.articleClassification.count(),
    prisma.articleClassification.count({ where: { category_id: { not: null } } }),
    prisma.articleClassification.groupBy({
      by: ['category_id'],
      where: { category_id: { not: null } },
      _count: { _all: true },
    }),
    prisma.articleClassification.groupBy({
      by: ['category_id'],
      where: { need_review: true, category_id: { not: null } },
      _count: { _all: true },
    }),
    prisma.classificationAnnotation.findMany({
      distinct: ['article_id'],
      select: { article_id: true },
    }),
    loadLatestAnnotationSamples(sampleSize),
  ]);

  const categories = await prisma.newsCategory.findMany({
    where: { status: 'active' },
    select: { id: true, code: true, name: true, color: true },
    orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
  });

  const classifiedCountMap = new Map<number, number>(
    classifiedGroups.map((row: { category_id: number; _count: { _all: number } }) => [
      row.category_id,
      row._count._all,
    ]),
  );
  const needReviewCountMap = new Map<number, number>(
    needReviewGroups.map((row: { category_id: number; _count: { _all: number } }) => [
      row.category_id,
      row._count._all,
    ]),
  );

  const unclassifiedCount = Math.max(0, totalArticles - classifiedWithCategory);
  const nullCategoryCount = classifiedRows - classifiedWithCategory;

  type CategoryRow = { id: number; code: string; name: string; color: string | null };
  const articleCounts: CategoryArticleCount[] = (categories as CategoryRow[]).map((cat) => ({
    category_id: cat.id,
    code: cat.code,
    name: cat.name,
    color: cat.color,
    article_count: classifiedCountMap.get(cat.id) ?? 0,
    need_review_count: needReviewCountMap.get(cat.id) ?? 0,
  }));

  const unclassifiedTotal = unclassifiedCount + nullCategoryCount;
  if (unclassifiedTotal > 0) {
    articleCounts.push({
      category_id: null,
      code: null,
      name: '未分类',
      color: null,
      article_count: unclassifiedTotal,
      need_review_count: 0,
    });
  }

  const modelMetrics = parseMetrics(activeModel?.metrics ?? null);
  const correctedCount = sampleItems.filter((item) => !item.ai_match).length;
  const agreementCount = sampleItems.length - correctedCount;
  const agreementRate =
    sampleItems.length > 0 ? Math.round((agreementCount / sampleItems.length) * 10000) / 10000 : null;

  return {
    overview: {
      total_articles: totalArticles,
      total_classified: classifiedWithCategory,
      unclassified_count: unclassifiedTotal,
      pending_review_count: annotationStats.pending_review_count,
      annotated_total: annotatedTotal.length,
      annotated_today: annotationStats.annotated_today,
      active_model_version: activeModel?.version ?? null,
      active_model_accuracy: modelMetrics.accuracy,
      active_model_macro_f1: modelMetrics.macro_f1,
    },
    article_counts: articleCounts,
    annotation_by_category: annotationStats.by_category,
    accuracy_sample: {
      sample_size: sampleItems.length,
      agreement_count: agreementCount,
      corrected_count: correctedCount,
      agreement_rate: agreementRate,
      items: sampleItems,
    },
  };
}

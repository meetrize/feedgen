import { prisma } from '../../server';
import { computeClusterBoost } from './clusterBoost';
import {
  computeEditorialScore,
  computeFinanceScore,
  computeFreshnessScore,
  computeSourceScore,
  extractHost,
  type FinanceHitFeature,
} from './featureExtract';
import {
  DEFAULT_WEIGHTS,
  IMPORTANCE_MODEL_VERSION,
  isImportanceEnabled,
  scoreToStars,
  type ImportanceWeights,
} from './importanceConfig';

export type ArticleImportanceResult = {
  article_id: number;
  stars: number;
  score: number;
  factors: Record<string, unknown>;
  model_version: string;
  scored_at: Date;
};

export type ScoreImportanceOptions = {
  /** 跳过跨源聚类（历史回填加速；默认 false） */
  skipCluster?: boolean;
};

type SourceWeightCache = {
  byFeed: Map<number, number>;
  byHost: Map<string, number>;
  loadedAt: number;
};

let sourceWeightCache: SourceWeightCache | null = null;
const SOURCE_WEIGHT_CACHE_TTL_MS = 60_000;

async function getSourceWeightCache(): Promise<SourceWeightCache> {
  const now = Date.now();
  if (sourceWeightCache && now - sourceWeightCache.loadedAt < SOURCE_WEIGHT_CACHE_TTL_MS) {
    return sourceWeightCache;
  }
  const rows = await prisma.importanceSourceWeight.findMany({
    select: { feed_id: true, host: true, weight: true },
  });
  const byFeed = new Map<number, number>();
  const byHost = new Map<string, number>();
  for (const row of rows as Array<{ feed_id: number | null; host: string | null; weight: number }>) {
    if (row.feed_id != null) byFeed.set(row.feed_id, row.weight);
    if (row.host) byHost.set(row.host.toLowerCase(), row.weight);
  }
  sourceWeightCache = { byFeed, byHost, loadedAt: now };
  return sourceWeightCache;
}

function clamp01to100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function effectiveWeights(skipCluster: boolean): ImportanceWeights {
  if (!skipCluster) return DEFAULT_WEIGHTS;
  const raw = {
    source: DEFAULT_WEIGHTS.source,
    editorial: DEFAULT_WEIGHTS.editorial,
    finance: DEFAULT_WEIGHTS.finance,
    cluster: 0,
    freshness: DEFAULT_WEIGHTS.freshness,
  };
  const sum = raw.source + raw.editorial + raw.finance + raw.freshness;
  if (sum <= 0) return DEFAULT_WEIGHTS;
  return {
    source: raw.source / sum,
    editorial: raw.editorial / sum,
    finance: raw.finance / sum,
    cluster: 0,
    freshness: raw.freshness / sum,
  };
}

function weightedTotal(
  parts: Record<keyof ImportanceWeights, number>,
  weights: ImportanceWeights = DEFAULT_WEIGHTS,
): number {
  const total =
    parts.source * weights.source +
    parts.editorial * weights.editorial +
    parts.finance * weights.finance +
    parts.cluster * weights.cluster +
    parts.freshness * weights.freshness;
  return clamp01to100(total);
}

export async function scoreArticleImportance(
  articleId: number,
  options: ScoreImportanceOptions = {},
): Promise<ArticleImportanceResult> {
  if (!isImportanceEnabled()) {
    throw new Error('重要度功能已关闭（IMPORTANCE_ENABLED=0）');
  }

  const skipCluster = !!options.skipCluster;

  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: {
      id: true,
      title: true,
      description: true,
      url: true,
      pub_date: true,
      created_at: true,
      feed_id: true,
      public_feed_id: true,
      feeds: { select: { id: true, url: true } },
      classification: {
        select: {
          category: { select: { code: true } },
        },
      },
      finance_instruments: {
        select: {
          matched_keyword: true,
          instrument: { select: { id: true, priority: true } },
        },
      },
    },
  });

  if (!article) {
    throw new Error('文章不存在');
  }

  const title = (article.title || '').trim();
  if (!title) {
    throw new Error('文章标题为空，无法评分');
  }

  const feedId = article.feed_id ?? article.feeds?.id ?? null;
  const feedUrl = article.feeds?.url ?? null;
  const host = extractHost(article.url) || extractHost(feedUrl);

  const weightCache = await getSourceWeightCache();
  const dbFeedWeight = feedId != null ? weightCache.byFeed.get(feedId) ?? null : null;
  const dbHostWeight = host ? weightCache.byHost.get(host) ?? null : null;

  const source = computeSourceScore({
    feedId,
    feedUrl,
    articleUrl: article.url,
    dbFeedWeight,
    dbHostWeight,
  });

  const editorial = computeEditorialScore({
    title,
    description: article.description,
    categoryCode: article.classification?.category?.code ?? null,
  });

  const financeHits: FinanceHitFeature[] = (article.finance_instruments || []).map(
    (row: {
      matched_keyword: string;
      instrument: { id: number; priority: number };
    }) => ({
      instrument_id: row.instrument.id,
      priority: row.instrument.priority ?? 100,
      matched_keyword: row.matched_keyword,
    }),
  );

  const finance = computeFinanceScore({
    title,
    description: article.description,
    hits: financeHits,
  });

  const refDate = article.pub_date || article.created_at;
  const freshness = computeFreshnessScore(refDate);

  const cluster = skipCluster
    ? {
        score: 0,
        similar_count: 0,
        distinct_sources: 0,
        threshold: 0,
        skipped_reason: 'backfill_skip',
      }
    : await computeClusterBoost({
        articleId: article.id,
        title,
        feedId: article.feed_id,
        publicFeedId: article.public_feed_id,
        refDate,
      });

  const weights = effectiveWeights(skipCluster);
  const parts = {
    source: source.score,
    editorial: editorial.score,
    finance: finance.score,
    cluster: cluster.score,
    freshness: freshness.score,
  };

  const score = Math.round(weightedTotal(parts, weights) * 10) / 10;
  const stars = scoreToStars(score);
  const scoredAt = new Date();

  const factors: Record<string, unknown> = {
    weights,
    skip_cluster: skipCluster,
    parts,
    source,
    editorial,
    finance,
    cluster,
    freshness,
  };

  const record = await prisma.articleImportance.upsert({
    where: { article_id: articleId },
    create: {
      article_id: articleId,
      stars,
      score,
      factors,
      model_version: IMPORTANCE_MODEL_VERSION,
      scored_at: scoredAt,
    },
    update: {
      stars,
      score,
      factors,
      model_version: IMPORTANCE_MODEL_VERSION,
      scored_at: scoredAt,
    },
  });

  // 重要度达标后异步抓取原文正文（不阻塞评分）
  try {
    const { maybeEnqueueFulltextAfterScore } = await import('../fulltext/fulltextQueue');
    await maybeEnqueueFulltextAfterScore(record.article_id, record.stars);
  } catch (err) {
    console.warn(
      `[Importance] 正文抓取入队失败 articleId=${articleId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  return {
    article_id: record.article_id,
    stars: record.stars,
    score: record.score,
    factors: (record.factors as Record<string, unknown>) || factors,
    model_version: record.model_version || IMPORTANCE_MODEL_VERSION,
    scored_at: record.scored_at,
  };
}

export type BackfillImportanceInput = {
  article_ids?: number[];
  feed_id?: number;
  since?: string;
  only_unscored?: boolean;
  limit?: number;
};

export async function resolveImportanceBackfillIds(
  input: BackfillImportanceInput,
): Promise<number[]> {
  const limit = Math.min(Math.max(Number(input.limit) || 2000, 1), 20000);
  const onlyUnscored = input.only_unscored !== false;

  if (input.article_ids?.length) {
    return [...new Set(input.article_ids.filter((id) => Number.isInteger(id) && id > 0))];
  }

  const where: any = {};
  if (input.feed_id != null && Number.isFinite(Number(input.feed_id))) {
    where.feed_id = Number(input.feed_id);
  }
  if (input.since?.trim()) {
    const sinceDate = new Date(input.since.trim());
    if (!Number.isNaN(sinceDate.getTime())) {
      where.created_at = { gte: sinceDate };
    }
  }
  if (onlyUnscored) {
    where.importance = null;
  }

  const rows = await prisma.article.findMany({
    where,
    select: { id: true },
    orderBy: { id: 'desc' },
    take: limit,
  });
  return rows.map((r: { id: number }) => r.id);
}

export async function buildArticleImportanceMap(
  articleIds: number[],
): Promise<Map<number, { stars: number; score: number }>> {
  const map = new Map<number, { stars: number; score: number }>();
  if (!articleIds.length) return map;

  const rows = await prisma.articleImportance.findMany({
    where: { article_id: { in: articleIds } },
    select: { article_id: true, stars: true, score: true },
  });
  for (const row of rows) {
    map.set(row.article_id, { stars: row.stars, score: row.score });
  }
  return map;
}

import axios from 'axios';

import { prisma } from '../../server';
import {
  CLUSTER_MAX_CANDIDATES,
  CLUSTER_SIMILARITY_THRESHOLD,
  CLUSTER_WINDOW_HOURS,
} from './importanceConfig';

export type ClusterBoostResult = {
  score: number;
  similar_count: number;
  distinct_sources: number;
  threshold: number;
  skipped_reason?: string;
};

function getMlBaseUrl(): string {
  return (process.env.ML_SERVICE_URL || 'http://127.0.0.1:3010').replace(/\/$/, '');
}

function getMlToken(): string | null {
  return process.env.ML_SERVICE_TOKEN?.trim() || null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embedTexts(texts: string[]): Promise<number[][] | null> {
  const token = getMlToken();
  if (!token || !texts.length) return null;
  try {
    const response = await axios.post<{ vectors: number[][] }>(
      `${getMlBaseUrl()}/internal/embed`,
      { texts },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': token,
        },
        timeout: 60_000,
      },
    );
    return response.data?.vectors ?? null;
  } catch (error) {
    console.warn(
      '[ImportanceCluster] embed 失败，跳过聚类加分:',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/**
 * 同日（可配置窗口）跨源标题相似度 → 0–100 聚类热度分。
 * ML 不可用时返回 0 且不阻断主打分。
 */
export async function computeClusterBoost(input: {
  articleId: number;
  title: string;
  feedId: number | null;
  publicFeedId: number | null;
  refDate: Date;
}): Promise<ClusterBoostResult> {
  const title = input.title?.trim();
  if (!title) {
    return {
      score: 0,
      similar_count: 0,
      distinct_sources: 0,
      threshold: CLUSTER_SIMILARITY_THRESHOLD,
      skipped_reason: 'empty_title',
    };
  }

  if (process.env.IMPORTANCE_CLUSTER_ENABLED === '0') {
    return {
      score: 0,
      similar_count: 0,
      distinct_sources: 0,
      threshold: CLUSTER_SIMILARITY_THRESHOLD,
      skipped_reason: 'disabled',
    };
  }

  const windowMs = Math.max(1, CLUSTER_WINDOW_HOURS) * 60 * 60 * 1000;
  const since = new Date(input.refDate.getTime() - windowMs);
  const until = new Date(input.refDate.getTime() + windowMs);

  const candidates = await prisma.article.findMany({
    where: {
      id: { not: input.articleId },
      OR: [
        { pub_date: { gte: since, lte: until } },
        {
          AND: [
            { pub_date: null },
            { created_at: { gte: since, lte: until } },
          ],
        },
      ],
    },
    select: {
      id: true,
      title: true,
      feed_id: true,
      public_feed_id: true,
    },
    orderBy: [{ created_at: 'desc' }],
    take: CLUSTER_MAX_CANDIDATES,
  });

  const usable = candidates.filter(
    (c: { title: string | null }) => (c.title || '').trim().length > 0,
  );
  if (!usable.length) {
    return {
      score: 0,
      similar_count: 0,
      distinct_sources: 0,
      threshold: CLUSTER_SIMILARITY_THRESHOLD,
      skipped_reason: 'no_candidates',
    };
  }

  const texts = [title, ...usable.map((c: { title: string | null }) => (c.title || '').trim())];
  const vectors = await embedTexts(texts);
  if (!vectors || vectors.length < 2) {
    return {
      score: 0,
      similar_count: 0,
      distinct_sources: 0,
      threshold: CLUSTER_SIMILARITY_THRESHOLD,
      skipped_reason: 'embed_unavailable',
    };
  }

  const selfVec = vectors[0];
  if (!selfVec?.length) {
    return {
      score: 0,
      similar_count: 0,
      distinct_sources: 0,
      threshold: CLUSTER_SIMILARITY_THRESHOLD,
      skipped_reason: 'bad_vector',
    };
  }

  const sourceKey = (feedId: number | null, publicFeedId: number | null): string => {
    if (feedId != null) return `f:${feedId}`;
    if (publicFeedId != null) return `p:${publicFeedId}`;
    return 'unknown';
  };

  const selfSource = sourceKey(input.feedId, input.publicFeedId);
  const distinct = new Set<string>();
  let similarCount = 0;

  for (let i = 0; i < usable.length; i++) {
    const vec = vectors[i + 1];
    if (!vec) continue;
    const sim = cosineSimilarity(selfVec, vec);
    if (sim < CLUSTER_SIMILARITY_THRESHOLD) continue;
    const other = usable[i];
    const otherSource = sourceKey(other.feed_id, other.public_feed_id);
    if (otherSource === selfSource) continue;
    similarCount += 1;
    distinct.add(otherSource);
  }

  const distinctSources = distinct.size;
  // 0 源 → 0；1 源 → 40；2 → 65；3 → 85；4+ → 100
  let score = 0;
  if (distinctSources >= 4) score = 100;
  else if (distinctSources === 3) score = 85;
  else if (distinctSources === 2) score = 65;
  else if (distinctSources === 1) score = 40;

  return {
    score,
    similar_count: similarCount,
    distinct_sources: distinctSources,
    threshold: CLUSTER_SIMILARITY_THRESHOLD,
  };
}

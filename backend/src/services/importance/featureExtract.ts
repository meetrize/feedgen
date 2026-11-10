import {
  CATEGORY_PRIOR_SCORES,
  DEFAULT_HOST_AUTHORITY,
  EDITORIAL_SIGNAL_KEYWORDS,
  FINANCE_SIGNAL_KEYWORDS,
} from './importanceConfig';

export type FinanceHitFeature = {
  instrument_id: number;
  priority: number;
  matched_keyword: string;
};

export type EditorialFeatures = {
  score: number;
  matched_keywords: string[];
  category_code: string | null;
  category_prior: number;
};

export type FinanceFeatures = {
  score: number;
  hit_count: number;
  best_priority: number | null;
  matched_keywords: string[];
  finance_signal_keywords: string[];
};

export type SourceFeatures = {
  score: number;
  host: string | null;
  feed_id: number | null;
  weight_source: 'db_feed' | 'db_host' | 'default_host' | 'fallback';
};

export type FreshnessFeatures = {
  score: number;
  age_hours: number | null;
};

function normalizeText(text: string): string {
  return text.toLowerCase();
}

function matchKeywords(text: string, keywords: readonly string[]): string[] {
  const lower = normalizeText(text);
  const hits: string[] = [];
  for (const kw of keywords) {
    if (!kw) continue;
    if (lower.includes(kw.toLowerCase())) {
      hits.push(kw);
    }
  }
  return hits;
}

export function extractHost(rawUrl?: string | null): string | null {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    return u.hostname.replace(/^www\./i, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

export function computeSourceScore(input: {
  feedId: number | null;
  feedUrl: string | null;
  articleUrl: string | null;
  dbFeedWeight: number | null;
  dbHostWeight: number | null;
}): SourceFeatures {
  const host = extractHost(input.articleUrl) || extractHost(input.feedUrl);

  if (input.dbFeedWeight != null && Number.isFinite(input.dbFeedWeight)) {
    return {
      score: clamp01to100(input.dbFeedWeight),
      host,
      feed_id: input.feedId,
      weight_source: 'db_feed',
    };
  }

  if (input.dbHostWeight != null && Number.isFinite(input.dbHostWeight)) {
    return {
      score: clamp01to100(input.dbHostWeight),
      host,
      feed_id: input.feedId,
      weight_source: 'db_host',
    };
  }

  if (host) {
    const exact = DEFAULT_HOST_AUTHORITY[host];
    if (exact != null) {
      return { score: exact, host, feed_id: input.feedId, weight_source: 'default_host' };
    }
    // 尝试父域名匹配（如 news.bbc.co.uk → bbc.co.uk）
    const parts = host.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const candidate = parts.slice(i).join('.');
      const found = DEFAULT_HOST_AUTHORITY[candidate];
      if (found != null) {
        return {
          score: found,
          host,
          feed_id: input.feedId,
          weight_source: 'default_host',
        };
      }
    }
  }

  return {
    score: 45,
    host,
    feed_id: input.feedId,
    weight_source: 'fallback',
  };
}

export function computeEditorialScore(input: {
  title: string;
  description?: string | null;
  categoryCode?: string | null;
}): EditorialFeatures {
  const text = `${input.title || ''} ${input.description || ''}`;
  const matched = matchKeywords(text, EDITORIAL_SIGNAL_KEYWORDS);
  const categoryCode = input.categoryCode?.trim() || null;
  let categoryPrior = 40;
  if (categoryCode) {
    const lower = categoryCode.toLowerCase();
    categoryPrior =
      CATEGORY_PRIOR_SCORES[categoryCode] ??
      CATEGORY_PRIOR_SCORES[lower] ??
      40;
  }

  // 信号词：每个 +12，最多 3 个 → 0–36
  const keywordScore = Math.min(36, matched.length * 12);
  // 类别先验占 0–64
  const categoryScore = categoryPrior * 0.64;
  const score = clamp01to100(keywordScore + categoryScore);

  return {
    score,
    matched_keywords: matched,
    category_code: categoryCode,
    category_prior: categoryPrior,
  };
}

export function computeFinanceScore(input: {
  title: string;
  description?: string | null;
  hits: FinanceHitFeature[];
}): FinanceFeatures {
  const text = `${input.title || ''} ${input.description || ''}`;
  const signalHits = matchKeywords(text, FINANCE_SIGNAL_KEYWORDS);
  const hitCount = input.hits.length;

  // 标的命中：数量分 + 最高 priority 分
  // priority 越小越重要（金融词典默认 100）；映射到 0–50
  let bestPriority: number | null = null;
  let priorityScore = 0;
  if (hitCount > 0) {
    bestPriority = Math.min(...input.hits.map((h) => h.priority ?? 100));
    // priority 1 → 50, priority 100 → 20, priority 200+ → 5
    priorityScore = clamp01to100(55 - (bestPriority ?? 100) * 0.35);
  }
  const countScore = Math.min(30, hitCount * 10);
  const signalScore = Math.min(30, signalHits.length * 10);

  const score =
    hitCount === 0 && signalHits.length === 0
      ? 0
      : clamp01to100(countScore + priorityScore + signalScore);

  return {
    score,
    hit_count: hitCount,
    best_priority: bestPriority,
    matched_keywords: input.hits.map((h) => h.matched_keyword).filter(Boolean).slice(0, 8),
    finance_signal_keywords: signalHits,
  };
}

export function computeFreshnessScore(refDate: Date | null | undefined, now = new Date()): FreshnessFeatures {
  if (!refDate || Number.isNaN(refDate.getTime())) {
    return { score: 50, age_hours: null };
  }
  const ageMs = Math.max(0, now.getTime() - refDate.getTime());
  const ageHours = ageMs / (1000 * 60 * 60);
  // 0h → 100, 24h → 70, 72h → 40, 7d → 15
  let score = 100;
  if (ageHours <= 6) score = 100;
  else if (ageHours <= 24) score = 100 - ((ageHours - 6) / 18) * 30;
  else if (ageHours <= 72) score = 70 - ((ageHours - 24) / 48) * 30;
  else if (ageHours <= 168) score = 40 - ((ageHours - 72) / 96) * 25;
  else score = 10;

  return { score: clamp01to100(score), age_hours: Math.round(ageHours * 10) / 10 };
}

function clamp01to100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

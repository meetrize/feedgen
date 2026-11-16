import {
  CATEGORY_PRIOR_SCORES,
  DEFAULT_HOST_AUTHORITY,
  EDITORIAL_SIGNAL_KEYWORDS,
  FINANCE_SIGNAL_KEYWORDS,
  NATIONAL_AGENCY_KEYWORDS,
  POLICY_MEETING_KEYWORDS,
  POLICY_PUBLISH_STRONG_KEYWORDS,
  POLICY_PUBLISH_WEAK_KEYWORDS,
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

export type PolicyStarFloorFeatures = {
  /** 命中后的星级保底；未命中为 null */
  floor_stars: number | null;
  reason: 'policy_publish' | 'agency_meeting' | null;
  matched_agencies: string[];
  matched_policy_keywords: string[];
  matched_meeting_keywords: string[];
  skipped_local: boolean;
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

/** 易与地方机构混淆的短称 */
const AMBIGUOUS_AGENCY_SHORT_NAMES = new Set([
  '发改委',
  '能源局',
  '统计局',
  '医保局',
  '国资委',
  '证监会',
]);

/**
 * 标题是否更像地方机构（省/市/区发改委等），而非国家级。
 * 若同时出现「国家/国务院/中央」则仍视为国家级。
 */
function isLikelyLocalAgencyTitle(title: string, matchedAgencies: string[]): boolean {
  if (/国家|国务院|中央|中共中央/.test(title)) return false;
  const onlyAmbiguous = matchedAgencies.every((kw) => AMBIGUOUS_AGENCY_SHORT_NAMES.has(kw));
  if (!onlyAmbiguous) return false;
  return /(省|市|区|县|自治州|盟|地区).{0,8}(发改委|能源局|工信|财政|住建|统计|医保|国资|证监)/.test(
    title,
  );
}

/**
 * 国家级机构政策标题星级保底：
 * - 机构 + 规划/方案等发布信号 → 5 星
 * - 机构 + 会议/调研等，且无发布信号 → 4 星
 */
export function computePolicyStarFloor(title: string): PolicyStarFloorFeatures {
  const empty: PolicyStarFloorFeatures = {
    floor_stars: null,
    reason: null,
    matched_agencies: [],
    matched_policy_keywords: [],
    matched_meeting_keywords: [],
    skipped_local: false,
  };
  const text = String(title || '').trim();
  if (!text) return empty;

  const matchedAgencies = matchKeywords(text, NATIONAL_AGENCY_KEYWORDS);
  if (!matchedAgencies.length) return empty;

  if (isLikelyLocalAgencyTitle(text, matchedAgencies)) {
    return { ...empty, matched_agencies: matchedAgencies, skipped_local: true };
  }

  const matchedStrongPolicy = matchKeywords(text, POLICY_PUBLISH_STRONG_KEYWORDS);
  let matchedWeakPolicy = matchKeywords(text, POLICY_PUBLISH_WEAK_KEYWORDS);
  // 「发布会」里的「发布」不算政策发布
  if (matchedWeakPolicy.includes('发布') && text.includes('发布会')) {
    matchedWeakPolicy = matchedWeakPolicy.filter((kw) => kw !== '发布');
  }
  const matchedPolicy = [...matchedStrongPolicy, ...matchedWeakPolicy];
  const matchedMeeting = matchKeywords(text, POLICY_MEETING_KEYWORDS);

  // 强政策信号优先抬到 5 星（即便标题里也有「会议」字样）
  if (matchedStrongPolicy.length) {
    return {
      floor_stars: 5,
      reason: 'policy_publish',
      matched_agencies: matchedAgencies,
      matched_policy_keywords: matchedPolicy,
      matched_meeting_keywords: matchedMeeting,
      skipped_local: false,
    };
  }

  // 会议/活动类：保底 4 星（弱政策如「会议通知」也走这里）
  if (matchedMeeting.length) {
    return {
      floor_stars: 4,
      reason: 'agency_meeting',
      matched_agencies: matchedAgencies,
      matched_policy_keywords: matchedPolicy,
      matched_meeting_keywords: matchedMeeting,
      skipped_local: false,
    };
  }

  if (matchedWeakPolicy.length) {
    return {
      floor_stars: 5,
      reason: 'policy_publish',
      matched_agencies: matchedAgencies,
      matched_policy_keywords: matchedPolicy,
      matched_meeting_keywords: matchedMeeting,
      skipped_local: false,
    };
  }

  return {
    ...empty,
    matched_agencies: matchedAgencies,
  };
}

/** 星级对应的最低 score（与 DEFAULT_STAR_THRESHOLDS 对齐） */
export function minScoreForStars(stars: number): number {
  if (stars >= 5) return 80;
  if (stars >= 4) return 60;
  if (stars >= 3) return 40;
  if (stars >= 2) return 20;
  return 0;
}

function clamp01to100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

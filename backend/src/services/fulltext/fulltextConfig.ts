export const FULLTEXT_JOB_KEY = 'fulltext.fetch';
export const FULLTEXT_QUEUE_NAME = 'fulltext-queue';

export type FulltextConfig = {
  enabled: boolean;
  minStars: number;
  maxBytes: number;
  minTextLength: number;
  usePlaywrightFallback: boolean;
  concurrency: number;
  retryFailedDays: number;
  backfillLimit: number;
};

export const DEFAULT_FULLTEXT_CONFIG: FulltextConfig = {
  enabled: true,
  minStars: 2,
  maxBytes: 500_000,
  minTextLength: 200,
  usePlaywrightFallback: true,
  concurrency: 3,
  retryFailedDays: 3,
  backfillLimit: 80,
};

export function parseFulltextConfig(raw: unknown): FulltextConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    enabled: o.enabled === false ? false : true,
    minStars: Math.max(0, Math.min(5, Math.floor(num(o.minStars, DEFAULT_FULLTEXT_CONFIG.minStars)))),
    maxBytes: Math.max(10_000, Math.min(2_000_000, Math.floor(num(o.maxBytes, DEFAULT_FULLTEXT_CONFIG.maxBytes)))),
    minTextLength: Math.max(50, Math.min(5000, Math.floor(num(o.minTextLength, DEFAULT_FULLTEXT_CONFIG.minTextLength)))),
    usePlaywrightFallback: o.usePlaywrightFallback === false ? false : true,
    concurrency: Math.max(1, Math.min(8, Math.floor(num(o.concurrency, DEFAULT_FULLTEXT_CONFIG.concurrency)))),
    retryFailedDays: Math.max(0, Math.min(30, Math.floor(num(o.retryFailedDays, DEFAULT_FULLTEXT_CONFIG.retryFailedDays)))),
    backfillLimit: Math.max(1, Math.min(500, Math.floor(num(o.backfillLimit, DEFAULT_FULLTEXT_CONFIG.backfillLimit)))),
  };
}

export function isFulltextEnvEnabled(): boolean {
  return process.env.FULLTEXT_ENABLED !== '0';
}

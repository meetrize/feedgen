/**
 * 批量取涨跌幅：优先本机 meostock 本地快照；美股/港股等快照未就绪时回退 stock-sdk。
 * 不阻塞文章列表主路径。
 */

import { StockSDK } from 'stock-sdk';

export type QuoteRequestItem = {
  market: string;
  symbol: string;
  chart_symbol?: string;
};

export type QuoteResultItem = {
  market: string;
  symbol: string;
  chart_symbol: string;
  change_percent: number | null;
  price: number | null;
  as_of: number | null;
};

type CacheEntry = {
  changePercent: number | null;
  price: number | null;
  asOf: number | null;
  expiresAt: number;
};

const DEFAULT_BASE = 'http://127.0.0.1:8765';
const CACHE_TTL_MS = 45_000;
/** 空结果短缓存，避免同一页反复打上游；有数据时用 CACHE_TTL_MS */
const MISS_CACHE_TTL_MS = 8_000;
const FETCH_TIMEOUT_MS = 800;
const MAX_CODES_PER_MARKET = 80;
const SDK_TIMEOUT_MS = 2_500;

/** market + 规范化 code → 缓存 */
const quoteCache = new Map<string, CacheEntry>();

let sdkSingleton: StockSDK | null = null;

function getSdk(): StockSDK {
  if (!sdkSingleton) sdkSingleton = new StockSDK();
  return sdkSingleton;
}

function getBaseUrl(): string {
  const raw = String(process.env.MEOSTOCK_BASE_URL || DEFAULT_BASE).trim();
  return raw.replace(/\/+$/, '') || DEFAULT_BASE;
}

/** feedgen market → meostock snapshot market */
export function toMeostockMarket(market: string, assetType?: string | null): string {
  const m = String(market || '').toLowerCase();
  const asset = String(assetType || '').toLowerCase();
  if (asset === 'futures' || m === 'futures') return 'futures';
  if (asset === 'commodity' || m === 'commodity' || m.startsWith('yf:')) {
    return m.startsWith('yf:') ? m : 'yf:COMMODITIES';
  }
  if (m === 'a' || m === 'ashare' || m === 'cn') return 'cn';
  if (m === 'hk') return 'hk';
  if (m === 'us') return 'us';
  if (m === 'fund') return 'fund';
  if (m === 'index') return 'index';
  if (m === 'futures') return 'futures';
  return m || 'cn';
}

/** 去掉 us/hk 前缀与美股交易所后缀，得到可查询 ticker */
export function normalizeTickerForMarket(market: string, raw: string): string {
  let s = String(raw || '').trim();
  if (!s) return '';
  const m = String(market || '').toLowerCase();

  if (m === 'us') {
    let t = s;
    if (/^us/i.test(t) && t.length > 2) t = t.slice(2);
    t = t.toUpperCase();
    if (/^\d+\./.test(t)) t = t.replace(/^\d+\./, '');
    t = t.replace(/\.(O|N|A|OQ|NQ|PK|OB|OTC|P)$/i, '');
    return t;
  }

  if (m === 'hk') {
    let t = s;
    if (/^hk/i.test(t)) t = t.slice(2);
    const digits = t.replace(/\D/g, '');
    if (digits) return digits.padStart(5, '0');
    return t;
  }

  if (m === 'cn' || m === 'fund' || m === 'index') {
    // 保留 sh/sz/bj 或纯数字
    return s;
  }

  return s;
}

/** 选用于查询的 code（优先 chart_symbol，再按市场规范化） */
export function resolveQueryCode(item: QuoteRequestItem): string {
  const market = toMeostockMarket(item.market);
  const chart = String(item.chart_symbol || '').trim();
  const symbol = String(item.symbol || '').trim();
  const raw = chart || symbol;
  return normalizeTickerForMarket(market, raw) || raw;
}

function cacheKey(market: string, code: string): string {
  return `${market}|${normalizeTickerForMarket(market, code) || code}`.toLowerCase();
}

/** 与 meostock `_code_match_keys` 对齐的候选键，便于命中缓存 */
function codeMatchKeys(raw: string, market?: string): string[] {
  const s = (raw || '').trim();
  if (!s) return [];
  const low = s.toLowerCase();
  const keys = new Set<string>([s, low, s.toUpperCase()]);

  for (const pfx of ['sh', 'sz', 'bj', 'hk', 'us'] as const) {
    if (low.startsWith(pfx) && low.length > pfx.length) {
      const body = s.slice(pfx.length);
      keys.add(body);
      keys.add(body.toLowerCase());
      keys.add(body.toUpperCase());
      keys.add(`${pfx}${body}`);
      keys.add(`${pfx}${body.toLowerCase()}`);
    }
  }

  // 美股交易所后缀
  const noSuffix = s.replace(/\.(O|N|A|OQ|NQ|PK|OB|OTC|P)$/i, '');
  if (noSuffix !== s) {
    keys.add(noSuffix);
    keys.add(noSuffix.toUpperCase());
    keys.add(noSuffix.toLowerCase());
  }

  const digits = s.replace(/\D/g, '');
  if (digits) {
    keys.add(digits);
    if (digits.length <= 5) keys.add(digits.padStart(5, '0'));
    for (const pfx of ['sh', 'sz', 'bj', 'hk'] as const) {
      keys.add(`${pfx}${digits}`);
      if (digits.length <= 5) keys.add(`${pfx}${digits.padStart(5, '0')}`);
    }
  }

  if (market) {
    const norm = normalizeTickerForMarket(market, s);
    if (norm) {
      keys.add(norm);
      keys.add(norm.toLowerCase());
      keys.add(norm.toUpperCase());
    }
  }

  return [...keys];
}

function readCache(market: string, code: string): CacheEntry | null {
  const now = Date.now();
  for (const key of codeMatchKeys(code, market)) {
    const hit = quoteCache.get(`${market}|${key}`.toLowerCase());
    if (hit && hit.expiresAt > now) return hit;
    const hit2 = quoteCache.get(cacheKey(market, key));
    if (hit2 && hit2.expiresAt > now) return hit2;
  }
  return null;
}

function writeCache(
  market: string,
  code: string,
  klineSymbol: string | undefined,
  entry: Omit<CacheEntry, 'expiresAt'>,
  ttlMs: number = CACHE_TTL_MS,
): void {
  const expiresAt = Date.now() + ttlMs;
  const payload: CacheEntry = { ...entry, expiresAt };
  const codes = new Set<string>([code, ...(klineSymbol ? [klineSymbol] : [])]);
  for (const c of codes) {
    for (const key of codeMatchKeys(c, market)) {
      quoteCache.set(`${market}|${key}`.toLowerCase(), payload);
      quoteCache.set(cacheKey(market, key), payload);
    }
  }
}

type SnapshotItem = {
  code?: string;
  klineSymbol?: string;
  changePercent?: number | null;
  price?: number | null;
};

async function fetchSnapshot(
  market: string,
  codes: string[],
): Promise<{ items: SnapshotItem[]; asOf: number | null }> {
  if (!codes.length) return { items: [], asOf: null };
  const unique = [...new Set(codes.map((c) => c.trim()).filter(Boolean))].slice(
    0,
    MAX_CODES_PER_MARKET,
  );
  const qs = new URLSearchParams({
    market,
    codes: unique.join(','),
  });
  const url = `${getBaseUrl()}/api/cache/snapshot?${qs}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      items?: SnapshotItem[];
      as_of?: number | null;
      error?: string;
    };
    if (!res.ok || !data.ok) {
      return { items: [], asOf: null };
    }
    return {
      items: Array.isArray(data.items) ? data.items : [],
      asOf: typeof data.as_of === 'number' ? data.as_of : null,
    };
  } catch {
    return { items: [], asOf: null };
  } finally {
    clearTimeout(timer);
  }
}

/** meostock yfinance 批量（美股/商品兜底） */
async function fetchYfQuotes(codes: string[]): Promise<SnapshotItem[]> {
  if (!codes.length) return [];
  const unique = [...new Set(codes.map((c) => c.trim()).filter(Boolean))].slice(0, 40);
  const qs = new URLSearchParams({ symbols: unique.join(',') });
  const url = `${getBaseUrl()}/api/yf/quotes?${qs}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SDK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      quotes?: Array<{
        code?: string;
        changePercent?: number | null;
        price?: number | null;
      }>;
    };
    if (!res.ok || !data.ok || !Array.isArray(data.quotes)) return [];
    return data.quotes.map((q) => ({
      code: String(q.code || ''),
      klineSymbol: String(q.code || ''),
      changePercent: numOrNull(q.changePercent),
      price: numOrNull(q.price),
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function findSnapshotItem(
  items: SnapshotItem[],
  code: string,
  market?: string,
): SnapshotItem | undefined {
  const wanted = new Set(codeMatchKeys(code, market).map((k) => k.toLowerCase()));
  for (const it of items) {
    const keys = [
      ...codeMatchKeys(String(it.code || ''), market),
      ...codeMatchKeys(String(it.klineSymbol || ''), market),
    ].map((k) => k.toLowerCase());
    if (keys.some((k) => wanted.has(k))) return it;
  }
  return undefined;
}

type SdkQuoteRow = {
  code?: string;
  changePercent?: number;
  change_percent?: number;
  price?: number;
};

async function fetchSdkQuotes(market: string, codes: string[]): Promise<SnapshotItem[]> {
  if (!codes.length) return [];
  const unique = [...new Set(codes.map((c) => normalizeTickerForMarket(market, c) || c))].filter(
    Boolean,
  );
  if (!unique.length) return [];

  const sdk = getSdk();
  const run = async (): Promise<SdkQuoteRow[]> => {
    if (market === 'us') {
      return (await sdk.quotes.us(unique)) as SdkQuoteRow[];
    }
    if (market === 'hk') {
      return (await sdk.quotes.hk(unique)) as SdkQuoteRow[];
    }
    if (market === 'cn') {
      return (await sdk.quotes.cn(unique)) as SdkQuoteRow[];
    }
    if (market === 'fund') {
      return (await sdk.quotes.fund(unique)) as SdkQuoteRow[];
    }
    return [];
  };

  try {
    const rows = await Promise.race([
      run(),
      new Promise<SdkQuoteRow[]>((_, reject) => {
        setTimeout(() => reject(new Error('sdk quotes timeout')), SDK_TIMEOUT_MS);
      }),
    ]);
    if (!Array.isArray(rows)) return [];
    return rows
      .map((q) => {
        const code = String(q.code || '');
        return {
          code,
          klineSymbol: code,
          changePercent: numOrNull(q.changePercent ?? q.change_percent),
          price: numOrNull(q.price),
        };
      })
      .filter((q) => q.code);
  } catch {
    return [];
  }
}

/**
 * 批量查询涨跌幅：缓存 → meostock snapshot → stock-sdk →（美股）yf 兜底。
 */
export async function batchGetQuotes(
  requests: QuoteRequestItem[],
): Promise<QuoteResultItem[]> {
  const normalized: Array<{
    market: string;
    symbol: string;
    chart_symbol: string;
    queryCode: string;
  }> = [];
  const seen = new Set<string>();

  for (const raw of requests) {
    const market = toMeostockMarket(raw.market);
    const symbol = String(raw.symbol || '').trim();
    const chart_symbol = String(raw.chart_symbol || symbol).trim();
    const queryCode = resolveQueryCode({ market, symbol, chart_symbol });
    if (!queryCode) continue;
    const dedupe = `${market}|${queryCode.toLowerCase()}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    normalized.push({ market, symbol: symbol || queryCode, chart_symbol, queryCode });
  }

  if (!normalized.length) return [];

  const missingByMarket = new Map<string, string[]>();
  const resolved = new Map<string, QuoteResultItem>();

  const resultKey = (market: string, queryCode: string) =>
    `${market}|${queryCode.toLowerCase()}`;

  for (const item of normalized) {
    const cached = readCache(item.market, item.queryCode);
    if (cached && cached.changePercent != null) {
      resolved.set(resultKey(item.market, item.queryCode), {
        market: item.market,
        symbol: item.symbol,
        chart_symbol: item.chart_symbol,
        change_percent: cached.changePercent,
        price: cached.price,
        as_of: cached.asOf,
      });
      continue;
    }
    // 明确的短 miss 缓存：跳过上游
    if (cached && cached.changePercent == null && cached.expiresAt > Date.now()) {
      resolved.set(resultKey(item.market, item.queryCode), {
        market: item.market,
        symbol: item.symbol,
        chart_symbol: item.chart_symbol,
        change_percent: null,
        price: null,
        as_of: cached.asOf,
      });
      continue;
    }
    const list = missingByMarket.get(item.market) || [];
    list.push(item.queryCode);
    missingByMarket.set(item.market, list);
  }

  if (missingByMarket.size) {
    await Promise.all(
      [...missingByMarket.entries()].map(async ([market, codes]) => {
        const stillMissing: string[] = [];

        // 1) 本地快照（A 股等已同步市场秒回）
        const { items, asOf } = await fetchSnapshot(market, codes);
        for (const code of codes) {
          const hit = findSnapshotItem(items, code, market);
          const changePercent = numOrNull(hit?.changePercent);
          const price = numOrNull(hit?.price);
          if (changePercent != null || price != null) {
            writeCache(market, code, hit?.klineSymbol, {
              changePercent,
              price,
              asOf,
            });
            continue;
          }
          stillMissing.push(code);
        }

        if (!stillMissing.length) return;

        // 2) stock-sdk 按代码拉取（美/港快照常为空时的主路径）
        if (market === 'us' || market === 'hk' || market === 'cn' || market === 'fund') {
          const sdkItems = await fetchSdkQuotes(market, stillMissing);
          const afterSdk: string[] = [];
          for (const code of stillMissing) {
            const hit = findSnapshotItem(sdkItems, code, market);
            const changePercent = numOrNull(hit?.changePercent);
            const price = numOrNull(hit?.price);
            if (changePercent != null || price != null) {
              writeCache(market, code, hit?.klineSymbol, {
                changePercent,
                price,
                asOf: Date.now() / 1000,
              });
              continue;
            }
            afterSdk.push(code);
          }
          stillMissing.length = 0;
          stillMissing.push(...afterSdk);
        }

        // 3) 美股再试 meostock yfinance
        if (market === 'us' && stillMissing.length) {
          const yfItems = await fetchYfQuotes(stillMissing);
          const afterYf: string[] = [];
          for (const code of stillMissing) {
            const hit = findSnapshotItem(yfItems, code, market);
            const changePercent = numOrNull(hit?.changePercent);
            const price = numOrNull(hit?.price);
            if (changePercent != null || price != null) {
              writeCache(market, code, hit?.klineSymbol, {
                changePercent,
                price,
                asOf: Date.now() / 1000,
              });
              continue;
            }
            afterYf.push(code);
          }
          stillMissing.length = 0;
          stillMissing.push(...afterYf);
        }

        // 仍无：短 miss 缓存，避免刷屏打上游
        for (const code of stillMissing) {
          writeCache(
            market,
            code,
            undefined,
            { changePercent: null, price: null, asOf: null },
            MISS_CACHE_TTL_MS,
          );
        }
      }),
    );

    for (const item of normalized) {
      const key = resultKey(item.market, item.queryCode);
      if (resolved.has(key)) continue;
      const cached = readCache(item.market, item.queryCode);
      resolved.set(key, {
        market: item.market,
        symbol: item.symbol,
        chart_symbol: item.chart_symbol,
        change_percent: cached?.changePercent ?? null,
        price: cached?.price ?? null,
        as_of: cached?.asOf ?? null,
      });
    }
  }

  return normalized.map((item) => {
    const hit = resolved.get(resultKey(item.market, item.queryCode));
    return (
      hit || {
        market: item.market,
        symbol: item.symbol,
        chart_symbol: item.chart_symbol,
        change_percent: null,
        price: null,
        as_of: null,
      }
    );
  });
}

/** 解析请求体/查询串中的 items */
export function parseQuoteItems(raw: unknown): QuoteRequestItem[] {
  if (!Array.isArray(raw)) return [];
  const out: QuoteRequestItem[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const obj = row as Record<string, unknown>;
    const market = String(obj.market || '').trim();
    const symbol = String(obj.symbol || '').trim();
    const chart_symbol =
      obj.chart_symbol != null ? String(obj.chart_symbol).trim() : undefined;
    if (!market && !symbol && !chart_symbol) continue;
    out.push({
      market: market || 'cn',
      symbol: symbol || String(chart_symbol || ''),
      ...(chart_symbol ? { chart_symbol } : {}),
    });
  }
  return out.slice(0, 120);
}

/** 解析 `cn:sh600519,us:AAPL` 紧凑查询 */
export function parseCompactItems(raw: string): QuoteRequestItem[] {
  const parts = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out: QuoteRequestItem[] = [];
  for (const part of parts) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const market = part.slice(0, idx).trim();
    const code = part.slice(idx + 1).trim();
    if (!market || !code) continue;
    out.push({ market, symbol: code, chart_symbol: code });
  }
  return out.slice(0, 120);
}

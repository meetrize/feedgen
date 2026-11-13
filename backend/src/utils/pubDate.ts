/** 可被数据库接受的发布时间年份范围 */
const MIN_YEAR = 1990;
const MAX_YEAR = 2100;

/** 允许的时钟偏差（源站/本机时钟不准）；超出则视为无效未来时间 */
export const PUB_DATE_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** 纯数字常被误解析为年份（如第一财经阅读量 9910 → 公元 9910 年） */
export function looksLikeViewCountNotDate(raw: string): boolean {
  const text = (raw || '').trim();
  if (!text) return false;
  if (/^\d{1,7}$/.test(text)) return true;
  if (/^\d[\d,.\s]*$/.test(text) && !/[年月日:/\-T]/.test(text) && !/前\s*$/.test(text)) {
    return true;
  }
  return false;
}

function toValidTimeMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function isValidPubDate(d: Date, now: Date = new Date()): boolean {
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return false;
  const y = d.getUTCFullYear();
  if (y < MIN_YEAR || y > MAX_YEAR) return false;
  // 拒绝明显未来的时间，避免按发布时间降序时被顶置
  if (ms > now.getTime() + PUB_DATE_FUTURE_SKEW_MS) return false;
  return true;
}

export function parsePubDateFromText(raw: string | undefined | null, now: Date = new Date()): Date | undefined {
  if (!raw) return undefined;
  const text = raw.trim();
  if (!text || looksLikeViewCountNotDate(text)) return undefined;
  const d = new Date(text);
  return isValidPubDate(d, now) ? d : undefined;
}

export function coercePubDateForDb(
  input: Date | string | undefined | null,
  now: Date = new Date(),
): Date | undefined {
  if (input == null) return undefined;
  if (input instanceof Date) {
    return isValidPubDate(input, now) ? input : undefined;
  }
  if (typeof input === 'string') return parsePubDateFromText(input, now);
  return undefined;
}

/** 入库用发布时间：无效则回退为当前时间 */
export function pubDateForDb(input: Date | string | undefined | null, fallback: Date = new Date()): Date {
  return coercePubDateForDb(input, fallback) ?? fallback;
}

/**
 * 列表「按发布时间」排序用的有效时间：
 * - 无 pub_date → 入库时间 created_at
 * - pub_date 明显大于现在 → 回退 created_at（避免未来时间顶置）
 * - 否则用 pub_date
 */
export function effectivePubDateForSort(
  pubDate: Date | string | null | undefined,
  createdAt: Date | string | null | undefined,
  now: Date = new Date(),
): Date | null {
  const createdMs = toValidTimeMs(createdAt);
  const pubMs = toValidTimeMs(pubDate);
  if (pubMs == null) {
    return createdMs != null ? new Date(createdMs) : null;
  }
  if (pubMs > now.getTime() + PUB_DATE_FUTURE_SKEW_MS) {
    return createdMs != null ? new Date(createdMs) : new Date(now.getTime());
  }
  return new Date(pubMs);
}

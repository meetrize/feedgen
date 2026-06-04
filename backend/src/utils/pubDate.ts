/** 可被数据库接受的发布时间年份范围 */
const MIN_YEAR = 1990;
const MAX_YEAR = 2100;

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

export function isValidPubDate(d: Date): boolean {
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return false;
  const y = d.getUTCFullYear();
  return y >= MIN_YEAR && y <= MAX_YEAR;
}

export function parsePubDateFromText(raw: string | undefined | null): Date | undefined {
  if (!raw) return undefined;
  const text = raw.trim();
  if (!text || looksLikeViewCountNotDate(text)) return undefined;
  const d = new Date(text);
  return isValidPubDate(d) ? d : undefined;
}

export function coercePubDateForDb(input: Date | string | undefined | null): Date | undefined {
  if (input == null) return undefined;
  if (input instanceof Date) {
    return isValidPubDate(input) ? input : undefined;
  }
  if (typeof input === 'string') return parsePubDateFromText(input);
  return undefined;
}

/** 入库用发布时间：无效则回退为当前时间 */
export function pubDateForDb(input: Date | string | undefined | null, fallback: Date = new Date()): Date {
  return coercePubDateForDb(input) ?? fallback;
}

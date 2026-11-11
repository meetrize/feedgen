/** 主题关键词规范化：全角→半角、去空白、小写 */

export function normalizeThemeKeyword(raw: string): string {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/\u3000/g, ' ');
  s = s.replace(/\s+/g, '');
  return s.toLowerCase();
}

/** 匹配用正文规范化：保留字母数字与中文，去标点空白后小写 */
export function normalizeThemeMatchText(raw: string): string {
  let s = String(raw ?? '');
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/\u3000/g, ' ');
  s = s.toLowerCase();
  s = s.replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, '');
  return s;
}

export function clampThemeImportance(value: unknown, fallback = 3): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) return fallback;
  return n;
}

const MAX_KEYWORD_LEN = 80;
const MAX_KEYWORDS_PER_THEME = 40;

export function normalizeThemeKeywordList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const keyword = String(item ?? '').trim().slice(0, MAX_KEYWORD_LEN);
    if (!keyword) continue;
    const norm = normalizeThemeKeyword(keyword);
    if (!norm || norm.length < 2) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(keyword);
    if (out.length >= MAX_KEYWORDS_PER_THEME) break;
  }
  return out;
}

export { MAX_KEYWORDS_PER_THEME, MAX_KEYWORD_LEN };

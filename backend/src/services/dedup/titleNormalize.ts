/**
 * 标题规范化：小写、去空白/标点/常见前后缀，供查重用。
 */

const COMMON_PREFIXES = [
  /^【[^】]{0,20}】\s*/,
  /^\[[^\]]{0,20}\]\s*/,
  /^（[^）]{0,20}）\s*/,
  /^\([^)]{0,20}\)\s*/,
  /^(独家|快讯|突发|重磅|最新|原创|视频|图文|直播)\s*[:：|｜\-]?\s*/i,
];

const COMMON_SUFFIXES = [
  /\s*[-—_|｜]\s*(财联社|证券时报|上证报|第一财经|新浪财经|新华社|人民日报|央视新闻|界面新闻|澎湃新闻|路透|Bloomberg|Reuters).*$/i,
  /\s*[\(（][^)）]{0,30}[\)）]\s*$/,
];

export function normalizeTitle(raw: string | null | undefined): string {
  let s = String(raw || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();

  if (!s) return '';

  for (const re of COMMON_PREFIXES) {
    s = s.replace(re, '');
  }
  for (const re of COMMON_SUFFIXES) {
    s = s.replace(re, '');
  }

  // 去空白与常见标点（保留中英文数字）
  s = s
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~，。、；：？！「」『』【】（）〔〕…—·《》〈〉""'']/g, '');

  return s.slice(0, 500);
}

/** URL 规范化：去协议/www/尾斜杠/常见跟踪参数，强信号同簇 */
export function normalizeUrl(raw: string | null | undefined): string {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'spm', 'from'].forEach((k) =>
      u.searchParams.delete(k),
    );
    let host = u.hostname.replace(/^www\./, '');
    let path = u.pathname.replace(/\/+$/, '') || '';
    const q = u.searchParams.toString();
    return `${host}${path}${q ? `?${q}` : ''}`;
  } catch {
    return s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  }
}

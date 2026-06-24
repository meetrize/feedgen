/** 可视化解析 / 爬取时可选的页面语言（YouTube 等站点通过 hl 与浏览器 locale 控制） */
import type { BrowserContext } from 'playwright';

export const PAGE_LANGUAGE_PRESETS: Array<{ value: string; label: string }> = [
  { value: '', label: '默认（不指定）' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁体中文' },
  { value: 'en', label: 'English（英语）' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
];

export function normalizePageLanguage(code?: string | null): string {
  const v = String(code || '').trim();
  if (!v || v === 'default') return '';
  return v;
}

/** YouTube 地区码，辅助返回对应语言的标题翻译 */
export function getYouTubeGeoForPageLanguage(pageLanguage?: string | null): string {
  const lang = normalizePageLanguage(pageLanguage);
  const map: Record<string, string> = {
    'zh-CN': 'CN',
    'zh-TW': 'TW',
    en: 'US',
    ja: 'JP',
    ko: 'KR',
  };
  return map[lang] || 'US';
}

export function isYouTubeHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'youtube.com'
      || host.endsWith('.youtube.com')
      || host === 'youtu.be'
      || host.endsWith('.youtu.be');
  } catch {
    return false;
  }
}

/** 将 hl 等语言参数合并进目标 URL（YouTube 使用 ?hl=） */
export function applyPageLanguageToUrl(url: string, pageLanguage?: string | null): string {
  const lang = normalizePageLanguage(pageLanguage);
  if (!lang) return url;
  try {
    const u = new URL(url);
    if (isYouTubeHost(url)) {
      u.searchParams.set('hl', lang);
      u.searchParams.set('persist_hl', '1');
      const gl = getYouTubeGeoForPageLanguage(lang);
      if (gl) u.searchParams.set('gl', gl);
    }
    return u.toString();
  } catch {
    return url;
  }
}

export function getBrowserLocaleForPageLanguage(pageLanguage?: string | null): {
  locale: string;
  acceptLanguage: string;
} {
  const lang = normalizePageLanguage(pageLanguage);
  if (!lang) {
    return { locale: 'zh-CN', acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8' };
  }
  const acceptMap: Record<string, string> = {
    'zh-CN': 'zh-CN,zh;q=0.9,en;q=0.8',
    'zh-TW': 'zh-TW,zh;q=0.9,en;q=0.8',
    en: 'en-US,en;q=0.9',
    ja: 'ja-JP,ja;q=0.9,en;q=0.8',
    ko: 'ko-KR,ko;q=0.9,en;q=0.8',
  };
  const locale = lang === 'en' ? 'en-US' : lang;
  return {
    locale,
    acceptLanguage: acceptMap[lang] || `${lang},en;q=0.8`,
  };
}

/** YouTube 偏好 Cookie，辅助固定界面语言 */
export async function injectYouTubeLanguagePreference(
  context: BrowserContext,
  pageLanguage?: string | null,
): Promise<void> {
  const lang = normalizePageLanguage(pageLanguage);
  if (!lang) return;
  const gl = getYouTubeGeoForPageLanguage(lang);
  await context.addCookies([
    {
      name: 'PREF',
      value: `hl=${lang}&gl=${gl}&f6=40000000`,
      domain: '.youtube.com',
      path: '/',
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}

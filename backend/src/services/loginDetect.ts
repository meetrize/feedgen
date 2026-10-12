import type { Page } from 'playwright';

export const LOGIN_URL_RE = /login|signin|sign-in|register|signup|sign-up|auth|passport|sso/i;

export const LOGIN_TEXT_CHECKS: Array<[string, string]> = [
  ['登录', '登录'],
  ['注册', '注册'],
  ['手机号', '手机号'],
  ['验证码', '验证码'],
  ['password', 'password'],
  ['sign in', 'sign in'],
  ['log in', 'log in'],
];

export class AuthExpiredError extends Error {
  pageUrl?: string;
  signals: string[];

  constructor(message: string, signals: string[] = [], pageUrl?: string) {
    super(message);
    this.name = 'AuthExpiredError';
    this.signals = signals;
    if (pageUrl) this.pageUrl = pageUrl;
  }
}

export function isLoginUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return LOGIN_URL_RE.test(`${u.pathname}${u.search}${u.hash}`);
  } catch {
    return LOGIN_URL_RE.test(url);
  }
}

/** 预览/渲染用：与历史 page-renderer 行为对齐，并在有 Cookie 仍落在登录 URL 时提示失效。 */
export function evaluateLoginRequired(opts: {
  pageUrl: string;
  loginSignals: string[];
  hasAuthCookie?: boolean;
}): { requiresLogin: boolean; loginHint?: string } {
  const urlHit = isLoginUrl(opts.pageUrl);
  const signalHit = opts.loginSignals.length >= 2;
  const hasCookie = !!opts.hasAuthCookie;

  const requiresLogin = urlHit || (signalHit && !hasCookie);
  if (!requiresLogin) return { requiresLogin: false };

  const hint =
    hasCookie || urlHit
      ? '登录 Cookie 可能已失效。请使用「实时交互」重新登录，系统将自动保存 Cookie。'
      : '目标站点需要登录态。请在可视化解析器中通过「实时交互」登录，或填写该站点登录后的 Cookie 再重试。';

  return { requiresLogin: true, loginHint: hint };
}

/** 爬取用：0 条结果或明确登录 URL 时，判断是否认证失效。有 Cookie 仍命中登录 URL / 强登录信号 → 视为过期。 */
export function evaluateAuthFailure(opts: {
  pageUrl: string;
  loginSignals: string[];
  hasAuthCookie?: boolean;
  itemCount?: number;
}): boolean {
  const urlHit = isLoginUrl(opts.pageUrl);
  const signalHit = opts.loginSignals.length >= 2;
  const empty = (opts.itemCount ?? 0) === 0;

  if (urlHit) return true;
  if (empty && signalHit) return true;
  if (opts.hasAuthCookie && signalHit && empty) return true;
  return false;
}

/** 在页面内采集登录相关正文信号 */
export async function collectLoginSignals(page: Page): Promise<string[]> {
  return page
    .evaluate((checks: Array<[string, string]>) => {
      const text = (document.body?.innerText || '').toLowerCase();
      const hits: string[] = [];
      for (const [label, token] of checks) {
        if (text.includes(token.toLowerCase())) hits.push(label);
      }
      return Array.from(new Set(hits));
    }, LOGIN_TEXT_CHECKS)
    .catch(() => [] as string[]);
}

export async function detectLoginRequired(
  page: Page,
  opts: { hasAuthCookie?: boolean } = {},
): Promise<{ requiresLogin: boolean; loginHint?: string; loginSignals: string[]; pageUrl: string }> {
  const pageUrl = page.url();
  const loginSignals = await collectLoginSignals(page);
  const result = evaluateLoginRequired({
    pageUrl,
    loginSignals,
    ...(opts.hasAuthCookie !== undefined ? { hasAuthCookie: opts.hasAuthCookie } : {}),
  });
  return {
    ...result,
    loginSignals,
    pageUrl,
  };
}

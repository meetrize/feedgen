import axios from 'axios';

import { launchChromium } from '../browser';
import { FEED_FETCH_USER_AGENT } from '../feedFetchHeaders';
import { withAxiosProxy } from '../proxyConfig';

export type FetchPageResult = {
  html: string;
  finalUrl: string;
  httpStatus: number;
  via: 'http' | 'playwright';
};

function htmlHeaders(): Record<string, string> {
  return {
    'User-Agent': FEED_FETCH_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  };
}

export async function fetchHtmlHttp(
  url: string,
  useProxy = false,
): Promise<FetchPageResult> {
  const response = await axios.get(url, withAxiosProxy({
    headers: htmlHeaders(),
    timeout: 20000,
    maxRedirects: 5,
    responseType: 'text',
    validateStatus: (s) => s >= 200 && s < 400,
    maxContentLength: 2_000_000,
  }, useProxy));

  const html = typeof response.data === 'string' ? response.data : String(response.data || '');
  const finalUrl =
    typeof response.request?.res?.responseUrl === 'string'
      ? response.request.res.responseUrl
      : url;

  return {
    html,
    finalUrl,
    httpStatus: Number(response.status) || 200,
    via: 'http',
  };
}

export async function fetchHtmlPlaywright(url: string): Promise<FetchPageResult> {
  const browser = await launchChromium({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: FEED_FETCH_USER_AGENT,
      locale: 'zh-CN',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    // 等一会主内容
    await new Promise((r) => setTimeout(r, 1200));
    const html = await page.content();
    const finalUrl = page.url();
    const httpStatus = response?.status() || 0;
    await context.close();
    return {
      html,
      finalUrl,
      httpStatus,
      via: 'playwright',
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export function looksBlocked(html: string, httpStatus: number): boolean {
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 451) return true;
  const sample = html.slice(0, 8000).toLowerCase();
  return (
    /captcha|验证码|access denied|permission denied|just a moment|cf-browser-verification|请登录|subscribe to continue|paywall/i.test(
      sample,
    )
  );
}

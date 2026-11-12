import axios from 'axios';

import {
  applySupplementaryPatches,
  createStealthContext,
  getFingerprintProfile,
  launchChromium,
} from '../browser';
import { isLocalProxyAvailable, withAxiosProxy } from '../proxyConfig';
import { sanitizeArticleHtml, type ExtractedFulltext } from './extractFulltext';

/**
 * 彭博付费墙页通常拦 HTML/iframe；story API 可取正文 AST / abstract。
 * 裸 axios 常被 PerimeterX 403，需 Playwright(stealth + chromium108) + 代理。
 * API：https://www.bloomberg.com/article/api/story/slug/{date}/{slug}
 */

type BbNode = {
  type?: string;
  subType?: string;
  value?: string;
  content?: BbNode[];
  attributes?: { emphasis?: boolean; strong?: boolean };
  data?: {
    level?: number;
    title?: string;
    destination?: { web?: string; bbg?: string };
    link?: { destination?: { web?: string; bbg?: string } };
    story?: { identifiers?: { suid?: string } };
    security?: { identifiers?: { parsekey?: string } };
  };
};

function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

function nodesToHtml(nodes: BbNode[] | undefined): string {
  if (!Array.isArray(nodes) || !nodes.length) return '';
  return nodes.map((n) => nodeToHtml(n)).join('');
}

function nodeToHtml(node: BbNode | null | undefined): string {
  if (!node || typeof node !== 'object') return '';
  const type = String(node.type || '');
  switch (type) {
    case 'paragraph':
      return `<p>${nodesToHtml(node.content)}</p>`;
    case 'text': {
      let val = escapeHtml(String(node.value || ''));
      if (node.attributes?.strong) val = `<strong>${val}</strong>`;
      if (node.attributes?.emphasis) val = `<em>${val}</em>`;
      return val;
    }
    case 'heading': {
      const level = Math.min(3, Math.max(2, Number(node.data?.level) || 2));
      return `<h${level}>${nodesToHtml(node.content)}</h${level}>`;
    }
    case 'link': {
      const href = String(node.data?.destination?.web || '').trim();
      const inner = nodesToHtml(node.content);
      return href ? `<a href="${escapeAttr(href)}">${inner}</a>` : inner;
    }
    case 'entity': {
      const web = String(node.data?.link?.destination?.web || '').trim();
      const inner = nodesToHtml(node.content);
      if (web) return `<a href="${escapeAttr(web)}">${inner}</a>`;
      const suid = String(node.data?.story?.identifiers?.suid || '').trim();
      if (suid) {
        return `<a href="${escapeAttr(`https://www.bloomberg.com/news/terminal/${suid}`)}">${inner}</a>`;
      }
      return inner;
    }
    case 'br':
      return '<br/>';
    case 'hr':
      return '<hr/>';
    case 'blockquote':
    case 'quote':
    case 'aside':
      return `<blockquote>${nodesToHtml(node.content)}</blockquote>`;
    case 'list': {
      const tag = node.subType === 'ordered' ? 'ol' : 'ul';
      return `<${tag}>${nodesToHtml(node.content)}</${tag}>`;
    }
    case 'listItem':
      return `<li>${nodesToHtml(node.content)}</li>`;
    case 'ad':
    case 'media':
      return '';
    default:
      return nodesToHtml(node.content);
  }
}

function documentToHtml(document: unknown): string {
  if (!document || typeof document !== 'object') return '';
  const content = (document as { content?: BbNode[] }).content;
  return nodesToHtml(content);
}

function paragraphsToHtml(parts: string[]): string {
  return parts
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join('');
}

export function isBloombergArticleUrl(url: string): boolean {
  try {
    const u = new URL(String(url || '').trim());
    return /(^|\.)bloomberg\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** 从文章 URL 解析 story slug：`2026-11-12/some-slug` */
export function parseBloombergStorySlug(url: string): string | null {
  try {
    const u = new URL(String(url || '').trim());
    if (!/(^|\.)bloomberg\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(
      /\/news\/(?:articles|features|newsletters)\/(\d{4}-\d{2}-\d{2}\/[^/?#]+)/i,
    );
    return m?.[1] ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

function pickStoryPayload(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object') return null;
  const root = data as Record<string, unknown>;
  if (root.appId && String(root.appId).startsWith('PX')) return null; // PerimeterX block payload
  if (root.data && typeof root.data === 'object') {
    return root.data as Record<string, unknown>;
  }
  // 有些响应直接就是 story
  if (root.headline || root.body || root.abstract) return root;
  return null;
}

function storyToExtracted(story: Record<string, unknown>): ExtractedFulltext | null {
  const bodyHtml = documentToHtml(story.body);
  const abstractParts = Array.isArray(story.abstract)
    ? story.abstract.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const summaryParts = [story.dek, story.summary]
    .map((x) => String(x || '').trim())
    .filter(Boolean);

  let html = bodyHtml.trim();
  if (!html || html.replace(/<[^>]+>/g, '').trim().length < 80) {
    const teaser = paragraphsToHtml([...abstractParts, ...summaryParts]);
    if (teaser) html = teaser;
  } else if (abstractParts.length || summaryParts.length) {
    const lead = paragraphsToHtml([...summaryParts, ...abstractParts]);
    const plain = html.replace(/<[^>]+>/g, ' ');
    const leadPlain = lead.replace(/<[^>]+>/g, ' ').trim();
    if (lead && leadPlain && !plain.includes(leadPlain.slice(0, Math.min(40, leadPlain.length)))) {
      html = `${lead}${html}`;
    }
  }

  if (!html.trim()) return null;
  const cleaned = sanitizeArticleHtml(html);
  if (!cleaned.bodyText) return null;
  return cleaned;
}

function bloombergAxiosHeaders(): Record<string, string> {
  const profile = getFingerprintProfile('chromium108');
  return {
    'User-Agent': profile.userAgent,
    Accept: 'application/json,text/plain,*/*',
    'Accept-Language': profile.defaultAcceptLanguage,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Referer: 'https://www.bloomberg.com/',
    Origin: 'https://www.bloomberg.com',
    'sec-ch-ua': profile.secChUa,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': profile.secChUaPlatform,
  };
}

async function fetchBloombergStoryAxios(
  apiUrl: string,
  useProxy: boolean,
): Promise<ExtractedFulltext | null> {
  const response = await axios.get(apiUrl, withAxiosProxy({
    headers: bloombergAxiosHeaders(),
    timeout: 20000,
    maxRedirects: 5,
    responseType: 'json',
    // 403 也读 body，便于识别 PX
    validateStatus: (s) => s >= 200 && s < 500,
  }, useProxy));

  const finalUrl =
    typeof response.request?.res?.responseUrl === 'string'
      ? String(response.request.res.responseUrl)
      : apiUrl;
  if (/\/tosv2\.html/i.test(finalUrl) || response.status === 403 || response.status === 401) {
    return null;
  }
  const story = pickStoryPayload(response.data);
  return story ? storyToExtracted(story) : null;
}

async function fetchBloombergViaPlaywright(
  articleUrl: string,
  apiUrl: string,
  useProxy: boolean,
): Promise<ExtractedFulltext | null> {
  const browser = await launchChromium({ headless: true });
  try {
    const context = await createStealthContext(browser, {
      useProxy,
      fingerprintProfile: 'chromium108',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      acceptLanguage: 'en-US,en;q=0.9',
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    await applySupplementaryPatches(page, {
      fingerprintProfile: 'chromium108',
      acceptLanguage: 'en-US,en;q=0.9',
    });

    let intercepted: unknown = null;
    page.on('response', async (res) => {
      try {
        const u = res.url();
        if (!/\/article\/api\/story\//i.test(u)) return;
        if (res.status() !== 200) return;
        const ct = String(res.headers()['content-type'] || '');
        if (ct && !/json/i.test(ct)) return;
        intercepted = await res.json();
      } catch {
        /* ignore */
      }
    });

    // 先落到首页攒一点 cookie，再进文章页（有时能减轻 PX）
    await page.goto('https://www.bloomberg.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1200));

    const nav = await page.goto(articleUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await new Promise((r) => setTimeout(r, 2800));

    if (intercepted) {
      const story = pickStoryPayload(intercepted);
      const fromIntercept = story ? storyToExtracted(story) : null;
      if (fromIntercept?.bodyText) return fromIntercept;
    }

    // 同页 credentials 再打一次 story API
    const apiResult = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, {
          credentials: 'include',
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        });
        const text = await r.text();
        return { ok: r.ok, status: r.status, text };
      } catch (e) {
        return { ok: false, status: 0, text: e instanceof Error ? e.message : String(e) };
      }
    }, apiUrl);

    if (apiResult?.ok && apiResult.text) {
      try {
        const parsed = JSON.parse(apiResult.text);
        const story = pickStoryPayload(parsed);
        const extracted = story ? storyToExtracted(story) : null;
        if (extracted?.bodyText) return extracted;
      } catch {
        /* ignore */
      }
    }

    // 最后：从可见 DOM / meta 抽试读段（付费墙前几段）
    const domTeaser = await page.evaluate(() => {
      const metas = Array.from(document.querySelectorAll('meta[name="description"], meta[property="og:description"]'))
        .map((el) => el.getAttribute('content') || '')
        .map((s) => s.trim())
        .filter((s) => s.length > 60);
      const paras = Array.from(
        document.querySelectorAll(
          'main p, article p, [class*="body-content"] p, [class*="ArticleBody"] p, [data-component*="body"] p',
        ),
      )
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter((s) => s.length > 60)
        .slice(0, 8);
      return { metas, paras };
    });

    const parts = [
      ...(domTeaser?.metas || []),
      ...(domTeaser?.paras || []),
    ].filter(Boolean);
    // 去重保序
    const seen = new Set<string>();
    const unique = parts.filter((p) => {
      const key = p.slice(0, 80);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (unique.length) {
      const html = paragraphsToHtml(unique);
      const cleaned = sanitizeArticleHtml(html);
      if (cleaned.bodyText) return cleaned;
    }

    const status = nav?.status() || apiResult?.status || 0;
    if (status === 403 || status === 401) return null;
    return null;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** 把 Jina Reader 的 markdown 收成正文段落 HTML（去掉导航/页脚） */
function extractArticleHtmlFromJinaMarkdown(md: string): string {
  let body = String(md || '');
  const marker = body.search(/Markdown Content:\s*/i);
  if (marker >= 0) {
    body = body.slice(marker).replace(/Markdown Content:\s*/i, '');
  }

  const stopRe =
    /^(###\s+More From Bloomberg|###\s+Top Reads|Before it's here|Get unlimited access|##\s+We've updated|Unlock the global benchmark)/i;
  const chromeRe =
    /Skip to content|Bloomberg the Company|Bloomberg Terminal Demo|Bloomberg Anywhere|Bloomberg Customer Support|For Customers|Software Updates|Manage Products|Connecting decision makers|Site feedback|Confidential tip|Terms of Service|Privacy Policy|All Rights Reserved|cookie policy|Get unlimited access|Claim This Offer/i;

  const paras: string[] = [];
  for (const rawLine of body.split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (stopRe.test(line)) break;
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^By\s+\[/i.test(line)) continue;
    if (/^\w+\s+\d{1,2},\s+\d{4}\s+at\s+/i.test(line)) continue;
    if (/^!\[/.test(line)) continue;
    if (/^(Save|Translate|Sign In|Accept|Home|News|Work & Life|Market Data|Explore)$/i.test(line)) {
      continue;
    }

    const plain = line
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (plain.length < 70) continue;
    if (chromeRe.test(plain)) continue;
    // 导航拼成的超长链接串：词很少但字符很多
    if ((plain.match(/Bloomberg/gi) || []).length >= 3) continue;
    paras.push(plain);
    if (paras.length >= 30) break;
  }
  return paragraphsToHtml(paras);
}

/**
 * Jina Reader 可绕过不少站点的 PerimeterX（返回可读 markdown）。
 * 对彭博通常只能拿到付费墙前的试读段，但足够作为「正文」展示。
 */
async function fetchBloombergViaJina(
  articleUrl: string,
  useProxy: boolean,
): Promise<ExtractedFulltext | null> {
  const jinaUrl = `https://r.jina.ai/${articleUrl}`;
  const response = await axios.get(jinaUrl, withAxiosProxy({
    headers: {
      Accept: 'text/markdown,text/plain,*/*',
      'User-Agent': getFingerprintProfile('chromium108').userAgent,
      'X-Return-Format': 'markdown',
    },
    timeout: 45000,
    maxRedirects: 3,
    responseType: 'text',
    validateStatus: (s) => s >= 200 && s < 400,
    maxContentLength: 2_000_000,
  }, useProxy));

  const md = typeof response.data === 'string' ? response.data : String(response.data || '');
  if (!md.trim()) return null;
  const html = extractArticleHtmlFromJinaMarkdown(md);
  if (!html.trim()) return null;
  const cleaned = sanitizeArticleHtml(html);
  if (!cleaned.bodyText || cleaned.wordCount < 40) return null;
  return cleaned;
}

/**
 * 抽取彭博正文：axios → Jina → Playwright；付费墙时至少尽量拿试读段。
 */
export async function fetchBloombergFulltext(
  articleUrl: string,
  useProxy = false,
): Promise<ExtractedFulltext | null> {
  const slug = parseBloombergStorySlug(articleUrl);
  // 无标准 slug 时仍可走 Jina
  const apiUrl = slug
    ? `https://www.bloomberg.com/article/api/story/slug/${slug}`
    : '';

  let proxy = !!useProxy;
  if (!proxy) {
    // 彭博在国内直连几乎必拦；有本机代理则自动启用
    proxy = await isLocalProxyAvailable();
  }

  // 1) 先试 axios story API（快）；403/PX 则跳过
  if (apiUrl) {
    try {
      const viaAxios = await fetchBloombergStoryAxios(apiUrl, proxy);
      if (viaAxios?.bodyText) return viaAxios;
    } catch (err) {
      console.warn(
        '[fulltext] bloomberg axios failed:',
        err instanceof Error ? err.message : String(err),
      );
    }

    if (!proxy) {
      const proxyUp = await isLocalProxyAvailable();
      if (proxyUp) {
        proxy = true;
        try {
          const viaAxiosProxy = await fetchBloombergStoryAxios(apiUrl, true);
          if (viaAxiosProxy?.bodyText) return viaAxiosProxy;
        } catch {
          /* continue */
        }
      }
    }
  }

  // 2) Jina Reader（实测可过 PX，拿到试读段；比 Playwright 更稳）
  try {
    const viaJina = await fetchBloombergViaJina(articleUrl, proxy);
    if (viaJina?.bodyText) return viaJina;
  } catch (err) {
    console.warn(
      '[fulltext] bloomberg jina failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // 3) Playwright stealth + chromium108（慢，且常仍被 PX）
  if (apiUrl) {
    try {
      const viaPw = await fetchBloombergViaPlaywright(articleUrl, apiUrl, proxy);
      if (viaPw?.bodyText) return viaPw;
    } catch (err) {
      console.warn(
        '[fulltext] bloomberg playwright failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return null;
}

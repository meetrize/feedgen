import {
  launchChromium,
  createStealthContext,
  getDefaultLaunchArgs,
  applySupplementaryPatches,
} from './browser';
import { createCaptchaTicket, createCaptchaWait, startRemoteSession } from './captchaRelay';

export interface VisualSelectorRules {
  listSelector: string;
  authCookie?: string;
  fields: {
    title?: string;
    description?: string;
    thumbnail?: string;
    link?: string;
    date?: string;
    author?: string;
  };
}

export interface CrawledArticle {
  title: string;
  description?: string | undefined;
  url?: string | undefined;
  thumbnail_url?: string | undefined;
  author?: string | undefined;
  pub_date?: Date | undefined;
}

export class AntiBotDetectedError extends Error {
  readonly signals: string[];
  readonly screenshot?: Buffer;
  readonly pageUrl?: string;

  constructor(signals: string[], screenshot?: Buffer, pageUrl?: string) {
    const uniqueSignals = Array.from(new Set(signals.filter(Boolean)));
    super(`检测到反爬挑战页: ${uniqueSignals.join(', ') || 'unknown'}`);
    this.name = 'AntiBotDetectedError';
    this.signals = uniqueSignals;
    if (screenshot !== undefined) this.screenshot = screenshot;
    if (pageUrl !== undefined) this.pageUrl = pageUrl;
  }
}

let visualCrawlerQueue: Promise<void> = Promise.resolve();
let visualCrawlerActiveCount = 0;
let visualCrawlerQueuedCount = 0;

async function runWithVisualCrawlerConcurrencyLimit<T>(task: () => Promise<T>): Promise<T> {
  visualCrawlerQueuedCount += 1;
  const queuePosition = visualCrawlerQueuedCount;

  const previousTask = visualCrawlerQueue.catch(() => {});
  let releaseCurrentTask!: () => void;
  visualCrawlerQueue = previousTask.then(() => new Promise<void>((resolve) => {
    releaseCurrentTask = resolve;
  }));

  await previousTask;
  visualCrawlerQueuedCount -= 1;
  visualCrawlerActiveCount += 1;

  if (queuePosition > 1 || visualCrawlerQueuedCount > 0) {
    console.info(`[visualCrawler] 开始执行排队任务，当前并发: ${visualCrawlerActiveCount}, 等待中: ${visualCrawlerQueuedCount}`);
  }

  try {
    return await task();
  } finally {
    visualCrawlerActiveCount -= 1;
    releaseCurrentTask();
  }
}

/**
 * 使用可视化选择器规则从网页中爬取文章列表
 */
export async function crawlWithVisualSelectors(
  pageUrl: string,
  rules: VisualSelectorRules
): Promise<CrawledArticle[]> {
  return runWithVisualCrawlerConcurrencyLimit(() => crawlWithVisualSelectorsInternal(pageUrl, rules));
}

async function crawlWithVisualSelectorsInternal(
  pageUrl: string,
  rules: VisualSelectorRules
): Promise<CrawledArticle[]> {
  let browser;
  try {
    // stealth 插件已自动注册 40+ 反检测补丁（webdriver, plugins, chrome.runtime, canvas, webgl 等）
    browser = await launchChromium({
      args: getDefaultLaunchArgs(),
    });

    const context = await createStealthContext(browser, {
      ...(rules.authCookie?.trim() ? { authCookie: rules.authCookie.trim() } : {}),
    });
    const page = await context.newPage();

    // 补充中文 locale 指纹覆盖
    await applySupplementaryPatches(page);

    await page.goto(pageUrl, {
      waitUntil: 'networkidle',
      timeout: 30000,
      referer: new URL(pageUrl).origin + '/',
    }).catch(() => {
      return page.goto(pageUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
        referer: new URL(pageUrl).origin + '/',
      });
    });

    // 等待页面稳定
    await page.waitForTimeout(1500);
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});

    // 自动滚动触发懒加载内容
    await page.evaluate(async () => {
      const total = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
      let y = 0;
      while (y < total) {
        window.scrollTo(0, y);
        y += step;
        await new Promise((r) => setTimeout(r, 180));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1200);

    // 提前检查反爬挑战信号，便于后续排查
    const antiBotSignals = await page.evaluate(() => {
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const titleText = (document.title || '').toLowerCase();
      // 剔除 script/style 标签后再检查 HTML，避免 JS 库中 "captcha" 等词误报
      const rawHtml = (document.documentElement?.outerHTML || '').slice(0, 120000).toLowerCase();
      const cleanHtml = rawHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                               .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

      // 强信号：出现即判定为验证页
      const strongSignals: Array<[string, string]> = [
        ['geetest', 'geetest'],
        ['访问受限', '访问受限'],
        ['请完成验证', '请完成验证'],
        ['sec_sdk', 'sec_sdk'],
        ['webcast.amemv.com', 'webcast.amemv.com'],
      ];
      for (const [label, token] of strongSignals) {
        if (bodyText.includes(token) || titleText.includes(token) || cleanHtml.includes(token)) return [label];
      }

      // captcha 关键词仅在页面可见文本中出现才判定（HTML 里引用 recaptcha.js 不算）
      if (bodyText.includes('captcha') || titleText.includes('captcha')) return ['captcha'];

      // 弱信号：需多个同时命中或在 title 中出现
      const titleHits: string[] = [];
      const bodyHits: string[] = [];
      const weakTokens: Array<[string, string]> = [
        ['verify', 'verify'],
        ['验证', '验证'],
        ['人机验证', '人机验证'],
      ];
      for (const [label, token] of weakTokens) {
        if (titleText.includes(token)) titleHits.push(label);
        if (bodyText.includes(token) || cleanHtml.includes(token)) bodyHits.push(label);
      }

      // title 中命中任意弱信号 → 高置信度
      if (titleHits.length > 0) return titleHits;
      // body 中需至少 2 个弱信号同时命中
      if (bodyHits.length >= 2) return bodyHits;

      return [];
    });
    if (antiBotSignals.length > 0) {
      console.warn(`[visualCrawler] 命中反爬挑战页: ${antiBotSignals.join(', ')}`);
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false }).catch(() => undefined) as Buffer | undefined;

      // 创建打码 ticket 并广播给管理员
      const ticket = createCaptchaTicket({
        feedId: 0,
        feedTitle: '(实时打码)',
        targetUrl: pageUrl,
        pageUrl: page.url(),
        screenshotBase64: screenshot ? screenshot.toString('base64') : '',
        signals: antiBotSignals,
      });

      // 启动远程交互会话（3 分钟超时），管理员可在本地浏览器操作服务端页面
      console.log(`[visualCrawler] 启动远程交互会话 ticket=${ticket.captchaId}（180s），等待管理员操作...`);
      const result = await startRemoteSession(ticket.captchaId, page, 180000);

      if (result === 'passed' || result === 'skipped') {
        console.log(`[visualCrawler] 远程交互完成 (${result})，继续爬取`);
        await page.waitForTimeout(2000);
        await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});

        // skipped 时不重新检测验证码，直接继续
        if (result === 'skipped') {
          console.log('[visualCrawler] 管理员确认非验证码页，跳过检测继续爬取');
        } else {
          const retrySignals = await page.evaluate(() => {
            const bodyText = (document.body?.innerText || '').toLowerCase();
            const checks = ['captcha', 'verify', '验证', '人机', '访问受限', '请完成验证'];
            const hit: string[] = [];
            for (const t of checks) if (bodyText.includes(t)) hit.push(t);
            return hit;
          });

          if (retrySignals.length === 0) {
            console.log('[visualCrawler] 验证码已通过，继续爬取');
          } else {
            console.warn(`[visualCrawler] 验证码仍未通过，信号: ${retrySignals.join(', ')}`);
            const err = new AntiBotDetectedError(antiBotSignals, screenshot, page.url());
            (err as any)._captchaTicketCreated = true;
            throw err;
          }
        }
      } else {
        console.warn(`[visualCrawler] 远程交互会话结束: ${result}`);
        const err = new AntiBotDetectedError(antiBotSignals, screenshot, page.url());
        (err as any)._captchaTicketCreated = true;
        throw err;
      }
    }

    // 在页面中执行提取逻辑
    const articles = await page.evaluate((args: { listSelector: string; fields: Record<string, string | undefined>; baseUrl: string }) => {
      const { listSelector, fields, baseUrl } = args;

      const stripNthOfType = (s: string) => (s || '').replace(/:nth-of-type\(\d+\)/g, '');
      let items = document.querySelectorAll(listSelector);
      if (items.length === 0) {
        const fallbackSelector = stripNthOfType(listSelector);
        if (fallbackSelector && fallbackSelector !== listSelector) {
          items = document.querySelectorAll(fallbackSelector);
        }
      }
      if (items.length === 0) return [];

      function resolveUrl(url: string): string {
        if (!url) return '';
        try { return new URL(url, baseUrl).href; }
        catch { return url; }
      }

      function extractThumbnail(el: Element): string {
        if (el.tagName === 'IMG') {
          const img = el as HTMLImageElement;
          const srcset = img.getAttribute('srcset') || '';
          const srcsetFirst = srcset.split(',')[0]?.trim()?.split(/\s+/)[0] || '';
          return img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-original') || srcsetFirst || '';
        }
        if (el.tagName === 'PICTURE') {
          const img = el.querySelector('img');
          if (img) {
            const image = img as HTMLImageElement;
            const srcset = image.getAttribute('srcset') || '';
            const srcsetFirst = srcset.split(',')[0]?.trim()?.split(/\s+/)[0] || '';
            return image.currentSrc || image.src || image.getAttribute('data-src') || srcsetFirst || '';
          }
          const source = el.querySelector('source');
          if (source) {
            const srcset = source.getAttribute('srcset') || '';
            const srcsetFirst = srcset.split(',')[0]?.trim()?.split(/\s+/)[0] || '';
            if (srcsetFirst) return srcsetFirst;
          }
        }
        const htmlEl = el as HTMLElement;
        const bgImg = htmlEl.style?.backgroundImage || getComputedStyle(htmlEl).getPropertyValue('background-image');
        if (bgImg && bgImg !== 'none') {
          const m = bgImg.match(/url\(["']?([^"')]+)["']?\)/);
          if (m && m[1]) return m[1];
        }
        const dataCandidates = [
          el.getAttribute('data-src'),
          el.getAttribute('data-original'),
          el.getAttribute('data-url'),
          el.getAttribute('data-lazy-src'),
          el.getAttribute('data-echo'),
        ].filter(Boolean) as string[];
        if (dataCandidates.length > 0) return dataCandidates[0] || '';

        const img = el.querySelector('img');
        if (img) {
          const image = img as HTMLImageElement;
          const srcset = image.getAttribute('srcset') || '';
          const srcsetFirst = srcset.split(',')[0]?.trim()?.split(/\s+/)[0] || '';
          return image.currentSrc || image.src || image.getAttribute('data-src') || srcsetFirst || '';
        }
        return '';
      }

      function extractLink(el: Element): string {
        if (el.tagName === 'A') return (el as HTMLAnchorElement).href || '';
        const a = el.closest('a') || el.querySelector('a');
        return a ? (a as HTMLAnchorElement).href || '' : '';
      }

      function autoExtractLink(itemEl: Element): string {
        if (itemEl.tagName === 'A') return (itemEl as HTMLAnchorElement).href || '';
        const anchors = Array.from(itemEl.querySelectorAll('a[href]'));
        if (anchors.length === 0) return '';
        if (anchors.length === 1) {
          const href = (anchors[0] as HTMLAnchorElement).href || '';
          if (!href || href.startsWith('javascript:') || href === '#') return '';
          return href;
        }
        // 选文字最多或包含标题标签的链接
        let best = anchors[0] as HTMLAnchorElement;
        let bestScore = 0;
        for (const a of anchors) {
          const anchor = a as HTMLAnchorElement;
          const href = anchor.href || '';
          if (!href || href.startsWith('javascript:') || href === '#') continue;
          let score = (anchor.textContent || '').trim().length;
          if (anchor.querySelector('h1,h2,h3,h4,h5,h6')) score += 50;
          if (anchor.closest('h1,h2,h3,h4,h5,h6')) score += 40;
          if (score > bestScore) { bestScore = score; best = anchor; }
        }
        const bestHref = best.href || '';
        if (!bestHref || bestHref.startsWith('javascript:') || bestHref === '#') return '';
        return bestHref;
      }

      /** 与前端 visual-parser 一致：从原文中提取「N 分钟/小时/天前」并换算为爬取时刻的 ISO 时间 */
      function parseRelativeDateTextToIso(raw: string): string {
        const refMs = Date.now();
        const text = (raw || '').trim();
        if (!text) return '';

        const pick = (re: RegExp, unitMs: number): string | null => {
          const m = text.match(re);
          if (!m || m[1] === undefined) return null;
          const n = parseInt(m[1], 10);
          if (!Number.isFinite(n) || n < 0) return null;
          return new Date(refMs - n * unitMs).toISOString();
        };

        return (
          pick(/(\d+)\s*分钟前/, 60 * 1000) ||
          pick(/(\d+)\s*小时前/, 60 * 60 * 1000) ||
          pick(/(\d+)\s*天前/, 24 * 60 * 60 * 1000) ||
          ''
        );
      }

      const results: any[] = [];
      for (const item of items) {
        const article: any = {};

        for (const [key, selector] of Object.entries(fields)) {
          if (!selector) continue;
          const el = item.querySelector(selector);
          if (!el) continue;

          if (key === 'thumbnail') {
            article.thumbnail_url = resolveUrl(extractThumbnail(el));
          } else if (key === 'link') {
            const link = extractLink(el);
            if (link && !link.startsWith('javascript:') && link !== '#') {
              article.url = resolveUrl(link);
            }
          } else if (key === 'date') {
            const raw = (el.textContent || '').trim();
            article.date = parseRelativeDateTextToIso(raw) || raw;
          } else {
            article[key] = (el.textContent || '').trim();
          }
        }

        // 自动提取链接
        if (!article.url) {
          article.url = resolveUrl(autoExtractLink(item));
        }
        // 自动提取缩略图
        if (!article.thumbnail_url) {
          article.thumbnail_url = resolveUrl(extractThumbnail(item));
        }

        if (article.title || article.url) {
          results.push(article);
        }
      }

      return results;
    }, { listSelector: rules.listSelector, fields: rules.fields as Record<string, string | undefined>, baseUrl: pageUrl });

    return articles.map((a: any) => {
      let pubDate: Date | undefined;
      if (a.date) {
        const d = new Date(a.date);
        pubDate = Number.isNaN(d.getTime()) ? undefined : d;
      }
      return {
        title: a.title || '无标题',
        description: a.description || undefined,
        url: a.url || undefined,
        thumbnail_url: a.thumbnail_url || undefined,
        author: a.author || undefined,
        pub_date: pubDate,
      };
    });
  } catch (error) {
    console.error('Visual crawl error:', error);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

import { FastifyPluginAsync } from 'fastify';
import {
  launchChromium,
  createStealthContext,
  getDefaultLaunchArgs,
  applySupplementaryPatches,
  injectAuthCookies,
  isDouyinHost,
  listFingerprintProfiles,
} from '../services/browser';
import {
  applyPageLanguageToUrl,
  getBrowserLocaleForPageLanguage,
  injectYouTubeLanguagePreference,
  isYouTubeHost,
} from '../utils/pageLanguage';
import {
  buildYouTubeFallbackHtml,
  isYouTubeChannelVideosUrl,
  navigateYouTubePage,
} from '../utils/youtubePageExtract';
import * as cheerio from 'cheerio';
import * as path from 'path';
import * as fs from 'fs/promises';
import axios from 'axios';
import { detectAntiBotSignalsInPage } from '../utils/antiBotDetection';
import { collectLoginSignals, evaluateLoginRequired } from '../services/loginDetect';
import { parseHtmlSelectorsWithDeepSeek } from '../services/aiHtmlParser';
import {
  isLocalProxyAvailable,
  withAxiosProxy,
} from '../services/proxyConfig';

function isYahooFinanceHost(rawUrl: string): boolean {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase();
    return h === 'yahoo.com' || h.endsWith('.yahoo.com') || h === 'finance.yahoo.com';
  } catch {
    return /yahoo\.com/i.test(rawUrl);
  }
}

/** 渲染前快速探测目标站状态（尤其 429），避免 Playwright 在限流响应上长时间卡住 */
async function probePageHttpStatus(
  targetUrl: string,
  useProxy: boolean
): Promise<{ status: number | null; snippet: string }> {
  try {
    const response = await axios.get(
      targetUrl,
      withAxiosProxy(
        {
          timeout: 8000,
          maxRedirects: 5,
          validateStatus: () => true,
          responseType: 'text',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          // 只要状态码与片段，限制体量
          maxContentLength: 64_000,
          maxBodyLength: 64_000,
        },
        useProxy
      )
    );
    const snippet = String(response.data || '').slice(0, 200);
    return { status: Number(response.status) || null, snippet };
  } catch (error: any) {
    console.warn(`[page-renderer] probe failed: ${error?.message || error}`);
    return { status: null, snippet: '' };
  }
}

function buildRateLimitFallbackHtml(pageUrl: string, status: number, detail: string): string {
  const safeUrl = String(pageUrl || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeDetail = String(detail || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>访问受限 (${status})</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:24px;line-height:1.5;color:#2c3e50;">
  <h1 style="margin:0 0 12px;font-size:20px;">目标站返回 HTTP ${status}</h1>
  <p style="margin:0 0 8px;">URL：${safeUrl}</p>
  <p style="margin:0 0 8px;">Yahoo / CDN 当前对自动化访问限流（Too Many Requests）。</p>
  <p style="margin:0 0 8px;color:#7f8c8d;">详情：${safeDetail || 'Edge: Too Many Requests'}</p>
  <ul style="margin:12px 0;padding-left:18px;">
    <li>稍后重试，或更换代理出口 IP</li>
    <li>可用「实时交互」在服务端浏览器中手动打开并完成验证</li>
    <li>若有可用 Cookie，可在 Cookie 面板导入后再加载</li>
  </ul>
</body></html>`;
}

interface RenderPageRequest {
  url: string;
  authCookie?: string;
  useProxy?: boolean;
  pageLanguage?: string;
  fingerprintProfile?: string;
  waitForSelector?: string;
  waitForTimeout?: number;
  waitForNetworkIdle?: boolean;
  waitForAjax?: boolean;
  ajaxWaitTime?: number;
}

interface ElementInfo {
  tag: string;
  id: string;
  classes: string[];
  text: string;
  attributes: Record<string, string>;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  path: string; // CSS选择器路径
}

interface RenderResponse {
  html: string;
  url: string;
  finalUrl?: string;
  statusCode?: number;
  title: string;
  elements: ElementInfo[];
  antiBotSignals?: string[];
  requiresLogin?: boolean;
  loginHint?: string | undefined;
  screenshot?: string; // base64编码的截图
}

interface DouyinHotItem {
  rank: number;
  title: string;
  heat: string;
}

function renderDouyinHotlistFallbackHtml(pageTitle: string, pageUrl: string, items: DouyinHotItem[]): string {
  const escapedTitle = (pageTitle || '抖音热榜').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapedUrl = (pageUrl || '').replace(/"/g, '&quot;');
  const rows = items.map((it) => {
    const t = it.title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const h = it.heat.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const link = `${pageUrl}#rank-${it.rank}`;
    return `
      <li class="hot-item">
        <a class="hot-link" href="${link}">
          <span class="rank">${it.rank}</span>
          <span class="title">${t}</span>
          <span class="heat">${h}</span>
        </a>
      </li>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapedTitle}</title>
  <base href="${escapedUrl}">
  <style>
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif; background:#f6f7fb; color:#222; }
    .wrap { max-width:980px; margin:0 auto; padding:16px; }
    .head { background:#fff; border:1px solid #e8e8ef; border-radius:10px; padding:14px 16px; margin-bottom:12px; }
    .head h1 { margin:0 0 6px; font-size:22px; }
    .head .sub { color:#667; font-size:13px; word-break:break-all; }
    ul.hot-list { list-style:none; margin:0; padding:0; }
    li.hot-item { background:#fff; border:1px solid #ececf3; border-radius:10px; margin-bottom:10px; overflow:hidden; }
    .hot-link { display:flex; gap:12px; align-items:center; text-decoration:none; color:inherit; padding:12px 14px; }
    .hot-link:hover { background:#f8f9ff; }
    .rank { width:28px; text-align:center; font-weight:700; color:#ff4d4f; flex:0 0 28px; }
    .title { flex:1; line-height:1.45; }
    .heat { color:#ff7a00; font-size:13px; white-space:nowrap; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <h1>${escapedTitle}</h1>
      <div class="sub">已启用兼容视图（针对动态反爬页面），来源：${escapedUrl}</div>
    </div>
    <ul class="hot-list">${rows}</ul>
  </div>
</body>
</html>`;
}

/**
 * SPA（如 SvelteKit）路由到 /world/ 后，相对路径 ./ _app/... 会被解析成
 * /world/_app/...（404），真实资源在站点根 /_app/...。生成候选 URL 依次尝试。
 */
function buildCssUrlCandidates(cssUrl: string, baseUrl: string): string[] {
  const out: string[] = [];
  const push = (u: string) => {
    if (u && !out.includes(u)) out.push(u);
  };

  try {
    push(new URL(cssUrl, baseUrl).href);
  } catch {
    /* ignore */
  }

  try {
    const resolved = new URL(cssUrl, baseUrl);
    const appIdx = resolved.pathname.indexOf('/_app/');
    if (appIdx > 0) {
      push(resolved.origin + resolved.pathname.slice(appIdx) + resolved.search);
    }
    // 相对属性值（如 ./_app/...）优先按站点根解析
    if (!/^https?:\/\//i.test(cssUrl) && cssUrl.includes('_app/')) {
      push(new URL(cssUrl.replace(/^\.\//, '/'), resolved.origin).href);
    }
  } catch {
    /* ignore */
  }

  return out;
}

/**
 * 下载CSS文件到本地并返回本地路径
 */
async function downloadCSS(cssUrl: string, baseUrl: string, useProxy = false): Promise<string> {
  const candidates = buildCssUrlCandidates(cssUrl, baseUrl);
  if (candidates.length === 0) {
    return cssUrl;
  }

  let lastError: any = null;

  for (const absoluteUrl of candidates) {
    try {
      const domain = new URL(absoluteUrl).hostname.replace(/\./g, '_');
      const cssDir = path.join(__dirname, '../../../frontend/css-cache', domain);

      await fs.mkdir(cssDir, { recursive: true });

      const urlObj = new URL(absoluteUrl);
      const filePath =
        urlObj.pathname.substring(1).replace(/\//g, '_') +
        (urlObj.search ? '_' + urlObj.search.replace(/[=?&]/g, '_') : '');
      let fileName = filePath || 'style.css';
      // 查询串拼进文件名后可能变成 xxx.css__v1_uuid，MIME 无法识别为 text/css；统一保证以 .css 结尾便于静态服务与缓存
      if (!fileName.toLowerCase().endsWith('.css')) {
        fileName = `${fileName}.css`;
      }
      const fullPath = path.join(cssDir, fileName);

      try {
        await fs.access(fullPath);
        console.log(`CSS already cached: ${fullPath}`);
        return `/css-cache/${domain}/${fileName}`;
      } catch {
        // 文件不存在，继续下载
      }

      const response = await axios.get(
        absoluteUrl,
        withAxiosProxy(
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; FeedGen Page Renderer/1.0)',
              Accept: 'text/css,*/*;q=0.1',
              Referer: baseUrl,
            },
            timeout: 8000,
            validateStatus: (s) => s >= 200 && s < 300,
          },
          useProxy
        )
      );

      let cssContent = response.data;
      const baseUrlForRelative = absoluteUrl.substring(0, absoluteUrl.lastIndexOf('/') + 1);

      cssContent = cssContent.replace(
        /(url\(\s*['"]?)([^'")]+)(['"]?\s*\))/g,
        (match: string, prefix: string, url: string, suffix: string) => {
          try {
            const absoluteResourceUrl = new URL(url, baseUrlForRelative).href;
            return `${prefix}${absoluteResourceUrl}${suffix}`;
          } catch (e) {
            return match;
          }
        }
      );

      await fs.writeFile(fullPath, cssContent, 'utf-8');
      console.log(`CSS downloaded and cached: ${fullPath}${candidates[0] !== absoluteUrl ? ` (fallback from ${candidates[0]})` : ''}`);

      return `/css-cache/${domain}/${fileName}`;
    } catch (error: any) {
      lastError = error;
      console.warn(`CSS candidate failed ${absoluteUrl}: ${error.message}`);
    }
  }

  console.error(`Failed to download CSS from ${cssUrl}:`, lastError?.message || 'unknown');
  // 失败时尽量返回可访问的根路径候选，避免把 /world/_app 404 链写进预览
  return candidates.find((u) => u.includes('/_app/') && !u.match(/:\/\/[^/]+\/[^/]+\/_app\//)) || candidates[candidates.length - 1] || cssUrl;
}

/**
 * 处理页面中的CSS链接，将其替换为本地缓存版本
 */
async function processCSSLinks(page: any, baseUrl: string, useProxy = false): Promise<void> {
  // 获取页面中所有的CSS链接（同时保留原始属性，便于按站点根回退）
  const cssHrefsRaw = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]')) as HTMLLinkElement[];
    return links.map(link => ({
      href: link.href,
      attrHref: link.getAttribute('href') || link.href,
      id: link.id,
      media: link.media || 'all',
      precedence: (link as any).precedence || null
    }));
  });
  // Yahoo 等重页面 stylesheet 极多，全量缓存会拖死渲染；只处理前若干个
  const cssHrefs = (cssHrefsRaw || []).slice(0, 12);

  let originBase = baseUrl;
  try {
    originBase = new URL(page.url?.() || baseUrl).origin + '/';
  } catch {
    try {
      originBase = new URL(baseUrl).origin + '/';
    } catch {
      /* keep baseUrl */
    }
  }
  
  // 下载并替换CSS链接
  for (const cssLink of cssHrefs) {
    if (cssLink.href) {
      try {
        // 优先用属性值 + 站点根，避免 SPA 子路由把 ./_app 解析错
        const localPath = await downloadCSS(cssLink.attrHref || cssLink.href, originBase, useProxy);
        
        // 通过evaluate在页面中替换CSS链接
        await page.evaluate((params: any) => {
          // 查找匹配的link元素（处理可能的相对路径情况）
          let link = document.querySelector(`link[href="${params.originalHref}"]`) as HTMLLinkElement;
          if (!link) {
            // 如果没找到，尝试使用URL解析来匹配
            const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]')) as HTMLLinkElement[];
            link = links.find(l => {
              try {
                const hrefAbsolute = new URL(l.href, document.baseURI).href;
                return hrefAbsolute === params.absoluteOriginalHref;
              } catch (e) {
                return l.href === params.originalHref;
              }
            }) as HTMLLinkElement;
          }
          
          if (link) {
            // 创建新的link元素
            const newLink = document.createElement('link');
            newLink.rel = 'stylesheet';
            newLink.type = 'text/css';
            newLink.href = params.newHref;
            if (params.id) newLink.id = params.id;
            if (params.media) newLink.media = params.media;
            if (params.precedence) (newLink as any).precedence = params.precedence;
            
            // 替换旧的link元素
            link.parentNode?.replaceChild(newLink, link);
          } else {
            // 如果找不到精确匹配的link，添加一个新的link标签到head
            const newLink = document.createElement('link');
            newLink.rel = 'stylesheet';
            newLink.type = 'text/css';
            newLink.href = params.newHref;
            if (params.id) newLink.id = params.id;
            if (params.media) newLink.media = params.media;
            if (params.precedence) (newLink as any).precedence = params.precedence;
            
            document.head.appendChild(newLink);
          }
        }, {
          originalHref: cssLink.href,
          absoluteOriginalHref: new URL(cssLink.href, baseUrl).href,
          newHref: localPath,
          id: cssLink.id,
          media: cssLink.media,
          precedence: cssLink.precedence
        });
      } catch (error: any) {
        console.error(`Error processing CSS link ${cssLink.href}:`, error.message);
      }
    }
  }
}

const pageRendererRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/fingerprints', async (_req, res) => {
    return { profiles: listFingerprintProfiles() };
  });

  // 一键 AI 解析：把页面 HTML 交给 DeepSeek，返回列表/标题/链接等选择器
  fastify.post('/ai-parse-selectors', async (req: any, res: any) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !String(authHeader).startsWith('Bearer ')) {
        return res.status(401).send({ error: '请先登录后再使用 AI 解析' });
      }
      try {
        await req.jwtVerify();
      } catch {
        return res.status(401).send({ error: '登录已失效，请重新登录' });
      }

      const body = (req.body || {}) as { html?: string; pageUrl?: string; url?: string };
      const html = String(body.html || '');
      if (!html.trim()) {
        return res.status(400).send({ error: 'html 不能为空' });
      }
      if (html.length > 2_500_000) {
        return res.status(400).send({ error: 'HTML 过大，请先加载精简后的页面再试' });
      }

      const result = await parseHtmlSelectorsWithDeepSeek({
        html,
        pageUrl: String(body.pageUrl || body.url || ''),
      });

      return {
        ok: true,
        selectors: result.selectors,
        confidence: result.confidence,
        reason: result.reason,
        model: result.model,
        truncated: result.truncated,
        htmlCharsSent: result.htmlCharsSent,
      };
    } catch (error: any) {
      req.log?.error?.(error) || console.error('[ai-parse-selectors]', error);
      const code = String(error?.code || '');
      if (code === 'AI_NOT_CONFIGURED') {
        return res.status(503).send({ error: error.message || 'AI 未配置' });
      }
      if (code === 'EMPTY_HTML' || code === 'AI_PARSE_INCOMPLETE' || code === 'AI_BAD_JSON') {
        return res.status(422).send({
          error: error.message || 'AI 解析结果不可用',
          details: error.raw ? String(error.raw).slice(0, 400) : undefined,
        });
      }
      const status = Number(error?.status);
      return res.status(Number.isFinite(status) && status >= 400 && status < 600 ? status : 500).send({
        error: error?.message || 'AI 解析失败',
      });
    }
  });

  // 渲染页面并提取DOM结构
  fastify.post('/render', async (req, res) => {
    try {
      const {
        url,
        authCookie,
        useProxy,
        pageLanguage,
        fingerprintProfile,
        waitForSelector,
        waitForTimeout = 10000,
        waitForNetworkIdle = false,
        waitForAjax = false,
        ajaxWaitTime
      } = req.body as RenderPageRequest;

      // 验证URL
      if (!url) {
        return res.status(400).send({ error: 'URL is required' });
      }

      try {
        new URL(url);
      } catch (e) {
        return res.status(400).send({ error: 'Invalid URL format' });
      }

      // RSS/Atom 原生 feed 不需要浏览器渲染：直接拒绝并提示调用方走原生抓取，
      // 避免 Playwright 对 XML 地址报 ERR_CONNECTION_REFUSED 刷屏。
      if (/(rss|atom|feed|\.xml)(\?|#|$|\/)/i.test(url)) {
        return res.status(400).send({
          error: 'URL looks like a native RSS/Atom feed; use native feed fetch instead of page rendering',
          code: 'NATIVE_FEED_URL',
        });
      }

      let useProxyForRender = useProxy === true;
      if (useProxyForRender) {
        const proxyOk = await isLocalProxyAvailable(800);
        if (!proxyOk) {
          return res.status(502).send({
            error: '已勾选代理，但本机 127.0.0.1:7890 不可用，请先启动 Clash/代理后再试',
            code: 'PROXY_UNAVAILABLE',
          });
        }
      }

      const resolvedUrl = applyPageLanguageToUrl(url, pageLanguage);
      const yahooLike = isYahooFinanceHost(resolvedUrl);
      // Yahoo 等站点常年长连接，networkidle 几乎永远等不到
      const preferNetworkIdle = waitForNetworkIdle === true && !yahooLike;
      const navTimeoutMs = Math.min(
        Math.max(Number(waitForTimeout) || 10000, 5000),
        yahooLike ? 12000 : 20000
      );

      // 先快速探测 429，避免 Playwright 在限流响应上卡死数分钟
      const probe = await probePageHttpStatus(resolvedUrl, useProxyForRender);
      if (probe.status === 429 || /too many requests/i.test(probe.snippet)) {
        console.warn(`[page-renderer] probe hit ${probe.status || 429} for ${resolvedUrl}`);
        const html = enhanceHtmlWithHighlighting(
          buildRateLimitFallbackHtml(resolvedUrl, probe.status || 429, probe.snippet)
        );
        return {
          html,
          url,
          finalUrl: resolvedUrl,
          statusCode: probe.status || 429,
          title: `访问受限 (${probe.status || 429})`,
          elements: [],
          antiBotSignals: ['http_429', 'rate_limit'],
          requiresLogin: false,
          loginHint: '目标站限流（HTTP 429）。请稍后重试、更换代理出口，或改用「实时交互」。',
        } as RenderResponse;
      }

      let browser;
      try {
        // stealth 插件已自动注册 40+ 反检测补丁（webdriver, plugins, chrome.runtime, canvas, webgl 等）

        // 启动浏览器
        browser = await launchChromium({
          args: getDefaultLaunchArgs(true),
        });

        const localeOpts = getBrowserLocaleForPageLanguage(pageLanguage);
        const context = await createStealthContext(browser, {
          useProxy: useProxyForRender,
          locale: localeOpts.locale,
          acceptLanguage: localeOpts.acceptLanguage,
          extraHTTPHeaders: { 'Accept-Language': localeOpts.acceptLanguage },
          ...(fingerprintProfile ? { fingerprintProfile } : {}),
        });
        const page = await context.newPage();

        if (authCookie?.trim()) {
          await injectAuthCookies(context, authCookie.trim(), resolvedUrl);
        }
        if (isYouTubeHost(resolvedUrl)) {
          await injectYouTubeLanguagePreference(context, pageLanguage);
        }

        // 补充中文 locale 指纹覆盖
        await applySupplementaryPatches(page, {
          acceptLanguage: localeOpts.acceptLanguage,
          ...(fingerprintProfile ? { fingerprintProfile } : {}),
        });

        // 访问页面
        console.log(`Rendering page: ${resolvedUrl}${useProxyForRender ? ' (proxy)' : ''}${pageLanguage ? ` lang=${pageLanguage}` : ''}`);

        // 根据参数决定等待策略；失败时回退到更宽松模式
        let navResp: any = null;
        const referer = isDouyinHost(resolvedUrl)
          ? 'https://www.douyin.com/'
          : new URL(resolvedUrl).origin + '/';
        const gotoTarget = async () => {
          if (isDouyinHost(resolvedUrl)) {
            await page.goto('https://www.douyin.com/', {
              waitUntil: 'domcontentloaded',
              timeout: navTimeoutMs,
            }).catch(() => {});
            await page.waitForTimeout(1500);
          } else if (isYouTubeHost(resolvedUrl)) {
            await navigateYouTubePage(page, resolvedUrl);
            return null;
          }
          // Yahoo 等：先 commit（拿到响应头即继续），避免 429/挑战页拖死 domcontentloaded
          if (yahooLike) {
            return page.goto(resolvedUrl, {
              waitUntil: 'commit',
              timeout: navTimeoutMs,
              referer,
            });
          }
          return page.goto(resolvedUrl, {
            waitUntil: preferNetworkIdle ? 'networkidle' : 'domcontentloaded',
            timeout: navTimeoutMs,
            referer,
          });
        };
        try {
          navResp = await gotoTarget();
        } catch {
          navResp = await page.goto(resolvedUrl, {
            waitUntil: 'domcontentloaded',
            timeout: Math.min(navTimeoutMs + 5000, 18000),
            referer,
          });
        }

        const navStatus = typeof navResp?.status === 'function' ? navResp.status() : undefined;
        if (navStatus === 429) {
          const html = enhanceHtmlWithHighlighting(
            buildRateLimitFallbackHtml(resolvedUrl, 429, 'Edge: Too Many Requests')
          );
          return {
            html,
            url,
            finalUrl: page.url() || resolvedUrl,
            statusCode: 429,
            title: '访问受限 (429)',
            elements: [],
            antiBotSignals: ['http_429', 'rate_limit'],
            requiresLogin: false,
            loginHint: '目标站限流（HTTP 429）。请稍后重试、更换代理出口，或改用「实时交互」。',
          } as RenderResponse;
        }

        // 等待特定选择器（如果提供）
        if (waitForSelector) {
          try {
            await page.waitForSelector(waitForSelector, { timeout: 5000 });
          } catch (e) {
            console.warn(`Selector ${waitForSelector} not found within timeout, continuing...`);
          }
        }
        
        // 如果需要等待AJAX请求完成
        if (waitForAjax) {
          const ajaxWaitMs = ajaxWaitTime || 3000;
          console.log(`Waiting for ${ajaxWaitMs}ms for AJAX requests to complete...`);
          await page.waitForTimeout(ajaxWaitMs);
        }

        // 增加短暂人类化等待，给反爬挑战/延迟渲染脚本留执行窗口
        await page.waitForTimeout(1200);
        
        // 等待页面完全稳定
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
          console.log('Network activity still present, continuing anyway...');
        });
        
        // 滚动页面以触发懒加载内容
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });
        await page.waitForTimeout(1000); // 等待1秒让懒加载内容加载
        
        // 再次滚动回顶部
        await page.evaluate(() => {
          window.scrollTo(0, 0);
        });

         // 获取页面标题
         const title = await page.title();
         const finalUrl = page.url();
         const statusCode = typeof navResp?.status === 'function' ? navResp.status() : undefined;
         const finalUrlLower = (finalUrl || '').toLowerCase();

         // 针对抖音热榜这类动态壳页面：提取结构化榜单，生成可视化解析友好的降级HTML
         let fallbackHtml: string | null = null;
         try {
           const isDouyinHotlist = /so-landing\.douyin\.com\/landings\/hotlist/i.test(url) || /抖音热榜/.test(title);
           if (isDouyinHotlist) {
             const hotItems = await page.evaluate(() => {
               const text = (document.body?.innerText || '').replace(/\u00a0/g, ' ');
               const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
               const merged = lines.join('\n');
               const seen = new Set<string>();
               const out: Array<{ rank: number; title: string; heat: string }> = [];

               // 典型格式：1 标题 1197万
               const lineRe = /^(\d{1,2})\s+(.+?)\s+(\d+(?:\.\d+)?(?:万|亿|w|W)?)$/;
               for (const line of lines) {
                 const m = line.match(lineRe);
                 if (!m) continue;
                 const rank = Number(m[1]);
                 if (!Number.isFinite(rank) || rank <= 0 || rank > 100) continue;
                 const title = (m[2] || '').trim();
                 const heat = (m[3] || '').trim();
                 if (!title || title.length < 2) continue;
                 const key = `${rank}-${title}`;
                 if (seen.has(key)) continue;
                 seen.add(key);
                 out.push({ rank, title, heat });
                 if (out.length >= 80) break;
               }

               // 兜底：在整段文本中做全局匹配
               if (out.length < 10) {
                 const globalRe = /(?:^|\n)(\d{1,2})\s+([^\n]{2,80}?)\s+(\d+(?:\.\d+)?(?:万|亿|w|W)?)(?=\n|$)/g;
                 let m: RegExpExecArray | null;
                 while ((m = globalRe.exec(merged)) !== null) {
                   const rank = Number(m[1]);
                   if (!Number.isFinite(rank) || rank <= 0 || rank > 100) continue;
                   const title = (m[2] || '').trim();
                   const heat = (m[3] || '').trim();
                   if (!title) continue;
                   const key = `${rank}-${title}`;
                   if (seen.has(key)) continue;
                   seen.add(key);
                   out.push({ rank, title, heat });
                   if (out.length >= 80) break;
                 }
               }

               out.sort((a, b) => a.rank - b.rank);
               return out.slice(0, 60);
             });

             if (hotItems.length >= 10) {
               fallbackHtml = renderDouyinHotlistFallbackHtml(title, finalUrl || url, hotItems);
               console.log(`[page-renderer] 使用抖音热榜兼容视图，提取到 ${hotItems.length} 条`);
             }
           }
         } catch (fallbackErr: any) {
           console.warn(`[page-renderer] 构建热榜兼容视图失败: ${fallbackErr?.message || String(fallbackErr)}`);
         }

         // 针对 YouTube 频道页：提取本地化标题并生成静态兼容 HTML（iframe 去脚本后仍可正确预览）
         if (!fallbackHtml && isYouTubeChannelVideosUrl(finalUrl || resolvedUrl)) {
           try {
             const { html: ytHtml, items: ytItems } = await buildYouTubeFallbackHtml(
               page,
               title,
               finalUrl || resolvedUrl,
             );
             if (ytItems.length >= 3 && ytHtml) {
               fallbackHtml = ytHtml;
               console.log(`[page-renderer] 使用 YouTube 兼容视图，提取到 ${ytItems.length} 条视频`);
             }
           } catch (ytErr: any) {
             console.warn(`[page-renderer] 构建 YouTube 兼容视图失败: ${ytErr?.message || String(ytErr)}`);
           }
         }

         // 处理CSS链接，下载到本地缓存并替换为本地路径（Yahoo 等重站已截断数量）
         if (!yahooLike) {
           await processCSSLinks(page, url, useProxyForRender);
           // 等待所有CSS资源加载完成
           await page.waitForFunction(() => {
             const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]')) as HTMLLinkElement[];
             const styles = Array.from(document.querySelectorAll('style'));
             
             // 检查样式表是否加载完成
             const stylesLoaded = links.every(link => {
               // 如果是外部样式表，检查其href和sheet属性
               if (link.href && link.sheet === null) {
                 // 如果样式表有href但sheet为空，说明仍在加载
                 return false;
               }
               return true;
             });
             
             return stylesLoaded && styles.length >= 0; // 确保style标签也存在
           }, { timeout: 5000 }).catch(() => {
             console.log('Not all stylesheets loaded within timeout, continuing anyway...');
           });
           
           // 等待页面上的所有图片加载完成
           await page.waitForFunction(() => {
             const images = Array.from(document.querySelectorAll('img')) as HTMLImageElement[];
             return images.every(img => img.complete);
           }, { timeout: 3000 }).catch(() => {
             console.log('Not all images loaded within timeout, continuing anyway...');
           });
         }
         
         // 获取完整HTML内容
         const html = fallbackHtml || await page.content();

         // 常见反爬/挑战页信号，供前端判断是否命中风控页
          const antiBotSignals = await page.evaluate(detectAntiBotSignalsInPage);
          if (navStatus === 429 || /too many requests/i.test(html.slice(0, 2000))) {
            if (!antiBotSignals.includes('http_429')) antiBotSignals.push('http_429');
            if (!antiBotSignals.includes('rate_limit')) antiBotSignals.push('rate_limit');
          }

         const loginSignals = await collectLoginSignals(page);
         const loginEval = evaluateLoginRequired({
           pageUrl: finalUrl || url,
           loginSignals,
           hasAuthCookie: !!authCookie,
         });
         const requiresLogin = loginEval.requiresLogin;
         const loginHint = loginEval.loginHint;

        // 可视化解析前端不消费 elements；全量遍历 Yahoo 等巨型 DOM 极慢，默认跳过
        let elements: ElementInfo[] = [];
        const shouldExtractElements = false;
        if (shouldExtractElements) {
        elements = await page.evaluate(() => {
          // id 可能含 URL 编码（如 %e9%a6%96）、冒号、中文等，直接拼 #id 会触发 querySelector 非法选择器异常
          const escHashId = (id: string) =>
            typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
              ? CSS.escape(id)
              : id.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
          const escIdAttr = (id: string) => id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

          const allElements = Array.from(document.querySelectorAll('*'));
          const elementsInfo: ElementInfo[] = [];

          for (const element of allElements) {
            try {
            // 跳过一些不需要的元素
            if (
              element.tagName === 'SCRIPT' || 
              element.tagName === 'STYLE' || 
              element.tagName === 'META' || 
              element.tagName === 'LINK' ||
              element.tagName === 'NOSCRIPT'
            ) {
              continue;
            }

            // 获取元素边界框（部分反爬/动态页面在滚动后可能返回 undefined）
            let rect: DOMRect | undefined;
            try {
              rect = element.getBoundingClientRect();
            } catch {
              continue;
            }
            if (!rect) continue;
            
            // 只处理可见元素（在视口内且尺寸大于0）
            if (rect.width > 0 && rect.height > 0 && rect.bottom > 0) {
              // 生成CSS选择器路径
              let path = '';
              let current: Element | null = element;
              const pathParts: string[] = [];

              while (current && current !== document.documentElement) {
                let selector = current.tagName.toLowerCase();

                // 添加ID（如果有且唯一）
                if (current.id) {
                  const idExists = document.querySelectorAll('#' + escHashId(current.id)).length === 1;
                  if (idExists) {
                    selector = '#' + escHashId(current.id);
                    pathParts.unshift(selector);
                    break; // ID是唯一的，可以停止向上遍历
                  } else {
                    selector += `[id="${escIdAttr(current.id)}"]`;
                  }
                } else {
                  // 添加类名
                  if (current.className) {
                    // 确保className是字符串
                    let classNameStr = current.className;
                    if (typeof current.className !== 'string') {
                      classNameStr = String(current.className);
                    }
                    
                    const classes = classNameStr
                      .split(/\s+/)
                      .filter(cls => cls.length > 0);
                    
                    if (classes.length > 0) {
                      // 只使用第一个类名以避免过于复杂的选择器
                      selector += `.${classes[0]}`;
                    }
                  }

                  // 添加同类型兄弟元素索引
                  const parent = current.parentElement;
                  if (parent) {
                    const siblings = Array.from(parent.children).filter(
                      el => el.tagName === current!.tagName
                    );
                    
                    if (siblings.length > 1) {
                      const index = siblings.indexOf(current) + 1;
                      selector += `:nth-of-type(${index})`;
                    }
                  }
                }

                pathParts.unshift(selector);
                current = current.parentElement;
              }

              path = pathParts.join(' > ');

              elementsInfo.push({
                tag: element.tagName.toLowerCase(),
                id: element.id || '',
                classes: element.className ? (typeof element.className === 'string' ? element.className.split(/\s+/) : [String(element.className)]) : [],
                text: element.textContent?.substring(0, 100) || '', // 只取前100个字符
                attributes: Array.from(element.attributes).reduce((acc, attr) => {
                  acc[attr.name] = attr.value;
                  return acc;
                }, {} as Record<string, string>),
                boundingBox: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height
                },
                path: path
              });
            }
            } catch {
              continue;
            }
          }

          return elementsInfo;
        });
        }

        // 生成带DOM高亮功能的HTML
        const enhancedHtml = enhanceHtmlWithHighlighting(html);

        // 返回结果
        const result: RenderResponse = {
          html: enhancedHtml,
          url: url,
          finalUrl,
          statusCode,
          title: title,
          elements: elements,
          antiBotSignals,
          requiresLogin,
          loginHint
        };

        // 如果需要截图，取消注释以下代码
        /*
        try {
          const screenshot = await page.screenshot({ type: 'png', fullPage: true });
          result.screenshot = screenshot.toString('base64');
        } catch (screenshotErr) {
          console.warn('Screenshot generation failed:', screenshotErr);
        }
        */

        return result;
      } catch (pageError) {
        console.error('Page rendering error:', pageError);
        return res.status(500).send({ error: `Failed to render page: ${(pageError as Error).message}` });
      } finally {
        if (browser) {
          try {
            await browser.close();
          } catch (closeError) {
            console.error('Error closing browser:', closeError);
          }
        }
      }
    } catch (error) {
      console.error('Render route error:', error);
      return res.status(500).send({ error: 'Internal server error during page rendering' });
    }
  });

  // 根据坐标获取元素信息
  fastify.post('/element-at-coordinates', async (req, res) => {
    try {
      const { url, x, y } = req.body as { url: string; x: number; y: number; };

      if (!url || x === undefined || y === undefined) {
        return res.status(400).send({ error: 'URL and coordinates (x, y) are required' });
      }

      let browser;
      try {
        browser = await launchChromium({ args: getDefaultLaunchArgs() });

        const page = await browser.newPage();
        await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (compatible; FeedGen Page Renderer/1.0)' });
        
        await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 });

        // 在页面上执行脚本来获取指定坐标的元素
        const elementInfo = await page.evaluate(({ x, y }) => {
          const escHashId = (id: string) =>
            typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
              ? CSS.escape(id)
              : id.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
          const escIdAttr = (id: string) => id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

          // 获取指定坐标的元素
          const element = document.elementFromPoint(x, y);
          
          if (!element) {
            return null;
          }

          // 获取元素的边界框
          let rect: DOMRect | undefined;
          try {
            rect = element.getBoundingClientRect();
          } catch {
            return null;
          }
          if (!rect) return null;
          
          // 生成CSS选择器路径
          let path = '';
          let current: Element | null = element;
          const pathParts: string[] = [];

          while (current && current !== document.documentElement) {
            let selector = current.tagName.toLowerCase();

            // 添加ID（如果有且唯一）
            if (current.id) {
              const idExists = document.querySelectorAll('#' + escHashId(current.id)).length === 1;
              if (idExists) {
                selector = '#' + escHashId(current.id);
                pathParts.unshift(selector);
                break; // ID是唯一的，可以停止向上遍历
              } else {
                selector += `[id="${escIdAttr(current.id)}"]`;
              }
            } else {
              // 添加类名
              if (current.className) {
                // 确保className是字符串
                let classNameStr = current.className;
                if (typeof current.className !== 'string') {
                  classNameStr = String(current.className);
                }
                
                const classes = classNameStr
                  .split(/\s+/)
                  .filter(cls => cls.length > 0);
                
                if (classes.length > 0) {
                  // 只使用第一个类名以避免过于复杂的选择器
                  selector += `.${classes[0]}`;
                }
              }

              // 添加同类型兄弟元素索引
              const parent = current.parentElement;
              if (parent) {
                const siblings = Array.from(parent.children).filter(
                  el => el.tagName === current!.tagName
                );
                
                if (siblings.length > 1) {
                  const index = siblings.indexOf(current) + 1;
                  selector += `:nth-of-type(${index})`;
                }
              }
            }

            pathParts.unshift(selector);
            current = current.parentElement;
          }

          path = pathParts.join(' > ');

          return {
            tag: element.tagName.toLowerCase(),
            id: element.id || '',
            classes: element.className ? element.className.split(/\s+/) : [],
            text: element.textContent?.substring(0, 100) || '',
            attributes: Array.from(element.attributes).reduce((acc, attr) => {
              acc[attr.name] = attr.value;
              return acc;
            }, {} as Record<string, string>),
            boundingBox: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            },
            path: path
          };
        }, { x, y });

        return { element: elementInfo };
      } catch (pageError) {
        console.error('Element lookup error:', pageError);
        return res.status(500).send({ error: `Failed to find element: ${(pageError as Error).message}` });
      } finally {
        if (browser) {
          try {
            await browser.close();
          } catch (closeError) {
            console.error('Error closing browser:', closeError);
          }
        }
      }
    } catch (error) {
      console.error('Element lookup route error:', error);
      return res.status(500).send({ error: 'Internal server error during element lookup' });
    }
  });
};

/**
 * 增强HTML以支持DOM高亮功能
 */
function enhanceHtmlWithHighlighting(html: string): string {
  // 使用cheerio加载HTML
  const $ = cheerio.load(html);

  // 添加高亮相关的CSS样式
  const highlightStyles = `
    <style id="dom-highlight-styles">
      .dom-element-highlight {
        outline: 2px solid #FF5722 !important;
        outline-offset: 0 !important;
        background-color: rgba(255, 87, 34, 0.1) !important;
        box-shadow: 0 0 10px rgba(255, 87, 34, 0.5) !important;
        position: relative !important;
        z-index: 999999 !important;
      }
      
      .dom-element-hover-highlight {
        outline: 2px solid #2196F3 !important;
        outline-offset: 0 !important;
        background-color: rgba(33, 150, 243, 0.1) !important;
        box-shadow: 0 0 8px rgba(33, 150, 243, 0.4) !important;
        position: relative !important;
        z-index: 999998 !important;
      }
      
      .dom-overlay-panel {
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 100% !important;
        height: 100% !important;
        pointer-events: none !important;
        z-index: 999997 !important;
        display: none !important;
      }
    </style>
  `;

  // 添加高亮相关的JavaScript
  const highlightScript = `
    <script id="dom-highlight-script">
      (function() {
        if (window.domHighlightInitialized) {
          return; // 避免重复初始化
        }
        window.domHighlightInitialized = true;
        
        // 存储当前高亮的元素
        let currentHighlightedElement = null;
        let currentSelectedElement = null;
        
        // 高亮指定元素
        function highlightElement(element, isHover = false) {
          // 先清除之前的高亮
          clearHighlight();
          
          if (!element) return;
          
          // 添加高亮类
          const highlightClass = isHover ? 'dom-element-hover-highlight' : 'dom-element-highlight';
          element.classList.add(highlightClass);
          
          // 记录当前高亮元素
          if (isHover) {
            // 悬停高亮不替换选中元素
          } else {
            currentSelectedElement = element;
          }
          currentHighlightedElement = element;
        }
        
        // 清除高亮
        function clearHighlight() {
          if (currentHighlightedElement) {
            currentHighlightedElement.classList.remove('dom-element-hover-highlight');
            // 不移除选中高亮，因为它表示用户的选择
            currentHighlightedElement = null;
          }
        }
        
        // 清除所有高亮
        function clearAllHighlights() {
          const highlightedElements = document.querySelectorAll('.dom-element-highlight, .dom-element-hover-highlight');
          highlightedElements.forEach(el => {
            el.classList.remove('dom-element-highlight', 'dom-element-hover-highlight');
          });
          currentHighlightedElement = null;
          currentSelectedElement = null;
        }
        
        // 通过CSS选择器高亮元素
        function highlightElementBySelector(selector) {
          const element = document.querySelector(selector);
          if (element) {
            highlightElement(element, false);
            return true;
          }
          return false;
        }
        
        // 通过坐标高亮元素
        function highlightElementAtCoordinates(x, y) {
          const element = document.elementFromPoint(x, y);
          if (element && element !== document.documentElement && element !== document.body) {
            highlightElement(element, true);
            return element;
          }
          return null;
        }
        
        // 添加鼠标悬停事件监听
        function enableHoverHighlight() {
          document.addEventListener('mouseover', function(e) {
            // 检查是否有特殊模式激活（比如选择模式）
            if (window.highlightMode === 'select') {
              highlightElement(e.target, true);
            }
          });
          
          document.addEventListener('mouseout', function(e) {
            // 只有在悬停模式下才清除高亮
            if (window.highlightMode === 'select' && currentHighlightedElement === e.target) {
              clearHighlight();
            }
          });
        }
        
        // 初始化
        enableHoverHighlight();
        
        // 将函数暴露到全局作用域，以便外部调用
        window.FeedGenDOMHighlighter = {
          highlightElement,
          highlightElementBySelector,
          highlightElementAtCoordinates,
          clearHighlight,
          clearAllHighlights,
          getCurrentSelectedElement: () => currentSelectedElement
        };
      })();
    </script>
  `;

  // 将样式添加到head中
  $('head').append(highlightStyles);
  
  // 将脚本添加到body末尾
  $('body').append(highlightScript);

  // 返回修改后的HTML
  return $.html();
}

export { pageRendererRoutes };
import { FastifyPluginAsync } from 'fastify';
import {
  launchChromium,
  createStealthContext,
  getDefaultLaunchArgs,
  applySupplementaryPatches,
  injectAuthCookies,
  isDouyinHost,
} from '../services/browser';
import * as cheerio from 'cheerio';
import * as path from 'path';
import * as fs from 'fs/promises';
import axios from 'axios';

interface RenderPageRequest {
  url: string;
  authCookie?: string;
  useProxy?: boolean;
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
 * 下载CSS文件到本地并返回本地路径
 */
async function downloadCSS(cssUrl: string, baseUrl: string): Promise<string> {
  try {
    // 确保CSS URL是绝对路径
    const absoluteUrl = new URL(cssUrl, baseUrl).href;
    
    // 获取域名作为目录名
    const domain = new URL(absoluteUrl).hostname.replace(/\./g, '_');
    const cssDir = path.join(__dirname, '../../../frontend/css-cache', domain);
    
    // 创建目录
    await fs.mkdir(cssDir, { recursive: true });
    
    // 生成文件名（基于URL路径和查询参数）
    const urlObj = new URL(absoluteUrl);
    const filePath = urlObj.pathname.substring(1).replace(/\//g, '_') + (urlObj.search ? '_' + urlObj.search.replace(/[=?&]/g, '_') : '');
    let fileName = filePath || 'style.css';
    // 查询串拼进文件名后可能变成 xxx.css__v1_uuid，MIME 无法识别为 text/css；统一保证以 .css 结尾便于静态服务与缓存
    if (!fileName.toLowerCase().endsWith('.css')) {
      fileName = `${fileName}.css`;
    }
    const fullPath = path.join(cssDir, fileName);
    
    // 检查是否已存在缓存
    try {
      await fs.access(fullPath);
      console.log(`CSS already cached: ${fullPath}`);
      return `/css-cache/${domain}/${fileName}`;
    } catch {
      // 文件不存在，继续下载
    }
    
    // 下载CSS内容
    const response = await axios.get(absoluteUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FeedGen Page Renderer/1.0)',
        'Accept': 'text/css,*/*;q=0.1',
        'Referer': baseUrl
      },
      timeout: 10000
    });
    
    // 处理CSS中的相对路径引用（如字体、背景图等）
    let cssContent = response.data;
    const baseUrlForRelative = absoluteUrl.substring(0, absoluteUrl.lastIndexOf('/') + 1);
    
    // 替换CSS中的相对路径为绝对路径
    cssContent = cssContent.replace(
      /(url\(\s*['"]?)([^'")]+)(['"]?\s*\))/g,
      (match: string, prefix: string, url: string, suffix: string) => {
        try {
          const absoluteResourceUrl = new URL(url, baseUrlForRelative).href;
          return `${prefix}${absoluteResourceUrl}${suffix}`;
        } catch (e) {
          // 如果URL解析失败，保持原样
          return match;
        }
      }
    );
    
    // 保存到本地
    await fs.writeFile(fullPath, cssContent, 'utf-8');
    console.log(`CSS downloaded and cached: ${fullPath}`);
    
    return `/css-cache/${domain}/${fileName}`;
  } catch (error: any) {
    console.error(`Failed to download CSS from ${cssUrl}:`, error.message);
    return cssUrl; // 返回原始URL作为备选
  }
}

/**
 * 处理页面中的CSS链接，将其替换为本地缓存版本
 */
async function processCSSLinks(page: any, baseUrl: string): Promise<void> {
  // 获取页面中所有的CSS链接
  const cssHrefs = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]')) as HTMLLinkElement[];
    return links.map(link => ({
      href: link.href,
      id: link.id,
      media: link.media || 'all',
      precedence: (link as any).precedence || null
    }));
  });
  
  // 下载并替换CSS链接
  for (const cssLink of cssHrefs) {
    if (cssLink.href) {
      try {
        // 确定CSS URL（处理相对路径）
        const absoluteUrl = new URL(cssLink.href, baseUrl).href;
        const localPath = await downloadCSS(absoluteUrl, baseUrl);
        
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
  // 渲染页面并提取DOM结构
  fastify.post('/render', async (req, res) => {
    try {
      const {
        url,
        authCookie,
        useProxy,
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

      let browser;
      try {
        // stealth 插件已自动注册 40+ 反检测补丁（webdriver, plugins, chrome.runtime, canvas, webgl 等）

        // 启动浏览器
        browser = await launchChromium({
          args: getDefaultLaunchArgs(true),
        });

        const useProxyForRender = useProxy === true;
        const context = await createStealthContext(browser, {
          useProxy: useProxyForRender,
        });
        const page = await context.newPage();

        if (authCookie?.trim()) {
          await injectAuthCookies(context, authCookie.trim(), url);
        }

        // 补充中文 locale 指纹覆盖
        await applySupplementaryPatches(page);

        // 访问页面
        console.log(`Rendering page: ${url}${useProxyForRender ? ' (proxy)' : ''}`);

        // 根据参数决定等待策略；失败时回退到更宽松模式
        let navResp: any = null;
        const gotoTarget = async () => {
          if (isDouyinHost(url)) {
            await page.goto('https://www.douyin.com/', {
              waitUntil: 'domcontentloaded',
              timeout: waitForTimeout,
            }).catch(() => {});
            await page.waitForTimeout(1500);
          }
          return page.goto(url, {
            waitUntil: waitForNetworkIdle ? 'networkidle' : 'domcontentloaded',
            timeout: waitForTimeout,
            referer: isDouyinHost(url) ? 'https://www.douyin.com/' : new URL(url).origin + '/',
          });
        };
        try {
          navResp = await gotoTarget();
        } catch {
          navResp = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: waitForTimeout + 8000,
            referer: isDouyinHost(url) ? 'https://www.douyin.com/' : new URL(url).origin + '/',
          });
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

         // 处理CSS链接，下载到本地缓存并替换为本地路径
         await processCSSLinks(page, url);
         
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
         
         // 获取完整HTML内容
         const html = fallbackHtml || await page.content();

         // 常见反爬/挑战页信号，供前端判断是否命中风控页
          const antiBotSignals = await page.evaluate(() => {
            const bodyText = (document.body?.innerText || '').toLowerCase();
            const titleText = (document.title || '').toLowerCase();
            const rawHtml = (document.documentElement?.outerHTML || '').slice(0, 120000).toLowerCase();
            const cleanHtml = rawHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                                     .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

            // 强信号
            const strongSignals: Array<[string, string]> = [
              ['geetest', 'geetest'],
              ['访问受限', '访问受限'],
              ['请完成验证', '请完成验证'],
              ['webcast.amemv.com', 'webcast.amemv.com'],
              ['sec_sdk', 'sec_sdk'],
            ];
            for (const [label, token] of strongSignals) {
              if (bodyText.includes(token) || titleText.includes(token) || cleanHtml.includes(token)) return [label];
            }

            // captcha 仅在可见文本中判定
            if (bodyText.includes('captcha') || titleText.includes('captcha')) return ['captcha'];

            // 弱信号
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
            if (titleHits.length > 0) return titleHits;
            if (bodyHits.length >= 2) return bodyHits;

            return [];
          });

         const loginSignals = await page.evaluate(() => {
           const text = (document.body?.innerText || '').toLowerCase();
           const hits: string[] = [];
           const checks: Array<[string, string]> = [
             ['登录', '登录'],
             ['注册', '注册'],
             ['手机号', '手机号'],
             ['验证码', '验证码'],
             ['password', 'password'],
             ['sign in', 'sign in'],
           ];
           for (const [label, token] of checks) {
             if (text.includes(token)) hits.push(label);
           }
           return Array.from(new Set(hits));
         });
         const requiresLogin =
           /login|signin|register|signup/.test(finalUrlLower) ||
           (loginSignals.length >= 2 && !authCookie);
         const loginHint = requiresLogin
           ? '目标站点需要登录态。请在可视化解析器中填写该站点登录后的 Cookie 再重试。'
           : undefined;

        // 提取页面元素信息
        const elements: ElementInfo[] = await page.evaluate(() => {
          // id 可能含 URL 编码（如 %e9%a6%96）、冒号、中文等，直接拼 #id 会触发 querySelector 非法选择器异常
          const escHashId = (id: string) =>
            typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
              ? CSS.escape(id)
              : id.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
          const escIdAttr = (id: string) => id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

          const allElements = Array.from(document.querySelectorAll('*'));
          const elementsInfo: ElementInfo[] = [];

          for (const element of allElements) {
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

            // 获取元素边界框
            const rect = element.getBoundingClientRect();
            
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
          }

          return elementsInfo;
        });

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
          const rect = element.getBoundingClientRect();
          
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
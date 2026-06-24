import type { Page } from 'playwright';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isYouTubeHost } from './pageLanguage';

const YOUTUBE_EXTRACT_BROWSER_SCRIPT = readFileSync(
  join(__dirname, 'youtubePageExtract.browser.js'),
  'utf8',
);

export interface YouTubeVideoItem {
  title: string;
  url: string;
  meta?: string;
  thumbnail?: string;
}

export function isYouTubeChannelVideosUrl(url: string): boolean {
  if (!isYouTubeHost(url)) return false;
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    return path.includes('/videos')
      || path.includes('/shorts')
      || path.includes('/streams')
      || path.includes('/@')
      || path.includes('/channel/');
  } catch {
    return false;
  }
}

/** 访问 YouTube 前先预热首页，再进入频道页并等待列表渲染 */
export async function navigateYouTubePage(page: Page, targetUrl: string): Promise<void> {
  if (!isYouTubeHost(targetUrl)) return;

  await page.goto('https://www.youtube.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  }).catch(() => {});
  await page.waitForTimeout(1500);

  await page.goto(targetUrl, {
    waitUntil: 'networkidle',
    timeout: 60000,
    referer: 'https://www.youtube.com/',
  }).catch(() => page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
    referer: 'https://www.youtube.com/',
  }));

  await page.waitForSelector(
    'ytd-rich-item-renderer, ytd-rich-grid-media, ytd-grid-video-renderer, ytd-video-renderer',
    { timeout: 15000 },
  ).catch(() => {});
  await page.waitForTimeout(2500);

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
  }).catch(() => {});
  await page.waitForTimeout(1200);
}

export async function extractYouTubeChannelVideos(page: Page): Promise<YouTubeVideoItem[]> {
  return page.evaluate(YOUTUBE_EXTRACT_BROWSER_SCRIPT) as Promise<YouTubeVideoItem[]>;
}

export function renderYouTubeChannelFallbackHtml(
  pageTitle: string,
  pageUrl: string,
  items: YouTubeVideoItem[],
): string {
  const escapedTitle = (pageTitle || 'YouTube 频道').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapedUrl = (pageUrl || '').replace(/"/g, '&quot;');
  const rows = items.map((it) => {
    const title = it.title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const meta = (it.meta || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const href = it.url.replace(/"/g, '&quot;');
    const thumb = (it.thumbnail || '').replace(/"/g, '&quot;');
    const thumbHtml = thumb
      ? `<img class="feedgen-yt-thumb" src="${thumb}" alt="">`
      : '';
    return `
      <li class="feedgen-yt-item">
        <a class="feedgen-yt-link" href="${href}">
          ${thumbHtml}
          <span class="feedgen-yt-title">${title}</span>
        </a>
        ${meta ? `<span class="feedgen-yt-meta">${meta}</span>` : ''}
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
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif; background:#f9f9f9; color:#0f0f0f; }
    .wrap { max-width:1100px; margin:0 auto; padding:16px; }
    .head { background:#fff; border:1px solid #e5e5e5; border-radius:12px; padding:14px 16px; margin-bottom:12px; }
    .head h1 { margin:0 0 6px; font-size:22px; }
    .head .sub { color:#606060; font-size:13px; word-break:break-all; }
    ul.feedgen-yt-list { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; }
    li.feedgen-yt-item { background:#fff; border:1px solid #e5e5e5; border-radius:12px; overflow:hidden; padding:12px; }
    a.feedgen-yt-link { display:flex; gap:10px; text-decoration:none; color:inherit; align-items:flex-start; }
    a.feedgen-yt-link:hover .feedgen-yt-title { color:#065fd4; }
    .feedgen-yt-thumb { width:120px; height:68px; object-fit:cover; border-radius:8px; flex:0 0 120px; background:#eee; }
    .feedgen-yt-title { display:block; font-size:14px; line-height:1.45; font-weight:600; }
    .feedgen-yt-meta { display:block; margin-top:8px; color:#606060; font-size:12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <h1>${escapedTitle}</h1>
      <div class="sub">YouTube 兼容视图（已按所选语言提取标题），来源：${escapedUrl}</div>
    </div>
    <ul id="feedgen-yt-videos" class="feedgen-yt-list">${rows}</ul>
  </div>
</body>
</html>`;
}

/** 从 YouTube 页面提取视频并生成兼容 HTML（不写入当前页，避免 TrustedHTML 限制） */
export async function buildYouTubeFallbackHtml(
  page: Page,
  pageTitle: string,
  pageUrl: string,
): Promise<{ html: string; items: YouTubeVideoItem[] }> {
  const items = await extractYouTubeChannelVideos(page);
  const html = items.length >= 3
    ? renderYouTubeChannelFallbackHtml(pageTitle, pageUrl, items)
    : '';
  return { html, items };
}

/** 在新文档中加载兼容 HTML，供爬取阶段 DOM 选择器使用 */
export async function loadYouTubeFallbackHtmlOnPage(
  page: Page,
  pageTitle: string,
  pageUrl: string,
): Promise<YouTubeVideoItem[]> {
  const { html, items } = await buildYouTubeFallbackHtml(page, pageTitle, pageUrl);
  if (!html) return items;
  await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  return items;
}

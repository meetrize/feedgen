import { WebSocket } from 'ws';
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  launchChromium,
  createStealthContext,
  applySupplementaryPatches,
  getLivePreviewLaunchOptions,
  injectAuthCookies,
  isDouyinHost,
} from './browser';
import {
  applyPageLanguageToUrl,
  getBrowserLocaleForPageLanguage,
  injectYouTubeLanguagePreference,
  isYouTubeHost,
} from '../utils/pageLanguage';
import { navigateYouTubePage } from '../utils/youtubePageExtract';

export interface LivePreviewSession {
  sessionId: string;
  userId: number;
  url: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  clients: Set<WebSocket>;
  screenshotTimer: ReturnType<typeof setInterval> | null;
  createdAt: number;
  useProxy: boolean;
}

const sessions = new Map<string, LivePreviewSession>();
const SESSION_TTL_MS = 15 * 60 * 1000;
const SCREENSHOT_INTERVAL_MS = 900;

function broadcast(session: LivePreviewSession, msg: object) {
  const payload = JSON.stringify(msg);
  for (const client of session.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

async function sendScreenshot(session: LivePreviewSession) {
  try {
    const buf = await session.page.screenshot({ type: 'jpeg', quality: 55, fullPage: false });
    broadcast(session, {
      type: 'live_screenshot',
      payload: {
        sessionId: session.sessionId,
        screenshotBase64: buf.toString('base64'),
        width: 1440,
        height: 900,
      },
    });
  } catch (e: any) {
    console.error(`[livePreview] 截图失败 session=${session.sessionId}:`, e?.message);
  }
}

function startScreenshotLoop(session: LivePreviewSession) {
  if (session.screenshotTimer) return;
  session.screenshotTimer = setInterval(() => {
    void sendScreenshot(session);
  }, SCREENSHOT_INTERVAL_MS);
}

function stopScreenshotLoop(session: LivePreviewSession) {
  if (session.screenshotTimer) {
    clearInterval(session.screenshotTimer);
    session.screenshotTimer = null;
  }
}

function attachNetworkDiagnostics(page: Page, sessionId: string) {
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (!/verify|captcha|nocaptcha|secsdk|mssdk|zijie|yhgfb|bd-ticket/i.test(url)) return;
    console.warn(
      `[livePreview] 验证码相关请求失败 session=${sessionId}: ${url.slice(0, 120)} | ${request.failure()?.errorText || ''}`,
    );
  });
}

async function navigateDouyinWithWarmup(page: Page, targetUrl: string) {
  if (!isDouyinHost(targetUrl)) {
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
      referer: new URL(targetUrl).origin + '/',
    });
    return;
  }

  console.log(`[livePreview] 抖音预热：先访问首页再进入目标页`);
  await page.goto('https://www.douyin.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  }).catch((e) => {
    console.warn('[livePreview] 抖音首页预热失败:', e?.message);
  });
  await page.waitForTimeout(2000);

  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
    referer: 'https://www.douyin.com/',
  }).catch((e) => {
    console.warn('[livePreview] 抖音目标页加载警告:', e?.message);
  });
}

export async function startLivePreviewSession(params: {
  sessionId: string;
  userId: number;
  url: string;
  authCookie?: string;
  useProxy?: boolean;
  pageLanguage?: string;
  fingerprintProfile?: string;
}): Promise<LivePreviewSession> {
  const existing = sessions.get(params.sessionId);
  if (existing) {
    await stopLivePreviewSession(params.sessionId);
  }

  const useProxy = params.useProxy !== false && (
    params.useProxy === true || isDouyinHost(params.url)
  );
  const resolvedUrl = applyPageLanguageToUrl(params.url, params.pageLanguage);
  const localeOpts = getBrowserLocaleForPageLanguage(params.pageLanguage);

  const browser = await launchChromium(getLivePreviewLaunchOptions());
  const fingerprintProfile = params.fingerprintProfile?.trim() || '';
  const context = await createStealthContext(browser, {
    useProxy,
    locale: localeOpts.locale,
    acceptLanguage: localeOpts.acceptLanguage,
    extraHTTPHeaders: { 'Accept-Language': localeOpts.acceptLanguage },
    ...(fingerprintProfile ? { fingerprintProfile } : {}),
  });
  const page = await context.newPage();
  await applySupplementaryPatches(page, {
    acceptLanguage: localeOpts.acceptLanguage,
    ...(fingerprintProfile ? { fingerprintProfile } : {}),
  });
  attachNetworkDiagnostics(page, params.sessionId);

  if (params.authCookie?.trim()) {
    const count = await injectAuthCookies(context, params.authCookie.trim(), resolvedUrl);
    console.log(`[livePreview] 已注入 ${count} 条 Cookie session=${params.sessionId} proxy=${useProxy}`);
  }
  if (isYouTubeHost(resolvedUrl)) {
    await injectYouTubeLanguagePreference(context, params.pageLanguage);
  }

  if (isDouyinHost(resolvedUrl)) {
    await navigateDouyinWithWarmup(page, resolvedUrl);
  } else if (isYouTubeHost(resolvedUrl)) {
    await navigateYouTubePage(page, resolvedUrl);
  } else {
    await page.goto(resolvedUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
      referer: new URL(resolvedUrl).origin + '/',
    });
  }

  await page.waitForTimeout(2000);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  const session: LivePreviewSession = {
    sessionId: params.sessionId,
    userId: params.userId,
    url: resolvedUrl,
    browser,
    context,
    page,
    clients: new Set(),
    screenshotTimer: null,
    createdAt: Date.now(),
    useProxy,
  };

  sessions.set(params.sessionId, session);
  startScreenshotLoop(session);
  await sendScreenshot(session);

  setTimeout(() => {
    void stopLivePreviewSession(params.sessionId);
  }, SESSION_TTL_MS);

  return session;
}

export function getLivePreviewSession(sessionId: string): LivePreviewSession | undefined {
  return sessions.get(sessionId);
}

export function attachLivePreviewClient(sessionId: string, ws: WebSocket, userId: number): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.userId !== userId) return false;
  session.clients.add(ws);
  void sendScreenshot(session);
  return true;
}

export function detachLivePreviewClient(sessionId: string, ws: WebSocket) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.clients.delete(ws);
}

export async function stopLivePreviewSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;
  stopScreenshotLoop(session);
  sessions.delete(sessionId);
  for (const client of session.clients) {
    try {
      client.close(1000, 'session ended');
    } catch {}
  }
  try {
    await session.browser.close();
  } catch {}
}

export async function handleLivePreviewInput(
  sessionId: string,
  msg: {
    action: string;
    x?: number;
    y?: number;
    startX?: number;
    startY?: number;
    endX?: number;
    endY?: number;
    steps?: number;
    durationMs?: number;
    text?: string;
    key?: string;
  }
) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const { page } = session;

  try {
    if (msg.action === 'click' && msg.x !== undefined && msg.y !== undefined) {
      await page.mouse.click(msg.x, msg.y);
    } else if (msg.action === 'mousedown' && msg.x !== undefined && msg.y !== undefined) {
      await page.mouse.move(msg.x, msg.y);
      await page.mouse.down();
    } else if (msg.action === 'mousemove' && msg.x !== undefined && msg.y !== undefined) {
      await page.mouse.move(msg.x, msg.y);
    } else if (msg.action === 'mouseup' && msg.x !== undefined && msg.y !== undefined) {
      await page.mouse.move(msg.x, msg.y);
      await page.mouse.up();
    } else if (
      msg.action === 'drag'
      && msg.startX !== undefined
      && msg.startY !== undefined
      && msg.endX !== undefined
      && msg.endY !== undefined
    ) {
      const steps = msg.steps || 24;
      await page.mouse.move(msg.startX, msg.startY);
      await page.mouse.down();
      for (let i = 1; i <= steps; i++) {
        const x = msg.startX + (msg.endX - msg.startX) * (i / steps);
        const y = msg.startY + (msg.endY - msg.startY) * (i / steps);
        await page.mouse.move(Math.round(x), Math.round(y));
        await new Promise((r) => setTimeout(r, 25));
      }
      await page.mouse.up();
    } else if (msg.action === 'wheel' && msg.y !== undefined) {
      await page.mouse.wheel(0, msg.y);
    } else if (msg.action === 'type' && msg.text) {
      await page.keyboard.type(msg.text, { delay: 40 });
    } else if (msg.action === 'press' && msg.key) {
      await page.keyboard.press(msg.key);
    } else if (msg.action === 'refresh') {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1500);
    } else if (
      msg.action === 'holdPress'
      && msg.x !== undefined
      && msg.y !== undefined
    ) {
      const durationMs = Math.max(500, Math.min(15000, msg.durationMs ?? 3500));
      await page.mouse.move(msg.x, msg.y);
      await page.mouse.down();
      await page.waitForTimeout(durationMs);
      await page.mouse.up();
    }

    const skipScreenshot = msg.action === 'mousemove' || msg.action === 'mousedown';
    if (!skipScreenshot) {
      await page.waitForTimeout(400);
      await sendScreenshot(session);
    }
  } catch (e) {
    console.error(`[livePreview] 远程输入失败 session=${sessionId}:`, e);
  }
}

export async function snapshotLivePreviewSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  const { page, context } = session;
  const html = await page.content();
  const title = await page.title().catch(() => '');
  const finalUrl = page.url();
  const cookies = await context.cookies();
  const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  return {
    html,
    title,
    finalUrl,
    cookies,
    cookieString,
    useProxy: session.useProxy,
  };
}

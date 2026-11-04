import { WebSocket } from 'ws';
import type { Browser, Page } from 'playwright';
import { prisma } from '../server';

export interface CaptchaTicket {
  captchaId: string;
  feedId: number;
  feedTitle: string;
  targetUrl: string;
  pageUrl: string;
  captchaType: string;
  screenshotBase64: string;
  signals: string[];
  detectedAt: number;
  resolvedAt?: number;
  resolvedBy?: string;
}

const captchaTickets = new Map<string, CaptchaTicket>();
const adminClients = new Set<WebSocket>();

const TICKET_TIMEOUT_MS = 30 * 60 * 1000;

export function addClient(ws: WebSocket) {
  adminClients.add(ws);
  for (const ticket of captchaTickets.values()) {
    if (!ticket.resolvedAt) {
      ws.send(JSON.stringify({ type: 'captcha_detected', payload: ticket }));
    }
  }
}

export function removeClient(ws: WebSocket) {
  adminClients.delete(ws);
}

function broadcast(msg: object) {
  const payload = JSON.stringify(msg);
  for (const client of adminClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

export function createCaptchaTicket(params: {
  feedId: number;
  feedTitle: string;
  targetUrl: string;
  pageUrl: string;
  captchaType?: string;
  screenshotBase64: string;
  signals: string[];
}): CaptchaTicket {
  const captchaId = `${Date.now()}_${params.feedId}`;
  const ticket: CaptchaTicket = {
    captchaId,
    feedId: params.feedId,
    feedTitle: params.feedTitle,
    targetUrl: params.targetUrl,
    pageUrl: params.pageUrl,
    captchaType: params.captchaType || detectCaptchaTypeFromSignals(params.signals),
    screenshotBase64: params.screenshotBase64,
    signals: params.signals,
    detectedAt: Date.now(),
  };

  captchaTickets.set(captchaId, ticket);
  broadcast({ type: 'captcha_detected', payload: ticket });

  setTimeout(() => {
    const t = captchaTickets.get(captchaId);
    if (t && !t.resolvedAt) {
      t.resolvedAt = Date.now();
      t.resolvedBy = 'timeout';
      broadcast({ type: 'captcha_resolved', payload: { captchaId, feedId: t.feedId, action: 'timeout' }});
    }
  }, TICKET_TIMEOUT_MS);

  return ticket;
}

export function resolveCaptchaTicket(
  captchaId: string,
  action: 'cookie' | 'retry' | 'disabled' | 'dismissed' | 'processed'
): CaptchaTicket | undefined {
  const ticket = captchaTickets.get(captchaId);
  if (!ticket || ticket.resolvedAt) return undefined;

  ticket.resolvedAt = Date.now();
  ticket.resolvedBy = action;

  broadcast({ type: 'captcha_resolved', payload: { captchaId, feedId: ticket.feedId, action }});
  return ticket;
}

/** 取消等待中的文本验证码输入 */
export function cancelCaptchaWait(captchaId: string): boolean {
  const entry = captchaResolvers.get(captchaId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  entry.resolve(null);
  captchaResolvers.delete(captchaId);
  return true;
}

/** 手动标记为已处理：关闭 ticket、远程会话与打码等待，不再推送 */
export function markCaptchaTicketProcessed(captchaId: string): CaptchaTicket | undefined {
  endRemoteSession(captchaId, 'skipped');
  cancelCaptchaWait(captchaId);
  return resolveCaptchaTicket(captchaId, 'processed');
}

export function markAllCaptchaTicketsProcessed(): number {
  const pending = getPendingTickets();
  for (const ticket of pending) {
    markCaptchaTicketProcessed(ticket.captchaId);
  }
  return pending.length;
}

export function getPendingTickets(): CaptchaTicket[] {
  return Array.from(captchaTickets.values())
    .filter((t) => !t.resolvedAt)
    .sort((a, b) => b.detectedAt - a.detectedAt);
}

function detectCaptchaTypeFromSignals(signals: string[]): string {
  const lower = signals.map((s) => s.toLowerCase());
  if (lower.some((s) => s.includes('cloudflare'))) return 'cloudflare';
  if (lower.some((s) => s.includes('geetest'))) return 'geetest';
  if (lower.some((s) => s.includes('captcha'))) return 'captcha';
  if (lower.some((s) => s.includes('verify') || s.includes('验证') || s.includes('人机'))) return 'captcha';
  return 'unknown';
}

// ── 远程打码：等待管理员输入验证码 ──

interface CaptchaWaitEntry {
  resolve: (answer: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const captchaResolvers = new Map<string, CaptchaWaitEntry>();

export function createCaptchaWait(captchaId: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      captchaResolvers.delete(captchaId);
      resolve(null);
    }, timeoutMs);
    captchaResolvers.set(captchaId, { resolve, timer });
  });
}

export function resolveCaptchaWait(captchaId: string, answer: string): boolean {
  const entry = captchaResolvers.get(captchaId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  entry.resolve(answer);
  captchaResolvers.delete(captchaId);
  return true;
}

// ── 远程交互：管理员在本地操作服务端浏览器 ──

type RemoteResult = 'passed' | 'failed' | 'timeout' | 'skipped';

interface RemoteSession {
  captchaId: string;
  feedId: number;
  page: Page;
  /** 管理员 start-remote 独占的 Browser；爬虫复用页时为空 */
  browser: Browser | null;
  ownedBy: 'crawler' | 'admin';
  waiters: Array<(result: RemoteResult) => void>;
  timer: ReturnType<typeof setTimeout>;
  screenshotTimer: ReturnType<typeof setInterval> | null;
  screenshotInFlight: boolean;
  pendingShot: ReturnType<typeof setTimeout> | null;
  lastMoveAt?: number;
  closed: boolean;
}

const remoteSessions = new Map<string, RemoteSession>();
const MAX_ADMIN_REMOTE_BROWSERS = 2;
const REMOTE_SCREENSHOT_INTERVAL_MS = 900;
const REMOTE_POST_INPUT_SHOT_MS = 60;
const REMOTE_MOVE_THROTTLE_MS = 24;
const REMOTE_JPEG_QUALITY = 42;

export function hasRemoteSession(captchaId: string): boolean {
  const s = remoteSessions.get(captchaId);
  return !!(s && !s.closed);
}

export function countAdminOwnedRemoteBrowsers(): number {
  let n = 0;
  for (const s of remoteSessions.values()) {
    if (!s.closed && s.ownedBy === 'admin' && s.browser) n += 1;
  }
  return n;
}

export function canStartAdminRemoteBrowser(): boolean {
  return countAdminOwnedRemoteBrowsers() < MAX_ADMIN_REMOTE_BROWSERS;
}

async function sendScreenshot(session: RemoteSession, quality = REMOTE_JPEG_QUALITY) {
  if (session.closed || session.screenshotInFlight) return;
  if (adminClients.size === 0) return;
  session.screenshotInFlight = true;
  try {
    if (session.page.isClosed()) {
      broadcast({
        type: 'remote_error',
        payload: { captchaId: session.captchaId, error: '页面已关闭，请重新开始远程交互' },
      });
      return;
    }
    const buf = await session.page.screenshot({
      type: 'jpeg',
      quality,
      fullPage: false,
      // 只截视口，显著小于全页；animations 关闭减少抖动等待
      animations: 'disabled',
      caret: 'hide',
    });
    broadcast({
      type: 'remote_screenshot',
      payload: {
        captchaId: session.captchaId,
        screenshotBase64: buf.toString('base64'),
        width: 1440,
        height: 900,
      },
    });
  } catch (e: any) {
    console.error(`[captchaRelay] 截图失败 ticket=${session.captchaId}:`, e?.message);
    broadcast({
      type: 'remote_error',
      payload: { captchaId: session.captchaId, error: e?.message || '截图失败' },
    });
  } finally {
    session.screenshotInFlight = false;
  }
}

function requestImmediateScreenshot(session: RemoteSession, quality = 48) {
  if (session.closed) return;
  if (session.pendingShot) return;
  session.pendingShot = setTimeout(() => {
    session.pendingShot = null;
    void sendScreenshot(session, quality);
  }, REMOTE_POST_INPUT_SHOT_MS);
}

function startRemoteScreenshotLoop(session: RemoteSession) {
  if (session.screenshotTimer) return;
  session.screenshotTimer = setInterval(() => {
    void sendScreenshot(session);
  }, REMOTE_SCREENSHOT_INTERVAL_MS);
}

function stopRemoteScreenshotLoop(session: RemoteSession) {
  if (session.screenshotTimer) {
    clearInterval(session.screenshotTimer);
    session.screenshotTimer = null;
  }
  if (session.pendingShot) {
    clearTimeout(session.pendingShot);
    session.pendingShot = null;
  }
}

export async function refreshRemoteScreenshot(captchaId: string): Promise<boolean> {
  const session = remoteSessions.get(captchaId);
  if (!session || session.closed) return false;
  await sendScreenshot(session, 52);
  return true;
}

export async function exportCookieStringFromPage(page: Page): Promise<{
  cookieString: string;
  finalUrl: string;
  cookieCount: number;
}> {
  let finalUrl = '';
  try {
    finalUrl = page.url();
  } catch {
    finalUrl = '';
  }
  const context = page.context();
  const cookies = await context.cookies();
  // 按 name 去重（多 domain 时保留较长 domain / 后出现的）
  const byName = new Map<string, string>();
  for (const c of cookies) {
    if (!c?.name) continue;
    byName.set(c.name, c.value ?? '');
  }
  const cookieString = Array.from(byName.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
    .slice(0, 8000);
  return { cookieString, finalUrl, cookieCount: byName.size };
}

export async function persistFeedAuthCookie(
  feedId: number,
  cookieString: string,
  meta?: { finalUrl?: string; captchaId?: string }
): Promise<{ saved: boolean; reason?: string }> {
  if (!feedId || feedId <= 0) {
    return { saved: false, reason: '无效 feedId（创建验证码工单时未绑定 Feed）' };
  }
  const trimmed = cookieString.trim();
  if (!trimmed) {
    return { saved: false, reason: 'Cookie 为空' };
  }

  const feedFull = await prisma.feed.findUnique({
    where: { id: feedId },
    select: { id: true, selector_rules: true },
  });
  if (!feedFull) {
    return { saved: false, reason: 'Feed 不存在' };
  }

  const data: Record<string, unknown> = {
    auth_cookie: trimmed,
    anti_bot_status: 'normal',
    anti_bot_detected_at: null,
    anti_bot_message: null,
    updated_at: new Date(),
  };

  // 同步写回 selector_rules.authCookie，避免规则里旧 Cookie 覆盖列字段
  const rules =
    feedFull.selector_rules && typeof feedFull.selector_rules === 'object'
      ? { ...(feedFull.selector_rules as Record<string, unknown>) }
      : null;
  if (rules) {
    rules.authCookie = trimmed;
    data.selector_rules = rules;
  }

  await prisma.feed.update({
    where: { id: feedId },
    data,
  });

  console.log(
    `[captchaRelay] 已保存登录 Cookie 到 Feed #${feedId}` +
      ` cookies=${trimmed.split(';').filter(Boolean).length}` +
      (meta?.finalUrl ? ` url=${meta.finalUrl}` : '') +
      (meta?.captchaId ? ` ticket=${meta.captchaId}` : '')
  );
  return { saved: true };
}

/**
 * 绑定 Playwright 页到远程交互会话。
 * 同一 captchaId 已有活跃会话时复用，避免重复开浏览器导致旧页被覆盖后截图全挂。
 */
export async function startRemoteSession(
  captchaId: string,
  page: Page,
  timeoutMs: number,
  options?: { browser?: Browser | null; ownedBy?: 'crawler' | 'admin'; feedId?: number }
): Promise<RemoteResult> {
  const ticket = captchaTickets.get(captchaId);
  const feedId = options?.feedId ?? ticket?.feedId ?? 0;

  const existing = remoteSessions.get(captchaId);
  if (existing && !existing.closed) {
    if (feedId > 0 && existing.feedId <= 0) existing.feedId = feedId;
    await sendScreenshot(existing, 52);
    return new Promise<RemoteResult>((resolve) => {
      existing.waiters.push(resolve);
    });
  }

  if (existing) {
    stopRemoteScreenshotLoop(existing);
    remoteSessions.delete(captchaId);
  }

  return new Promise<RemoteResult>((resolve) => {
    const session: RemoteSession = {
      captchaId,
      feedId,
      page,
      browser: options?.browser ?? null,
      ownedBy: options?.ownedBy ?? (options?.browser ? 'admin' : 'crawler'),
      waiters: [resolve],
      timer: setTimeout(() => {
        void finalizeRemoteSession(captchaId, 'timeout');
      }, timeoutMs),
      screenshotTimer: null,
      screenshotInFlight: false,
      pendingShot: null,
      closed: false,
    };
    remoteSessions.set(captchaId, session);
    startRemoteScreenshotLoop(session);
    void sendScreenshot(session, 52);
  });
}

async function saveSessionCookiesIfNeeded(
  session: RemoteSession,
  result: RemoteResult
): Promise<{ saved: boolean; cookieCount: number; reason?: string }> {
  // 仅在管理员确认「完成验证」时落库，避免 timeout/skip 误覆盖有效 Cookie
  if (result !== 'passed') {
    return { saved: false, cookieCount: 0, reason: '非完成状态，跳过保存' };
  }
  if (session.page.isClosed()) {
    return { saved: false, cookieCount: 0, reason: '页面已关闭，无法导出 Cookie' };
  }

  try {
    const exported = await exportCookieStringFromPage(session.page);
    const persist = await persistFeedAuthCookie(session.feedId, exported.cookieString, {
      finalUrl: exported.finalUrl,
      captchaId: session.captchaId,
    });
    if (persist.saved) {
      resolveCaptchaTicket(session.captchaId, 'cookie');
      broadcast({
        type: 'remote_cookies_saved',
        payload: {
          captchaId: session.captchaId,
          feedId: session.feedId,
          cookieCount: exported.cookieCount,
          finalUrl: exported.finalUrl,
        },
      });
      return { saved: true, cookieCount: exported.cookieCount };
    }
    broadcast({
      type: 'remote_error',
      payload: {
        captchaId: session.captchaId,
        error: `登录状态未保存：${persist.reason || '未知原因'}`,
      },
    });
    return {
      saved: false,
      cookieCount: exported.cookieCount,
      ...(persist.reason ? { reason: persist.reason } : {}),
    };
  } catch (e: any) {
    console.error(`[captchaRelay] 保存 Cookie 失败 ticket=${session.captchaId}:`, e?.message || e);
    broadcast({
      type: 'remote_error',
      payload: {
        captchaId: session.captchaId,
        error: `保存 Cookie 失败: ${e?.message || e}`,
      },
    });
    return { saved: false, cookieCount: 0, reason: e?.message || '保存失败' };
  }
}

async function finalizeRemoteSession(captchaId: string, result: RemoteResult) {
  const session = remoteSessions.get(captchaId);
  if (!session || session.closed) return;
  session.closed = true;
  stopRemoteScreenshotLoop(session);
  clearTimeout(session.timer);
  remoteSessions.delete(captchaId);

  // 先导出 Cookie 再关浏览器
  if (result === 'passed') {
    await saveSessionCookiesIfNeeded(session, result);
  }

  const waiters = session.waiters.splice(0);
  for (const w of waiters) {
    try {
      w(result);
    } catch {}
  }

  if (session.browser) {
    try {
      await session.browser.close();
    } catch {}
  }
}

export function endRemoteSession(captchaId: string, result: 'passed' | 'failed' | 'skipped') {
  void finalizeRemoteSession(captchaId, result);
}

/** 结束全部远程交互会话（含管理员独占浏览器） */
export async function cleanupAllRemoteSessions(): Promise<{ closedSessions: number }> {
  const ids = Array.from(remoteSessions.keys());
  for (const id of ids) {
    await finalizeRemoteSession(id, 'skipped');
  }
  return { closedSessions: ids.length };
}

export function listRemoteSessionSummary(): Array<{
  captchaId: string;
  ownedBy: 'crawler' | 'admin';
  hasBrowser: boolean;
  closed: boolean;
}> {
  return Array.from(remoteSessions.values()).map((s) => ({
    captchaId: s.captchaId,
    ownedBy: s.ownedBy,
    hasBrowser: !!s.browser,
    closed: s.closed,
  }));
}

export async function handleRemoteInput(captchaId: string, msg: {
  action: string;
  x?: number;
  y?: number;
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  steps?: number;
  text?: string;
}) {
  const session = remoteSessions.get(captchaId);
  if (!session || session.closed) {
    broadcast({
      type: 'remote_error',
      payload: { captchaId, error: '远程会话不存在或已结束，请重新点击「远程交互」' },
    });
    return;
  }
  const { page } = session;

  try {
    if (page.isClosed()) {
      broadcast({
        type: 'remote_error',
        payload: { captchaId, error: '浏览器页面已关闭，请重新开始远程交互' },
      });
      await finalizeRemoteSession(captchaId, 'failed');
      return;
    }

    if (msg.action === 'refresh') {
      await sendScreenshot(session, 55);
      return;
    }

    if (msg.action === 'click' && msg.x !== undefined && msg.y !== undefined) {
      await page.mouse.click(msg.x, msg.y, { delay: 20 });
    } else if (msg.action === 'mousedown' && msg.x !== undefined && msg.y !== undefined) {
      await page.mouse.move(msg.x, msg.y);
      await page.mouse.down();
    } else if (msg.action === 'mousemove' && msg.x !== undefined && msg.y !== undefined) {
      const now = Date.now();
      if (session.lastMoveAt && now - session.lastMoveAt < REMOTE_MOVE_THROTTLE_MS) return;
      session.lastMoveAt = now;
      await page.mouse.move(msg.x, msg.y);
      return; // 移动不截图，由心跳补帧
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
      const steps = Math.max(6, Math.min(16, msg.steps || 12));
      await page.mouse.move(msg.startX, msg.startY);
      await page.mouse.down();
      for (let i = 1; i <= steps; i++) {
        const x = msg.startX + (msg.endX - msg.startX) * (i / steps);
        const y = msg.startY + (msg.endY - msg.startY) * (i / steps);
        await page.mouse.move(Math.round(x), Math.round(y));
      }
      await page.mouse.up();
    } else if (msg.action === 'type' && msg.text) {
      await page.keyboard.type(msg.text, { delay: 12 });
    } else if (msg.action === 'done') {
      await finalizeRemoteSession(captchaId, 'passed');
      return;
    } else if (msg.action === 'skip') {
      await finalizeRemoteSession(captchaId, 'skipped');
      return;
    } else if (msg.action === 'close') {
      // 仅关闭管理员独占浏览器；爬虫会话保持，避免误杀等待中的验证码
      if (session.ownedBy === 'admin') {
        await finalizeRemoteSession(captchaId, 'skipped');
      }
      return;
    }

    requestImmediateScreenshot(session);
  } catch (e: any) {
    console.error(`[captchaRelay] 远程交互执行失败:`, e);
    broadcast({
      type: 'remote_error',
      payload: { captchaId, error: e?.message || '操作失败' },
    });
  }
}

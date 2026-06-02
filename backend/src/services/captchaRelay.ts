import { WebSocket } from 'ws';
import type { Page } from 'playwright';

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
  action: 'cookie' | 'retry' | 'disabled' | 'dismissed'
): CaptchaTicket | undefined {
  const ticket = captchaTickets.get(captchaId);
  if (!ticket) return undefined;

  ticket.resolvedAt = Date.now();
  ticket.resolvedBy = action;

  broadcast({ type: 'captcha_resolved', payload: { captchaId, feedId: ticket.feedId, action }});
  return ticket;
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

interface RemoteSession {
  captchaId: string;
  page: Page;
  resolve: (result: 'passed' | 'failed' | 'timeout' | 'skipped') => void;
  timer: ReturnType<typeof setTimeout>;
}

const remoteSessions = new Map<string, RemoteSession>();

export async function startRemoteSession(
  captchaId: string,
  page: Page,
  timeoutMs: number
): Promise<'passed' | 'failed' | 'timeout' | 'skipped'> {
  // 立即截取并发送首张截图
  await sendScreenshot(captchaId, page);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      remoteSessions.delete(captchaId);
      resolve('timeout');
    }, timeoutMs);
    remoteSessions.set(captchaId, { captchaId, page, resolve, timer });
  });
}

async function sendScreenshot(captchaId: string, page: Page) {
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 50, fullPage: false });
    const count = adminClients.size;
    broadcast({ type: 'remote_screenshot', payload: { captchaId, screenshotBase64: buf.toString('base64'), width: 1440, height: 900 }});
    console.log(`[captchaRelay] 截图已发送 ticket=${captchaId} size=${buf.length} clients=${count}`);
  } catch (e: any) {
    console.error(`[captchaRelay] 截图失败 ticket=${captchaId}:`, e?.message);
  }
}

export function endRemoteSession(captchaId: string, result: 'passed' | 'failed' | 'skipped') {
  const session = remoteSessions.get(captchaId);
  if (!session) return;
  clearTimeout(session.timer);
  session.resolve(result);
  remoteSessions.delete(captchaId);
}

export async function handleRemoteInput(captchaId: string, msg: { action: string; x?: number; y?: number; startX?: number; startY?: number; endX?: number; endY?: number; steps?: number; text?: string }) {
  const session = remoteSessions.get(captchaId);
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
    } else if (msg.action === 'drag' && msg.startX !== undefined && msg.startY !== undefined && msg.endX !== undefined && msg.endY !== undefined) {
      const steps = msg.steps || 20;
      await page.mouse.move(msg.startX, msg.startY);
      await page.mouse.down();
      for (let i = 1; i <= steps; i++) {
        const x = msg.startX + (msg.endX - msg.startX) * (i / steps);
        const y = msg.startY + (msg.endY - msg.startY) * (i / steps);
        await page.mouse.move(Math.round(x), Math.round(y));
        await new Promise((r) => setTimeout(r, 30));
      }
      await page.mouse.up();
    } else if (msg.action === 'type' && msg.text) {
      await page.keyboard.type(msg.text, { delay: 50 });
    } else if (msg.action === 'done') {
      endRemoteSession(captchaId, 'passed');
      return;
    } else if (msg.action === 'skip') {
      endRemoteSession(captchaId, 'skipped');
      return;
    }

    // 每次操作后发送新截图
    await sendScreenshot(captchaId, page);
  } catch (e) {
    console.error(`[captchaRelay] 远程交互执行失败:`, e);
  }
}

import { FastifyPluginAsync } from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { prisma } from '../server';
import {
  addClient,
  removeClient,
  getPendingTickets,
  resolveCaptchaTicket,
  resolveCaptchaWait,
  handleRemoteInput,
  startRemoteSession,
  hasRemoteSession,
  canStartAdminRemoteBrowser,
  refreshRemoteScreenshot,
  markCaptchaTicketProcessed,
  markAllCaptchaTicketsProcessed,
  cleanupAllRemoteSessions,
  listRemoteSessionSummary,
} from '../services/captchaRelay';
import { stopAllLivePreviewSessions, countLivePreviewSessions } from '../services/livePreview';
import { killOrphanPlaywrightChromium } from '../services/playwrightCleanup';
import { runManualCrawlForFeed } from '../workers/crawlerWorker';
import {
  launchChromium,
  createStealthContext,
  applySupplementaryPatches,
  getLivePreviewLaunchOptions,
} from '../services/browser';

async function requireAdmin(req: any, res: any): Promise<boolean> {
  const authHeader = req.headers.authorization as string | undefined;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).send({ error: '需要提供 Authorization: Bearer <登录令牌>' });
    return false;
  }
  try {
    const decoded: any = await req.jwtVerify();
    const userId = decoded.userId as number | undefined;
    if (userId == null) {
      res.status(403).send({ error: '无效令牌' });
      return false;
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { is_admin: true },
    });
    if (!user?.is_admin) {
      res.status(403).send({ error: '需要管理员账号' });
      return false;
    }
    return true;
  } catch {
    res.status(401).send({ error: '无效或已过期的登录令牌，请重新登录' });
    return false;
  }
}

const captchaRelayRoutes: FastifyPluginAsync = async (fastify) => {
  const wss = new WebSocketServer({ noServer: true });

  // 处理 Content-Type: application/json 但 body 为空的情况（如 mark-processed 等无 body 的 POST 请求）
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      const str = typeof body === 'string' ? body : body.toString('utf-8');
      const trimmed = str.trim();
      if (!trimmed) {
        done(null, {});
      } else {
        done(null, JSON.parse(trimmed));
      }
    } catch (err) {
      done(err as Error);
    }
  });

  fastify.server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url || '', 'http://localhost');
      if (url.pathname !== '/api/captcha-relay/ws') return;

      const token = url.searchParams.get('token');
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const decoded = fastify.jwt.verify(token) as { userId: number } | null;
      if (!decoded?.userId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        prisma.user.findUnique({
          where: { id: decoded.userId },
          select: { is_admin: true },
        }).then((user: { is_admin: boolean } | null) => {
          if (!user?.is_admin) {
            ws.close(4003, 'Not admin');
            return;
          }
          wss.emit('connection', ws, request);
        }).catch(() => {
          ws.close(4003, 'Auth error');
        });
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    addClient(ws);

    ws.on('close', () => {
      removeClient(ws);
    });

    ws.on('error', () => {
      removeClient(ws);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'remote_input' && msg.payload?.captchaId) {
          handleRemoteInput(msg.payload.captchaId, msg.payload);
        }
      } catch {}
    });
  });

  fastify.get('/tickets', async (req, res) => {
    return { tickets: getPendingTickets() };
  });

  fastify.post('/tickets/:captchaId/submit-cookie', async (req: any, res: any) => {
    const { captchaId } = req.params as { captchaId: string };
    const { cookie } = (req.body || {}) as { cookie?: string };

    if (!cookie?.trim()) {
      return res.status(400).send({ error: 'cookie 不能为空' });
    }

    const ticket = resolveCaptchaTicket(captchaId, 'cookie');
    if (!ticket) {
      return res.status(404).send({ error: 'ticket 不存在或已处理' });
    }

    await prisma.feed.update({
      where: { id: ticket.feedId },
      data: { auth_cookie: cookie.trim(), updated_at: new Date() },
    });

    // Cookie 保存后立即触发一次爬取
    try {
      const result = await runManualCrawlForFeed(ticket.feedId);
      console.log(`[captcha-relay] Feed ${ticket.feedId} cookie 已保存，自动触发爬取: ${result.mode} - ${result.message}`);
    } catch (e: any) {
      console.error(`[captcha-relay] Feed ${ticket.feedId} 自动爬取失败:`, e?.message || e);
    }

    return { ok: true, reCrawled: true } as any;
  });

  // 远程打码：管理员输入文本验证码答案
  fastify.post('/tickets/:captchaId/solve', async (req: any, res: any) => {
    const { captchaId } = req.params as { captchaId: string };
    const { answer } = (req.body || {}) as { answer?: string };

    if (!answer?.trim()) {
      return res.status(400).send({ error: '验证码答案不能为空' });
    }

    const ok = resolveCaptchaWait(captchaId, answer.trim());
    if (!ok) {
      return res.status(404).send({ error: 'ticket 不存在、已超时或已处理' });
    }

    console.log(`[captcha-relay] 验证码 ${captchaId} 已输入答案: "${answer.trim()}"`);
    return { ok: true };
  });

  // 远程交互：启动浏览器并开始远程交互会话
  fastify.post('/tickets/:captchaId/start-remote', async (req: any, res: any) => {
    const { captchaId } = req.params as { captchaId: string };

    const ticket = getPendingTickets().find((t) => t.captchaId === captchaId);
    if (!ticket) {
      return res.status(404).send({ error: 'ticket 不存在或已处理' });
    }

    // 已有活跃会话（爬虫等待或管理员已开）：复用，只刷新截图，避免叠开 Chromium
    if (hasRemoteSession(captchaId)) {
      await refreshRemoteScreenshot(captchaId);
      return { ok: true, reused: true, url: ticket.pageUrl || ticket.targetUrl } as any;
    }

    if (!canStartAdminRemoteBrowser()) {
      return res.status(429).send({
        error: '远程浏览器实例过多，请先关闭已有远程窗口后再试',
      });
    }

    let browser: any;
    try {
      const feed = await prisma.feed.findUnique({
        where: { id: ticket.feedId },
        select: { url: true, auth_cookie: true },
      });
      const url = feed?.url || ticket.targetUrl;
      if (!url) return res.status(400).send({ error: '无可用的目标 URL' });

      browser = await launchChromium(getLivePreviewLaunchOptions());
      const context = await createStealthContext(browser, {
        authCookie: feed?.auth_cookie || undefined,
      });
      const page = await context.newPage();
      await applySupplementaryPatches(page);

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      }).catch((e: any) => console.error(`[captcha-relay] goto ${url} 失败:`, e?.message));

      // 缩短启动等待：不再强制 networkidle（很多站点永不 idle）
      await page.waitForTimeout(800);
      await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});

      console.log(`[captcha-relay] 远程交互: ${url} 已加载，ticket=${captchaId}，等待管理员操作...`);
      // browser 由 session finalize 关闭，勿在 then 再 close（避免与 finalize 竞态）
      // 完成验证时会自动导出 Cookie 写回 feed.auth_cookie
      void startRemoteSession(captchaId, page, 180000, {
        browser,
        ownedBy: 'admin',
        feedId: ticket.feedId,
      }).then((result) => {
        console.log(`[captcha-relay] 远程会话 ${captchaId} 结束: ${result}`);
      });

      return { ok: true, reused: false, url } as any;
    } catch (e: any) {
      console.error('[captcha-relay] 启动远程会话失败:', e?.message);
      if (browser) browser.close().catch(() => {});
      return res.status(500).send({ error: e?.message || '启动失败' });
    }
  });

  fastify.post('/tickets/:captchaId/retry', async (req: any, res: any) => {
    const { captchaId } = req.params as { captchaId: string };

    const ticket = resolveCaptchaTicket(captchaId, 'retry');
    if (!ticket) {
      return res.status(404).send({ error: 'ticket 不存在或已处理' });
    }

    // 缩短冷却并立即触发爬取
    const now = new Date();
    await prisma.feedCrawlerStrategy.upsert({
      where: { feed_id: ticket.feedId },
      create: {
        feed_id: ticket.feedId,
        strategy_mode: 'cooldown',
        recommended_interval: 900,
        cooldown_until: new Date(now.getTime() + 900 * 1000),
      },
      update: {
        recommended_interval: 900,
        cooldown_until: new Date(now.getTime() + 900 * 1000),
        updated_at: now,
      },
    });

    try {
      const result = await runManualCrawlForFeed(ticket.feedId);
      console.log(`[captcha-relay] Feed ${ticket.feedId} 冷却已缩短，自动触发爬取: ${result.mode} - ${result.message}`);
    } catch (e: any) {
      console.error(`[captcha-relay] Feed ${ticket.feedId} 自动爬取失败:`, e?.message || e);
    }

    return { ok: true, reCrawled: true } as any;
  });

  fastify.post('/tickets/:captchaId/dismiss', async (req: any, res: any) => {
    try {
      const { captchaId } = req.params as { captchaId: string };

      const ticket = markCaptchaTicketProcessed(captchaId);
      if (!ticket) {
        return res.status(404).send({ error: 'ticket 不存在或已处理' });
      }

      return { ok: true };
    } catch (e: any) {
      console.error('[captcha-relay] dismiss 失败:', e?.message || e);
      return res.status(500).send({ error: e?.message || '操作失败' });
    }
  });

  fastify.post('/tickets/:captchaId/mark-processed', async (req: any, res: any) => {
    try {
      const { captchaId } = req.params as { captchaId: string };

      const ticket = markCaptchaTicketProcessed(captchaId);
      if (!ticket) {
        return res.status(404).send({ error: 'ticket 不存在或已处理' });
      }

      console.log(`[captcha-relay] 验证码 ${captchaId} 已手动标记为已处理`);
      return { ok: true };
    } catch (e: any) {
      console.error('[captcha-relay] mark-processed 失败:', e?.message || e);
      return res.status(500).send({ error: e?.message || '标记失败' });
    }
  });

  fastify.post('/tickets/mark-all-processed', async (_req: any, res: any) => {
    try {
      const count = markAllCaptchaTicketsProcessed();
      console.log(`[captcha-relay] 已批量标记 ${count} 条验证码为已处理`);
      return { ok: true, count };
    } catch (e: any) {
      console.error('[captcha-relay] mark-all-processed 失败:', e?.message || e);
      return res.status(500).send({ error: e?.message || '批量标记失败' });
    }
  });

  /**
   * 一键清理：结束远程交互/实时预览会话，并杀掉残留 Playwright Chromium。
   * 仅匹配 ms-playwright 路径，不会误杀日常 Chrome。
   */
  fastify.post('/cleanup-browsers', async (req: any, res: any) => {
    if (!(await requireAdmin(req, res))) return;

    try {
      const beforeRemote = listRemoteSessionSummary();
      const beforeLive = countLivePreviewSessions();
      const remote = await cleanupAllRemoteSessions();
      const live = await stopAllLivePreviewSessions();
      const killed = await killOrphanPlaywrightChromium();

      console.log(
        `[captcha-relay] cleanup-browsers remote=${remote.closedSessions} live=${live.closedSessions} chromium=${killed.killed}`
      );

      return {
        ok: true,
        remoteSessionsClosed: remote.closedSessions,
        liveSessionsClosed: live.closedSessions,
        chromiumKilled: killed.killed,
        chromiumPids: killed.pids,
        before: {
          remoteSessions: beforeRemote,
          liveSessions: beforeLive,
        },
        errors: killed.errors,
      };
    } catch (e: any) {
      console.error('[captcha-relay] cleanup-browsers 失败:', e?.message || e);
      return res.status(500).send({ error: e?.message || '清理失败' });
    }
  });

  fastify.post('/tickets/:captchaId/disable', async (req: any, res: any) => {
    const { captchaId } = req.params as { captchaId: string };

    const ticket = resolveCaptchaTicket(captchaId, 'disabled');
    if (!ticket) {
      return res.status(404).send({ error: 'ticket 不存在或已处理' });
    }

    await prisma.$transaction([
      prisma.feedCrawlerStrategy.upsert({
        where: { feed_id: ticket.feedId },
        create: {
          feed_id: ticket.feedId,
          strategy_mode: 'disabled',
        },
        update: {
          strategy_mode: 'disabled',
          updated_at: new Date(),
        },
      }),
      prisma.feed.update({
        where: { id: ticket.feedId },
        data: { is_active: false },
      }),
    ]);

    return { ok: true };
  });
};

export { captchaRelayRoutes };

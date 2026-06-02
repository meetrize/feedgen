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
} from '../services/captchaRelay';
import { runManualCrawlForFeed } from '../workers/crawlerWorker';
import {
  launchChromium,
  createStealthContext,
  applySupplementaryPatches,
  getDefaultLaunchArgs,
} from '../services/browser';

const captchaRelayRoutes: FastifyPluginAsync = async (fastify) => {
  const wss = new WebSocketServer({ noServer: true });

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

    let browser: any;
    try {
      const feed = await prisma.feed.findUnique({
        where: { id: ticket.feedId },
        select: { url: true, auth_cookie: true },
      });
      const url = feed?.url || ticket.targetUrl;
      if (!url) return res.status(400).send({ error: '无可用的目标 URL' });

      // 启动新浏览器并导航
      browser = await launchChromium({ args: getDefaultLaunchArgs() });
      const context = await createStealthContext(browser, {
        authCookie: feed?.auth_cookie || undefined,
      });
      const page = await context.newPage();
      await applySupplementaryPatches(page);

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      }).catch((e: any) => console.error(`[captcha-relay] goto ${url} 失败:`, e?.message));

      await page.waitForTimeout(2500);
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

      // 启动远程会话（首次截图在内部同步完成）
      console.log(`[captcha-relay] 远程交互: ${url} 已加载，ticket=${captchaId}，等待管理员操作...`);
      startRemoteSession(captchaId, page, 180000).then((result) => {
        console.log(`[captcha-relay] 远程会话 ${captchaId} 结束: ${result}`);
        browser.close().catch(() => {});
      });

      return { ok: true, url } as any;
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
    const { captchaId } = req.params as { captchaId: string };

    const ticket = resolveCaptchaTicket(captchaId, 'dismissed');
    if (!ticket) {
      return res.status(404).send({ error: 'ticket 不存在或已处理' });
    }

    return { ok: true };
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

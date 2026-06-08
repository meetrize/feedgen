import { FastifyPluginAsync } from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import {
  startLivePreviewSession,
  stopLivePreviewSession,
  attachLivePreviewClient,
  detachLivePreviewClient,
  handleLivePreviewInput,
  snapshotLivePreviewSession,
  getLivePreviewSession,
} from '../services/livePreview';

async function requireUserId(req: any, res: any): Promise<number | null> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).send({ error: 'Authentication required' });
      return null;
    }
    const decoded: any = await req.jwtVerify();
    if (!decoded?.userId) {
      res.status(401).send({ error: 'Authentication required' });
      return null;
    }
    return decoded.userId as number;
  } catch {
    res.status(401).send({ error: 'Invalid or expired token' });
    return null;
  }
}

const livePreviewRoutes: FastifyPluginAsync = async (fastify) => {
  const wss = new WebSocketServer({ noServer: true });

  fastify.server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url || '', 'http://localhost');
      if (url.pathname !== '/api/page-renderer/live/ws') return;

      const token = url.searchParams.get('token');
      const sessionId = url.searchParams.get('sessionId');
      if (!token || !sessionId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      let decoded: { userId: number };
      try {
        decoded = fastify.jwt.verify(token) as { userId: number };
      } catch {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      if (!decoded?.userId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        const attached = attachLivePreviewClient(sessionId, ws, decoded.userId);
        if (!attached) {
          ws.close(4004, 'Invalid session');
          return;
        }
        wss.emit('connection', ws, request, sessionId);
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket, _request: unknown, sessionId: string) => {
    ws.on('close', () => {
      detachLivePreviewClient(sessionId, ws);
    });
    ws.on('error', () => {
      detachLivePreviewClient(sessionId, ws);
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'live_input' && msg.payload?.sessionId) {
          void handleLivePreviewInput(msg.payload.sessionId, msg.payload);
        }
      } catch {}
    });
  });

  fastify.post('/start', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (userId == null) return;

    const { url, authCookie, useProxy, pageLanguage } = req.body as {
      url?: string;
      authCookie?: string;
      useProxy?: boolean;
      pageLanguage?: string;
    };
    if (!url) {
      return res.status(400).send({ error: 'URL is required' });
    }
    try {
      new URL(url);
    } catch {
      return res.status(400).send({ error: 'Invalid URL format' });
    }

    const sessionId = randomUUID();

    try {
      const startParams: {
        sessionId: string;
        userId: number;
        url: string;
        authCookie?: string;
        useProxy?: boolean;
        pageLanguage?: string;
      } = { sessionId, userId, url };
      if (authCookie?.trim()) startParams.authCookie = authCookie.trim();
      if (useProxy !== undefined) startParams.useProxy = useProxy;
      if (pageLanguage?.trim()) startParams.pageLanguage = pageLanguage.trim();

      const session = await startLivePreviewSession(startParams);
      return {
        sessionId,
        url,
        useProxy: session.useProxy,
        viewport: { width: 1440, height: 900 },
      };
    } catch (e: any) {
      req.log.error(e);
      return res.status(500).send({ error: e?.message || '启动实时预览失败' });
    }
  });

  fastify.post('/:sessionId/snapshot', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (userId == null) return;

    const { sessionId } = req.params as { sessionId: string };
    const session = getLivePreviewSession(sessionId);
    if (!session || session.userId !== userId) {
      return res.status(404).send({ error: '实时预览会话不存在或已过期' });
    }

    try {
      const snapshot = await snapshotLivePreviewSession(sessionId);
      if (!snapshot) {
        return res.status(404).send({ error: '无法获取页面快照' });
      }
      return snapshot;
    } catch (e: any) {
      req.log.error(e);
      return res.status(500).send({ error: e?.message || '获取快照失败' });
    }
  });

  fastify.post('/:sessionId/stop', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (userId == null) return;

    const { sessionId } = req.params as { sessionId: string };
    const session = getLivePreviewSession(sessionId);
    if (!session || session.userId !== userId) {
      return res.status(404).send({ error: '实时预览会话不存在或已过期' });
    }
    await stopLivePreviewSession(sessionId);
    return { ok: true };
  });
};

export { livePreviewRoutes };

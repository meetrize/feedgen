import { FastifyPluginAsync } from 'fastify';

import { listArticlesByInstrument } from '../services/finance/articlesByInstrument';
import {
  batchGetQuotes,
  parseCompactItems,
  parseQuoteItems,
} from '../services/finance/meostockQuoteService';

async function requireUserId(req: any, res: any): Promise<number | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).send({ error: 'Authentication required' });
    return null;
  }
  try {
    const decoded: any = await req.jwtVerify();
    if (!decoded?.userId) {
      res.status(401).send({ error: 'Invalid token payload' });
      return null;
    }
    return decoded.userId as number;
  } catch {
    res.status(401).send({ error: 'Invalid or expired token' });
    return null;
  }
}

/** JWT 用户或机机服务令牌（meostock 反代） */
async function requireUserOrService(req: any, res: any): Promise<'user' | 'service' | null> {
  const serviceToken = String(process.env.FEEDGEN_SERVICE_TOKEN || '').trim();
  const authHeader = String(req.headers.authorization || '');
  const internal = String(req.headers['x-service-token'] || req.headers['x-internal-token'] || '').trim();

  if (serviceToken) {
    if (internal && internal === serviceToken) return 'service';
    if (authHeader.startsWith('Bearer ')) {
      const bearer = authHeader.slice(7).trim();
      if (bearer && bearer === serviceToken) return 'service';
    }
  }

  const userId = await requireUserId(req, res);
  return userId ? 'user' : null;
}

const financePublicRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * 批量涨跌幅：不进入文章列表主路径。
   * GET  ?items=cn:sh600519,us:AAPL
   * POST { items: [{ market, symbol, chart_symbol? }] }
   */
  fastify.get('/quotes', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    try {
      const q = req.query as { items?: string };
      const items = parseCompactItems(String(q.items || ''));
      if (!items.length) {
        return { ok: true, quotes: [] };
      }
      const quotes = await batchGetQuotes(items);
      return { ok: true, quotes };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '获取行情失败' });
    }
  });

  fastify.post('/quotes', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    try {
      const body = (req.body || {}) as { items?: unknown };
      const items = parseQuoteItems(body.items);
      if (!items.length) {
        return { ok: true, quotes: [] };
      }
      const quotes = await batchGetQuotes(items);
      return { ok: true, quotes };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '获取行情失败' });
    }
  });

  /**
   * 按金融产品筛文章时间线（供 meostock 资讯页）。
   * GET /api/finance/articles-by-instrument?chart_symbol=sh600519&limit=20&cursor=&from=&to=
   * 鉴权：用户 JWT 或 FEEDGEN_SERVICE_TOKEN（Authorization Bearer / X-Service-Token）
   */
  fastify.get('/articles-by-instrument', async (req: any, res: any) => {
    const auth = await requireUserOrService(req, res);
    if (!auth) return;

    try {
      const q = req.query as {
        chart_symbol?: string;
        market?: string;
        symbol?: string;
        cursor?: string;
        limit?: string;
        from?: string;
        to?: string;
      };
      const chart_symbol = String(q.chart_symbol || '').trim();
      const market = String(q.market || '').trim();
      const symbol = String(q.symbol || '').trim();
      if (!chart_symbol && !(market && symbol)) {
        return res.status(400).send({ error: '需要 chart_symbol 或 market+symbol' });
      }

      const result = await listArticlesByInstrument({
        chart_symbol,
        market,
        symbol,
        ...(q.cursor ? { cursor: String(q.cursor) } : {}),
        limit: q.limit ? Number(q.limit) : 20,
        ...(q.from ? { from: String(q.from) } : {}),
        ...(q.to ? { to: String(q.to) } : {}),
      });
      return result;
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '获取资讯失败' });
    }
  });
};

export { financePublicRoutes };

import { FastifyPluginAsync } from 'fastify';

import { prisma } from '../server';
import {
  getFinanceOverview,
  listSyncJobs,
  runFinanceDictSync,
} from '../services/finance/financeDictSyncService';
import * as instrumentService from '../services/finance/financeInstrumentService';
import {
  backfillFinanceMatch,
  reloadFinanceMatchIndex,
  removeArticleInstrument,
} from '../services/finance/financeMatchService';
import { enqueueFinanceDictSync } from '../services/finance/financeSyncQueue';
import { getFinanceSettings, updateFinanceSettings } from '../services/finance/financeSettings';

async function verifyAdmin(req: any, res: any) {
  const authHeader = req.headers.authorization as string | undefined;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).send({ error: '需要提供 Authorization: Bearer <登录令牌>' });
  }
  try {
    const decoded: any = await req.jwtVerify();
    const userId = decoded.userId as number | undefined;
    if (userId == null) return res.status(403).send({ error: '无效令牌' });
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { is_admin: true },
    });
    if (!user?.is_admin) return res.status(403).send({ error: '需要管理员账号' });
    req.adminUserId = userId;
  } catch {
    return res.status(401).send({ error: '无效或已过期的登录令牌，请重新登录' });
  }
}

function handleError(error: unknown, req: any, res: any, fallback: string) {
  if (error instanceof Error) {
    const message = error.message;
    if (
      message.includes('必填') ||
      message.includes('不能为空') ||
      message.includes('已被其他产品占用') ||
      message.includes('日期')
    ) {
      return res.status(400).send({ error: message });
    }
    if (message.includes('不存在')) {
      return res.status(404).send({ error: message });
    }
    if ((error as { code?: string }).code === 'P2002') {
      return res.status(409).send({ error: '记录已存在（唯一约束冲突）' });
    }
  }
  req.log.error(error);
  return res.status(500).send({ error: fallback });
}

const financeAdminRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', verifyAdmin);

  fastify.get('/overview', async (req: any, res: any) => {
    try {
      return await getFinanceOverview();
    } catch (error) {
      return handleError(error, req, res, '获取概览失败');
    }
  });

  fastify.get('/instruments', async (req: any, res: any) => {
    try {
      const q = req.query as Record<string, string>;
      return await instrumentService.listInstruments({
        ...(q.q ? { q: q.q } : {}),
        ...(q.market ? { market: q.market } : {}),
        ...(q.asset_type ? { asset_type: q.asset_type } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.limit ? { limit: Number(q.limit) } : {}),
        ...(q.offset ? { offset: Number(q.offset) } : {}),
      });
    } catch (error) {
      return handleError(error, req, res, '获取产品列表失败');
    }
  });

  fastify.post('/instruments', async (req: any, res: any) => {
    try {
      const instrument = await instrumentService.createInstrument(req.body || {});
      return { instrument };
    } catch (error) {
      return handleError(error, req, res, '创建产品失败');
    }
  });

  fastify.patch('/instruments/:id', async (req: any, res: any) => {
    try {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).send({ error: 'id 无效' });
      const instrument = await instrumentService.updateInstrument(id, req.body || {});
      return { instrument };
    } catch (error) {
      return handleError(error, req, res, '更新产品失败');
    }
  });

  fastify.get('/instruments/:id/aliases', async (req: any, res: any) => {
    try {
      const id = Number((req.params as { id: string }).id);
      const aliases = await instrumentService.listAliases(id);
      return { aliases };
    } catch (error) {
      return handleError(error, req, res, '获取别名失败');
    }
  });

  fastify.post('/instruments/:id/aliases', async (req: any, res: any) => {
    try {
      const id = Number((req.params as { id: string }).id);
      const alias = await instrumentService.createAlias(id, req.body || {});
      return { alias };
    } catch (error) {
      return handleError(error, req, res, '创建别名失败');
    }
  });

  fastify.patch('/instruments/:id/aliases/:aliasId', async (req: any, res: any) => {
    try {
      const id = Number((req.params as { id: string }).id);
      const aliasId = Number((req.params as { aliasId: string }).aliasId);
      const alias = await instrumentService.updateAlias(id, aliasId, req.body || {});
      return { alias };
    } catch (error) {
      return handleError(error, req, res, '更新别名失败');
    }
  });

  fastify.delete('/instruments/:id/aliases/:aliasId', async (req: any, res: any) => {
    try {
      const id = Number((req.params as { id: string }).id);
      const aliasId = Number((req.params as { aliasId: string }).aliasId);
      await instrumentService.deleteAlias(id, aliasId);
      return { ok: true };
    } catch (error) {
      return handleError(error, req, res, '删除别名失败');
    }
  });

  fastify.post('/sync', async (req: any, res: any) => {
    try {
      const body = (req.body || {}) as {
        mode?: 'full' | 'incremental';
        async?: boolean;
        include_funds?: boolean;
        include_yfinance?: boolean;
        rematch_days?: number;
      };
      const mode = body.mode === 'incremental' ? 'incremental' : 'full';

      if (body.async === false) {
        const result = await runFinanceDictSync({
          mode,
          trigger: 'manual',
          includeFunds: body.include_funds !== false,
          includeYfinance: body.include_yfinance !== false,
        });
        return { ok: true, sync: result };
      }

      await enqueueFinanceDictSync({
        mode,
        trigger: 'manual',
        includeFunds: body.include_funds !== false,
        includeYfinance: body.include_yfinance !== false,
        rematchDays: body.rematch_days ?? 7,
      });
      return { ok: true, queued: true };
    } catch (error) {
      return handleError(error, req, res, '触发同步失败');
    }
  });

  fastify.get('/sync/jobs', async (req: any, res: any) => {
    try {
      const limit = Number((req.query as { limit?: string }).limit) || 20;
      const jobs = await listSyncJobs(limit);
      return { jobs };
    } catch (error) {
      return handleError(error, req, res, '获取同步任务失败');
    }
  });

  fastify.post('/match/backfill', async (req: any, res: any) => {
    try {
      const body = (req.body || {}) as { since?: string; until?: string; limit?: number };
      let since: Date | undefined;
      let until: Date | undefined;
      if (body.since) {
        since = new Date(body.since);
        if (Number.isNaN(since.getTime())) throw new Error('since 日期格式无效');
      }
      if (body.until) {
        until = new Date(body.until);
        if (Number.isNaN(until.getTime())) throw new Error('until 日期格式无效');
      }
      const result = await backfillFinanceMatch({
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
        ...(body.limit != null ? { limit: body.limit } : {}),
      });
      return { ok: true, ...result };
    } catch (error) {
      return handleError(error, req, res, '回填匹配失败');
    }
  });

  fastify.post('/match/reload-index', async (req: any, res: any) => {
    try {
      const result = await reloadFinanceMatchIndex();
      return { ok: true, ...result };
    } catch (error) {
      return handleError(error, req, res, '重载索引失败');
    }
  });

  fastify.delete('/articles/:articleId/instruments/:instrumentId', async (req: any, res: any) => {
    try {
      const articleId = Number((req.params as { articleId: string }).articleId);
      const instrumentId = Number((req.params as { instrumentId: string }).instrumentId);
      const disableKeyword = (req.body as { disable_alias?: string } | undefined)?.disable_alias;
      await removeArticleInstrument(articleId, instrumentId, disableKeyword);
      return { ok: true };
    } catch (error) {
      return handleError(error, req, res, '移除关联失败');
    }
  });

  fastify.get('/settings', async (req: any, res: any) => {
    try {
      const settings = await getFinanceSettings();
      return {
        settings,
        env: {
          FINANCE_MATCH_ENABLED: process.env.FINANCE_MATCH_ENABLED !== '0',
          FINANCE_DICT_SYNC_ENABLED: process.env.FINANCE_DICT_SYNC_ENABLED !== '0',
          FINANCE_DICT_SYNC_INTERVAL_MS:
            Number(process.env.FINANCE_DICT_SYNC_INTERVAL_MS) || 86400000,
        },
      };
    } catch (error) {
      return handleError(error, req, res, '获取设置失败');
    }
  });

  fastify.put('/settings', async (req: any, res: any) => {
    try {
      const settings = await updateFinanceSettings(req.body || {});
      return { settings };
    } catch (error) {
      return handleError(error, req, res, '保存设置失败');
    }
  });
};

export { financeAdminRoutes };

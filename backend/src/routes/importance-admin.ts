import { FastifyPluginAsync } from 'fastify';

import { prisma } from '../server';
import { runImportanceFastBackfill } from '../services/importance/backfillService';
import { isImportanceEnabled } from '../services/importance/importanceConfig';
import { enqueueImportanceBatch } from '../services/importance/importanceQueue';
import {
  resolveImportanceBackfillIds,
  scoreArticleImportance,
} from '../services/importance/scoringService';

type FastBackfillStatus = {
  running: boolean;
  started_at: string | null;
  finished_at: string | null;
  processed: number;
  succeeded: number;
  failed: number;
  batch: number;
  error: string | null;
  skip_cluster: boolean;
};

let fastBackfillStatus: FastBackfillStatus = {
  running: false,
  started_at: null,
  finished_at: null,
  processed: 0,
  succeeded: 0,
  failed: 0,
  batch: 0,
  error: null,
  skip_cluster: true,
};

async function verifyAdmin(req: any, res: any) {
  const authHeader = req.headers.authorization as string | undefined;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).send({ error: '需要提供 Authorization: Bearer <登录令牌>' });
  }

  try {
    const decoded: any = await req.jwtVerify();
    const userId = decoded.userId as number | undefined;
    if (userId == null) {
      return res.status(403).send({ error: '无效令牌' });
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { is_admin: true },
    });
    if (!user?.is_admin) {
      return res.status(403).send({ error: '需要管理员账号' });
    }
    req.adminUserId = userId;
  } catch {
    return res.status(401).send({ error: '无效或已过期的登录令牌，请重新登录' });
  }
}

function handleServiceError(error: unknown, req: any, res: any, fallback: string) {
  if (error instanceof Error) {
    const message = error.message;
    if (
      message.includes('文章不存在') ||
      message.includes('标题为空') ||
      message.includes('已关闭')
    ) {
      const status = message.includes('已关闭') ? 503 : 404;
      return res.status(status).send({ error: message });
    }
  }
  req.log.error(error);
  return res.status(500).send({ error: fallback });
}

const importanceAdminRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', verifyAdmin);

  /** 单篇重算 */
  fastify.post('/score', async (req: any, res: any) => {
    try {
      if (!isImportanceEnabled()) {
        return res.status(503).send({ error: '重要度功能已关闭（IMPORTANCE_ENABLED=0）' });
      }
      const body = req.body as { article_id?: number };
      const articleId = Number(body?.article_id);
      if (!Number.isInteger(articleId) || articleId <= 0) {
        return res.status(400).send({ error: 'article_id 必须为有效正整数' });
      }
      const result = await scoreArticleImportance(articleId);
      return { importance: result };
    } catch (error) {
      return handleServiceError(error, req, res, '文章重要度评分失败');
    }
  });

  /** 查看单篇 factors */
  fastify.get('/articles/:articleId', async (req: any, res: any) => {
    try {
      const articleId = Number(req.params.articleId);
      if (!Number.isInteger(articleId) || articleId <= 0) {
        return res.status(400).send({ error: 'articleId 无效' });
      }
      const row = await prisma.articleImportance.findUnique({
        where: { article_id: articleId },
      });
      if (!row) {
        return res.status(404).send({ error: '尚未评分' });
      }
      return {
        importance: {
          article_id: row.article_id,
          stars: row.stars,
          score: row.score,
          factors: row.factors,
          model_version: row.model_version,
          scored_at: row.scored_at,
        },
      };
    } catch (error) {
      return handleServiceError(error, req, res, '获取重要度失败');
    }
  });

  /** 批量回填入队（队列模式；默认跳过聚类） */
  fastify.post('/backfill', async (req: any, res: any) => {
    try {
      if (!isImportanceEnabled()) {
        return res.status(503).send({ error: '重要度功能已关闭（IMPORTANCE_ENABLED=0）' });
      }

      const body = req.body as {
        article_ids?: number[];
        feed_id?: number;
        since?: string;
        only_unscored?: boolean;
        limit?: number;
        skip_cluster?: boolean;
      };

      const backfillInput: {
        article_ids?: number[];
        feed_id?: number;
        since?: string;
        only_unscored?: boolean;
        limit?: number;
      } = {};
      if (body?.article_ids?.length) backfillInput.article_ids = body.article_ids;
      if (body?.feed_id != null) backfillInput.feed_id = Number(body.feed_id);
      if (body?.since?.trim()) backfillInput.since = body.since.trim();
      if (body?.only_unscored !== undefined) backfillInput.only_unscored = !!body.only_unscored;
      if (body?.limit !== undefined) backfillInput.limit = Number(body.limit);

      const ids = await resolveImportanceBackfillIds(backfillInput);

      if (!ids.length) {
        return res.status(400).send({ error: '没有符合条件的文章' });
      }

      const skipCluster = body?.skip_cluster !== false;
      const { enqueued } = await enqueueImportanceBatch(ids, { skipCluster });
      return res.status(201).send({ total: ids.length, enqueued, skip_cluster: skipCluster });
    } catch (error) {
      return handleServiceError(error, req, res, '重要度回填入队失败');
    }
  });

  /**
   * 高速进程内回填：默认跳过聚类、高并发扫完全部未打分文章。
   * 异步执行，用 GET /backfill/fast/status 查看进度。
   */
  fastify.post('/backfill/fast', async (req: any, res: any) => {
    try {
      if (!isImportanceEnabled()) {
        return res.status(503).send({ error: '重要度功能已关闭（IMPORTANCE_ENABLED=0）' });
      }
      if (fastBackfillStatus.running) {
        return res.status(409).send({ error: '已有快速回填任务在运行', status: fastBackfillStatus });
      }

      const body = req.body as {
        feed_id?: number;
        since?: string;
        only_unscored?: boolean;
        concurrency?: number;
        batch_size?: number;
        max_total?: number;
        skip_cluster?: boolean;
      };

      const skipCluster = body?.skip_cluster !== false;
      fastBackfillStatus = {
        running: true,
        started_at: new Date().toISOString(),
        finished_at: null,
        processed: 0,
        succeeded: 0,
        failed: 0,
        batch: 0,
        error: null,
        skip_cluster: skipCluster,
      };

      const fastOpts: Parameters<typeof runImportanceFastBackfill>[0] = {
        only_unscored: body?.only_unscored !== false,
        skip_cluster: skipCluster,
        onProgress: (p) => {
          fastBackfillStatus.processed = p.processed;
          fastBackfillStatus.succeeded = p.succeeded;
          fastBackfillStatus.failed = p.failed;
          fastBackfillStatus.batch = p.batch;
        },
      };
      if (body?.feed_id != null && Number.isFinite(Number(body.feed_id))) {
        fastOpts.feed_id = Number(body.feed_id);
      }
      if (body?.since?.trim()) fastOpts.since = body.since.trim();
      if (body?.concurrency != null) fastOpts.concurrency = Number(body.concurrency);
      if (body?.batch_size != null) fastOpts.batch_size = Number(body.batch_size);
      if (body?.max_total != null) fastOpts.max_total = Number(body.max_total);

      void runImportanceFastBackfill(fastOpts)
        .then((result) => {
          fastBackfillStatus.running = false;
          fastBackfillStatus.finished_at = new Date().toISOString();
          fastBackfillStatus.processed = result.processed;
          fastBackfillStatus.succeeded = result.succeeded;
          fastBackfillStatus.failed = result.failed;
          fastBackfillStatus.skip_cluster = result.skip_cluster;
        })
        .catch((error) => {
          fastBackfillStatus.running = false;
          fastBackfillStatus.finished_at = new Date().toISOString();
          fastBackfillStatus.error =
            error instanceof Error ? error.message : String(error);
        });

      return res.status(202).send({
        accepted: true,
        message: '快速回填已启动（默认跳过跨源聚类）',
        status: fastBackfillStatus,
      });
    } catch (error) {
      return handleServiceError(error, req, res, '启动快速回填失败');
    }
  });

  fastify.get('/backfill/fast/status', async (_req: any, _res: any) => {
    const [totalArticles, scored] = await Promise.all([
      prisma.article.count(),
      prisma.articleImportance.count(),
    ]);
    return {
      status: fastBackfillStatus,
      coverage: {
        articles: totalArticles,
        scored,
        unscored: Math.max(0, totalArticles - scored),
      },
    };
  });

  /** 信源权重列表 */
  fastify.get('/source-weights', async (_req: any, res: any) => {
    try {
      const rows = await prisma.importanceSourceWeight.findMany({
        orderBy: [{ weight: 'desc' }, { id: 'asc' }],
      });
      return { items: rows };
    } catch (error) {
      return handleServiceError(error, _req, res, '获取信源权重失败');
    }
  });

  /** 新增/更新信源权重 */
  fastify.post('/source-weights', async (req: any, res: any) => {
    try {
      const body = req.body as {
        host?: string;
        feed_id?: number;
        weight?: number;
        note?: string;
      };
      const weight = Number(body?.weight);
      if (!Number.isFinite(weight) || weight < 0 || weight > 100) {
        return res.status(400).send({ error: 'weight 须为 0–100' });
      }
      const host = body?.host?.trim().toLowerCase() || null;
      const feedId =
        body?.feed_id != null && Number.isInteger(Number(body.feed_id))
          ? Number(body.feed_id)
          : null;
      if (!host && feedId == null) {
        return res.status(400).send({ error: '须提供 host 或 feed_id' });
      }

      let row;
      if (feedId != null) {
        row = await prisma.importanceSourceWeight.upsert({
          where: { feed_id: feedId },
          create: {
            feed_id: feedId,
            host: null,
            weight,
            note: body?.note?.trim() || null,
          },
          update: {
            weight,
            note: body?.note?.trim() || null,
            updated_at: new Date(),
          },
        });
      } else {
        row = await prisma.importanceSourceWeight.upsert({
          where: { host: host! },
          create: {
            host: host!,
            feed_id: null,
            weight,
            note: body?.note?.trim() || null,
          },
          update: {
            weight,
            note: body?.note?.trim() || null,
            updated_at: new Date(),
          },
        });
      }
      return { item: row };
    } catch (error) {
      return handleServiceError(error, req, res, '保存信源权重失败');
    }
  });
};

export { importanceAdminRoutes };

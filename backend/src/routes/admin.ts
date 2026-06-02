import { FastifyPluginAsync } from 'fastify';
import * as bcrypt from 'bcrypt';
import { prisma } from '../server';
import { getCrawlerQueueSnapshot, runManualCrawlForFeed } from '../workers/crawlerWorker';

/** 管理接口：仅接受有效用户 JWT，且数据库 users.is_admin = true */
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

function parsePagination(query: Record<string, unknown>) {
  const limitRaw = Number(query.limit);
  const offsetRaw = Number(query.offset);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
  return { limit, offset };
}

const adminRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', verifyAdmin);

  async function ensureLegacyUserPlanForMembershipConfig(planId: number) {
    const config = await prisma.membership_plan_configs.findUnique({ where: { id: planId } });
    if (!config) return null;

    return prisma.user_plans.upsert({
      where: { id: config.id },
      create: {
        id: config.id,
        name: config.name,
        description: config.description,
        max_feeds: config.max_feeds,
        duration_days: config.history_days || 365,
        updated_at: new Date(),
      },
      update: {
        name: config.name,
        description: config.description,
        max_feeds: config.max_feeds,
        duration_days: config.history_days || 365,
        updated_at: new Date(),
      },
    });
  }

  // 全量 Feeds（含所属用户摘要）
  fastify.get('/feeds', async (req: any, res: any) => {
    try {
      const { limit, offset } = parsePagination(req.query as Record<string, unknown>);
      const [total, feeds] = await Promise.all([
        prisma.feed.count(),
        prisma.feed.findMany({
          skip: offset,
          take: limit,
          orderBy: { id: 'desc' },
          include: {
            users: {
              select: { id: true, username: true, email: true, is_anonymous: true },
            },
          },
        }),
      ]);
      return { total, limit, offset, feeds };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '获取 Feeds 列表失败' });
    }
  });

  // 单条 Feed（编辑用）
  fastify.get('/feeds/:id', async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id)) {
        return res.status(400).send({ error: '无效的 Feed ID' });
      }
      const feed = await prisma.feed.findUnique({
        where: { id },
        include: {
          users: { select: { id: true, username: true, email: true, is_anonymous: true } },
        },
      });
      if (!feed) {
        return res.status(404).send({ error: 'Feed 不存在' });
      }
      return { feed };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '获取 Feed 失败' });
    }
  });

  // 手动触发一次爬取（与调度器相同策略：native / visual / 队列入队）
  fastify.post('/feeds/:id/crawl', async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id)) {
        return res.status(400).send({ error: '无效的 Feed ID' });
      }
      const result = await runManualCrawlForFeed(id);
      return { ok: true, ...result };
    } catch (error: any) {
      req.log.error(error);
      const msg = error?.message || '手动爬取失败';
      return res.status(400).send({ error: msg });
    }
  });

  fastify.put('/feeds/:id', async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id)) {
        return res.status(400).send({ error: '无效的 Feed ID' });
      }
      const body = req.body as Record<string, unknown>;
      const existing = await prisma.feed.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).send({ error: 'Feed 不存在' });
      }

      const data: Record<string, unknown> = { updated_at: new Date() };
      if (typeof body.title === 'string') data.title = body.title.slice(0, 255);
      if (body.description !== undefined) data.description = body.description === null ? null : String(body.description);
      if (body.url !== undefined) {
        const u = body.url === null || body.url === '' ? null : String(body.url).slice(0, 500);
        data.url = u;
      }
      if (typeof body.feed_type === 'string') data.feed_type = body.feed_type.slice(0, 50);
      if (typeof body.is_active === 'boolean') data.is_active = body.is_active;
      if (body.user_id === null) {
        data.user_id = null;
      } else if (body.user_id !== undefined) {
        const uid = parseInt(String(body.user_id), 10);
        if (!Number.isNaN(uid)) {
          const u = await prisma.user.findUnique({ where: { id: uid } });
          if (!u) {
            return res.status(400).send({ error: '指定的用户不存在' });
          }
          data.user_id = uid;
        }
      }
      if (body.update_interval !== undefined) {
        const n = parseInt(String(body.update_interval), 10);
        if (!Number.isNaN(n)) data.update_interval = n;
      }
      if (body.selector_rules !== undefined) {
        if (body.selector_rules === null) {
          data.selector_rules = null;
        } else if (typeof body.selector_rules === 'object' && body.selector_rules !== null) {
          data.selector_rules = body.selector_rules;
        } else if (typeof body.selector_rules === 'string') {
          const s = String(body.selector_rules).trim();
          data.selector_rules = s === '' ? null : JSON.parse(s);
        }
      }

      const feed = await prisma.feed.update({
        where: { id },
        data: data as any,
        include: {
          users: { select: { id: true, username: true, email: true, is_anonymous: true } },
        },
      });
      return { feed };
    } catch (error: any) {
      req.log.error(error);
      if (error instanceof SyntaxError) {
        return res.status(400).send({ error: 'selector_rules 不是合法 JSON' });
      }
      return res.status(500).send({ error: '更新 Feed 失败' });
    }
  });

  fastify.delete('/feeds/:id', async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id)) {
        return res.status(400).send({ error: '无效的 Feed ID' });
      }
      const existing = await prisma.feed.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).send({ error: 'Feed 不存在' });
      }
      await prisma.feed.delete({ where: { id } });
      return { ok: true };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '删除 Feed 失败' });
    }
  });

  // 全量文章（列表不含正文，避免单次响应过大）
  fastify.get('/articles', async (req: any, res: any) => {
    try {
      const { limit, offset } = parsePagination(req.query as Record<string, unknown>);
      const feedIdRaw = (req.query as { feed_id?: string }).feed_id;
      const feedId =
        feedIdRaw !== undefined && feedIdRaw !== '' ? parseInt(String(feedIdRaw), 10) : undefined;
      const where =
        feedId !== undefined && !Number.isNaN(feedId) ? { feed_id: feedId } : {};

      const [total, articles] = await Promise.all([
        prisma.article.count({ where }),
        prisma.article.findMany({
          where,
          skip: offset,
          take: limit,
          orderBy: { id: 'desc' },
          select: {
            id: true,
            feed_id: true,
            title: true,
            description: true,
            url: true,
            pub_date: true,
            created_at: true,
            updated_at: true,
            author: true,
            thumbnail_url: true,
            feeds: { select: { id: true, title: true, user_id: true } },
          },
        }),
      ]);
      return { total, limit, offset, articles };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '获取文章列表失败' });
    }
  });

  // 批量删除文章
  fastify.post('/articles/batch-delete', async (req: any, res: any) => {
    try {
      const { ids } = req.body as { ids?: unknown };
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).send({ error: '请提供非空 ids 数组' });
      }
      const intIds = [...new Set(ids.map((x) => parseInt(String(x), 10)).filter((n) => !Number.isNaN(n)))];
      if (intIds.length === 0) {
        return res.status(400).send({ error: 'ids 中无有效整数' });
      }
      if (intIds.length > 500) {
        return res.status(400).send({ error: '单次最多删除 500 条' });
      }
      const result = await prisma.article.deleteMany({ where: { id: { in: intIds } } });
      return { deleted: result.count };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '批量删除文章失败' });
    }
  });

  // 单篇文章详情（含正文）
  fastify.get('/articles/:id', async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id)) {
        return res.status(400).send({ error: '无效的文章 ID' });
      }
      const article = await prisma.article.findUnique({
        where: { id },
        include: {
          feeds: { select: { id: true, title: true, user_id: true, url: true } },
        },
      });
      if (!article) {
        return res.status(404).send({ error: '文章不存在' });
      }
      return { article };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '获取文章详情失败' });
    }
  });

  fastify.delete('/articles/:id', async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id)) {
        return res.status(400).send({ error: '无效的文章 ID' });
      }
      const existing = await prisma.article.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).send({ error: '文章不存在' });
      }
      await prisma.article.delete({ where: { id } });
      return { ok: true };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '删除文章失败' });
    }
  });

  // 全量用户（不含密码哈希）
  fastify.get('/users', async (req: any, res: any) => {
    try {
      const { limit, offset } = parsePagination(req.query as Record<string, unknown>);
      const [total, users, plans] = await Promise.all([
        prisma.user.count(),
        prisma.user.findMany({
          skip: offset,
          take: limit,
          orderBy: { id: 'desc' },
          select: {
            id: true,
            username: true,
            email: true,
            current_plan_id: true,
            plan_start_date: true,
            plan_end_date: true,
            feed_count_used: true,
            created_at: true,
            updated_at: true,
            is_anonymous: true,
            is_admin: true,
          },
        }),
        prisma.membership_plan_configs.findMany({
          select: { id: true, name: true, max_feeds: true },
          orderBy: { sort_order: 'asc' },
        }),
      ]);
      const planMap = new Map<number, { id: number; name: string; max_feeds: number }>(
        plans.map((p: { id: number; name: string; max_feeds: number }) => [p.id, p])
      );
      return {
        total,
        limit,
        offset,
        users: users.map((u: {
          id: number;
          username: string;
          email: string;
          current_plan_id: number | null;
          plan_start_date: Date | null;
          plan_end_date: Date | null;
          feed_count_used: number | null;
          created_at: Date | null;
          updated_at: Date | null;
          is_anonymous: boolean;
          is_admin: boolean;
        }) => ({
          ...u,
          membership_plan: u.current_plan_id != null ? planMap.get(u.current_plan_id) || null : null,
        })),
      };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '获取用户列表失败' });
    }
  });

  fastify.get('/users/:id', async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id)) {
        return res.status(400).send({ error: '无效的用户 ID' });
      }
      const [user, plans] = await Promise.all([
        prisma.user.findUnique({
          where: { id },
          select: {
            id: true,
            username: true,
            email: true,
            current_plan_id: true,
            plan_start_date: true,
            plan_end_date: true,
            feed_count_used: true,
            created_at: true,
            updated_at: true,
            is_anonymous: true,
            is_admin: true,
          },
        }),
        prisma.membership_plan_configs.findMany({
          select: { id: true, name: true, max_feeds: true },
          orderBy: { sort_order: 'asc' },
        }),
      ]);
      if (!user) {
        return res.status(404).send({ error: '用户不存在' });
      }
      const planMap = new Map<number, { id: number; name: string; max_feeds: number }>(
        plans.map((p: { id: number; name: string; max_feeds: number }) => [p.id, p])
      );
      return { user: { ...user, membership_plan: user.current_plan_id != null ? planMap.get(user.current_plan_id) || null : null } };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '获取用户失败' });
    }
  });

  fastify.put('/users/:id', async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id)) {
        return res.status(400).send({ error: '无效的用户 ID' });
      }
      const adminSelf = req.adminUserId as number;
      const body = req.body as Record<string, unknown>;
      const existing = await prisma.user.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).send({ error: '用户不存在' });
      }

      if (id === adminSelf && body.is_admin === false) {
        const otherAdmins = await prisma.user.count({
          where: { is_admin: true, id: { not: id } },
        });
        if (otherAdmins === 0) {
          return res.status(400).send({ error: '至少需保留另一名管理员后，才可取消自身管理员标记' });
        }
      }

      const data: Record<string, unknown> = { updated_at: new Date() };
      if (typeof body.username === 'string') {
        data.username = body.username.trim().slice(0, 100);
      }
      if (typeof body.email === 'string') {
        data.email = body.email.trim().slice(0, 255);
      }
      if (typeof body.is_admin === 'boolean') data.is_admin = body.is_admin;
      if (typeof body.is_anonymous === 'boolean') data.is_anonymous = body.is_anonymous;
      if (body.feed_count_used !== undefined) {
        const n = parseInt(String(body.feed_count_used), 10);
        if (!Number.isNaN(n)) data.feed_count_used = n;
      }
      if (body.current_plan_id === null || body.current_plan_id === '') {
        data.current_plan_id = null;
      } else if (body.current_plan_id !== undefined) {
        const pid = parseInt(String(body.current_plan_id), 10);
        if (!Number.isNaN(pid)) {
          const plan = await ensureLegacyUserPlanForMembershipConfig(pid);
          if (!plan) {
            return res.status(400).send({ error: '套餐不存在' });
          }
          data.current_plan_id = pid;
        }
      }
      if (body.plan_start_date === null || body.plan_start_date === '') {
        data.plan_start_date = null;
      } else if (typeof body.plan_start_date === 'string') {
        data.plan_start_date = new Date(body.plan_start_date);
      }
      if (body.plan_end_date === null || body.plan_end_date === '') {
        data.plan_end_date = null;
      } else if (typeof body.plan_end_date === 'string') {
        data.plan_end_date = new Date(body.plan_end_date);
      }

      if (typeof body.password === 'string' && body.password.length > 0) {
        data.password_hash = await bcrypt.hash(body.password, 10);
      }

      const planRows = await prisma.membership_plan_configs.findMany({
        select: { id: true, name: true, max_feeds: true },
        orderBy: { sort_order: 'asc' },
      });
      const planMap = new Map<number, { id: number; name: string; max_feeds: number }>(
        planRows.map((p: { id: number; name: string; max_feeds: number }) => [p.id, p])
      );
      const user = await prisma.user.update({
        where: { id },
        data: data as any,
        select: {
          id: true,
          username: true,
          email: true,
          current_plan_id: true,
          plan_start_date: true,
          plan_end_date: true,
          feed_count_used: true,
          created_at: true,
          updated_at: true,
          is_anonymous: true,
          is_admin: true,
        },
      });
      return { user: { ...user, membership_plan: user.current_plan_id != null ? planMap.get(user.current_plan_id) || null : null } };
    } catch (error: any) {
      req.log.error(error);
      if (error?.code === 'P2002') {
        return res.status(400).send({ error: '用户名或邮箱已被占用' });
      }
      return res.status(500).send({ error: '更新用户失败' });
    }
  });

  fastify.delete('/users/:id', async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id)) {
        return res.status(400).send({ error: '无效的用户 ID' });
      }
      const adminSelf = req.adminUserId as number;
      if (id === adminSelf) {
        return res.status(400).send({ error: '不能删除当前登录账号' });
      }
      const target = await prisma.user.findUnique({
        where: { id },
        select: { is_admin: true },
      });
      if (!target) {
        return res.status(404).send({ error: '用户不存在' });
      }
      if (target.is_admin) {
        const adminCount = await prisma.user.count({ where: { is_admin: true } });
        if (adminCount <= 1) {
          return res.status(400).send({ error: '不能删除最后一个管理员' });
        }
      }
      await prisma.user.delete({ where: { id } });
      return { ok: true };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '删除用户失败' });
    }
  });

  // 爬虫任务管理（队列任务 + Feed 调度状态 + 数据库中的执行历史）
  fastify.get('/crawl-tasks', async (req: any, res: any) => {
    try {
      const limitRaw = Number((req.query as any)?.limit);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 300) : 100;
      const historyLimitRaw = Number((req.query as any)?.historyLimit);
      const historyOffsetRaw = Number((req.query as any)?.historyOffset);
      const historyLimit = Number.isFinite(historyLimitRaw) ? Math.min(Math.max(historyLimitRaw, 1), 200) : 50;
      const historyOffset = Number.isFinite(historyOffsetRaw) ? Math.max(historyOffsetRaw, 0) : 0;

      const feedsQuery = prisma.feed.findMany({
        where: { is_active: true },
        select: {
          id: true,
          title: true,
          url: true,
          source_type: true,
          selector_rules: true,
          update_interval: true,
          last_fetched_at: true,
          created_at: true,
          updated_at: true,
          user_id: true,
          users: {
            select: { id: true, username: true, is_anonymous: true },
          },
        },
        orderBy: { id: 'asc' },
        take: 500,
      });

      // 与 feed 查询并行，避免 Redis 慢时拖住整段串行时间（快照侧已自带超时）
      const [queue, feeds] = await Promise.all([
        getCrawlerQueueSnapshot(limit).catch((queueErr: any) => {
          req.log.error(queueErr);
          return {
            redisAvailable: false,
            error: queueErr?.message || '读取 Bull 队列快照失败',
            counts: {
              waiting: 0,
              active: 0,
              completed: 0,
              failed: 0,
              delayed: 0,
              paused: 0,
            },
            jobs: [],
          };
        }),
        feedsQuery,
      ]);

      const now = Date.now();
      const schedules = feeds.map((feed: any) => {
        const lastFetchedAt = feed.last_fetched_at ? new Date(feed.last_fetched_at) : null;
        const intervalSec = feed.update_interval || 1800;
        const nextRunAt = new Date((lastFetchedAt ? lastFetchedAt.getTime() : 0) + intervalSec * 1000);
        const overdueMs = now - nextRunAt.getTime();
        const isOverdue = overdueMs >= 0;
        let mode = 'queue';
        if (feed.source_type === 'native') mode = 'native';
        else if (feed.selector_rules && typeof feed.selector_rules === 'object' && (feed.selector_rules as any).listSelector) mode = 'visual';

        return {
          feedId: feed.id,
          feedTitle: feed.title,
          feedUrl: feed.url,
          mode,
          intervalSec,
          lastFetchedAt,
          nextRunAt,
          isOverdue,
          overdueSec: isOverdue ? Math.floor(overdueMs / 1000) : 0,
          user: feed.users
            ? { id: feed.users.id, username: feed.users.username, is_anonymous: feed.users.is_anonymous }
            : null,
          source_type: feed.source_type,
          selector_rules: feed.selector_rules,
          created_at: feed.created_at,
          updated_at: feed.updated_at,
        };
      });

      let history: {
        total: number;
        limit: number;
        offset: number;
        items: Array<Record<string, unknown>>;
        warning?: string;
      };
      try {
        const [historyTotal, historyRows] = await Promise.all([
          prisma.crawlerTaskHistory.count(),
          prisma.crawlerTaskHistory.findMany({
            skip: historyOffset,
            take: historyLimit,
            orderBy: { started_at: 'desc' },
            include: {
              feed: { select: { id: true, title: true, url: true, source_type: true } },
            },
          }),
        ]);

        history = {
          total: historyTotal,
          limit: historyLimit,
          offset: historyOffset,
          items: historyRows.map((h: any) => ({
            id: h.id,
            feed_id: h.feed_id,
            feed_title: h.feed?.title ?? '',
            feed_url: h.feed?.url ?? null,
            source_type: h.feed?.source_type ?? null,
            mode: h.mode,
            status: h.status,
            started_at: h.started_at,
            finished_at: h.finished_at,
            duration_ms: h.duration_ms,
            new_articles_count: h.new_articles_count,
            error_message: h.error_message,
          })),
        };
      } catch (histErr: any) {
        req.log.error(histErr);
        history = {
          total: 0,
          limit: historyLimit,
          offset: historyOffset,
          items: [],
          warning:
            '爬虫历史查询失败（请确认已执行迁移且 prisma generate）。' +
            (histErr?.message ? ` 详情: ${String(histErr.message).slice(0, 200)}` : ''),
        };
      }

      return {
        queue,
        schedules,
        history,
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '获取爬虫任务信息失败' });
    }
  });
};

export { adminRoutes };

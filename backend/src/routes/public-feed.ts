import { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../server';
import {
  cancelPublicSubscription,
  createPublicSubscription,
  formatPublicFeedSummary,
  getOptionalUserId,
  getUserContributions,
} from '../services/publicFeedService';

function parsePagination(query: Record<string, unknown>) {
  const pageRaw = Number(query.page ?? 1);
  const limitRaw = Number(query.limit ?? 24);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 100) : 24;
  return { page, limit, skip: (page - 1) * limit };
}

const publicFeedRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (req: any, res: any) => {
    try {
      const query = req.query as Record<string, string>;
      const { page, limit, skip } = parsePagination(query);
      const userId = await getOptionalUserId(req);

      const where: Prisma.PublicFeedWhereInput = {
        status: 'approved',
      };

      const q = String(query.q || '').trim();
      if (q) {
        where.OR = [
          { title: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
          { url: { contains: q, mode: 'insensitive' } },
          { url_normalized: { contains: q, mode: 'insensitive' } },
        ];
      }

      if (query.source_type === 'native' || query.source_type === 'parsed') {
        where.source_type = query.source_type;
      }

      if (query.verified === 'true') {
        where.verified = true;
      }

      if (query.tag) {
        where.tags = { array_contains: [query.tag] };
      }

      const sortKey = String(query.sort || 'subscriber_count');
      const orderBy: Prisma.PublicFeedOrderByWithRelationInput[] = [];
      if (sortKey === 'last_fetched_at') {
        orderBy.push({ last_fetched_at: 'desc' });
      } else if (sortKey === 'created_at') {
        orderBy.push({ created_at: 'desc' });
      } else if (sortKey === 'title') {
        orderBy.push({ title: 'asc' });
      } else {
        orderBy.push({ subscriber_count: 'desc' });
      }
      if (sortKey !== 'title') {
        orderBy.push({ verified: 'desc' });
      }

      const [items, total] = await Promise.all([
        prisma.publicFeed.findMany({
          where,
          orderBy,
          skip,
          take: limit,
          include: {
            contributor: { select: { id: true, username: true } },
          },
        }),
        prisma.publicFeed.count({ where }),
      ]);

      let subscribedSet = new Set<number>();
      if (userId) {
        const subs = await prisma.userFeedSubscription.findMany({
          where: { user_id: userId, is_active: true },
          select: { public_feed_id: true },
        });
        subscribedSet = new Set(subs.map((s: { public_feed_id: number }) => s.public_feed_id));
      }

      return {
        items: items.map((feed: any) =>
          formatPublicFeedSummary(feed, { already_subscribed: subscribedSet.has(feed.id) })
        ),
        total,
        page,
        limit,
      };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '获取公开源列表失败' });
    }
  });

  fastify.get('/contributors/rank', async (req: any, res: any) => {
    try {
      const period = String((req.query as { period?: string }).period || 'month');
      const since = new Date();
      if (period === 'month') {
        since.setDate(since.getDate() - 30);
      } else {
        since.setFullYear(since.getFullYear() - 1);
      }

      const rows = await prisma.publicFeed.groupBy({
        by: ['contributor_user_id'],
        where: {
          contributor_user_id: { not: null },
          created_at: { gte: since },
        },
        _sum: { subscriber_count: true },
        _count: { _all: true },
        orderBy: { _sum: { subscriber_count: 'desc' } },
        take: 10,
      });

      const userIds = rows
        .map((r: { contributor_user_id: number | null }) => r.contributor_user_id)
        .filter((id: number | null): id is number => id != null);
      const users = userIds.length
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true },
          })
        : [];
      const userMap = new Map(users.map((u: { id: number; username: string }) => [u.id, u]));

      return {
        period,
        items: rows.map((row: any, index: number) => ({
          rank: index + 1,
          contributor: row.contributor_user_id
            ? {
                id: row.contributor_user_id,
                username: (userMap.get(row.contributor_user_id) as { username?: string } | undefined)?.username || '',
              }
            : null,
          feed_count: row._count._all,
          total_subscribers: row._sum.subscriber_count || 0,
        })),
      };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '获取贡献排行榜失败' });
    }
  });

  fastify.get('/:id', async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).send({ error: 'id 无效' });
      }
      const userId = await getOptionalUserId(req);
      const feed = await prisma.publicFeed.findFirst({
        where: { id, status: 'approved' },
        include: { contributor: { select: { id: true, username: true } } },
      });
      if (!feed) {
        return res.status(404).send({ error: '公开源不存在' });
      }

      let alreadySubscribed = false;
      if (userId) {
        const sub = await prisma.userFeedSubscription.findFirst({
          where: { user_id: userId, public_feed_id: id, is_active: true },
        });
        alreadySubscribed = !!sub;
      }

      return {
        feed: formatPublicFeedSummary(feed, { already_subscribed: alreadySubscribed }),
      };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '获取公开源详情失败' });
    }
  });
};

const publicSubscriptionRoutes: FastifyPluginAsync = async (fastify) => {
  async function requireUserId(req: any, res: any): Promise<number | null> {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).send({ error: 'Authentication required' });
      return null;
    }
    try {
      const decoded: any = await req.jwtVerify();
      return decoded?.userId ?? null;
    } catch {
      res.status(401).send({ error: 'Invalid or expired token' });
      return null;
    }
  }

  fastify.get('/', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    try {
      const subs = await prisma.userFeedSubscription.findMany({
        where: { user_id: userId, is_active: true },
        orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
        include: {
          public_feed: { include: { contributor: { select: { id: true, username: true } } } },
          group: true,
        },
      });

      const publicFeedIds = subs.map((s: { public_feed_id: number }) => s.public_feed_id);
      let articleCountMap = new Map<number, number>();
      if (publicFeedIds.length) {
        const grouped = await prisma.article.groupBy({
          by: ['public_feed_id'],
          where: { public_feed_id: { in: publicFeedIds } },
          _count: { _all: true },
        });
        articleCountMap = new Map(
          grouped
            .filter((g: { public_feed_id: number | null }) => g.public_feed_id != null)
            .map((g: { public_feed_id: number | null; _count: { _all: number } }) => [g.public_feed_id as number, g._count._all])
        );
      }

      return {
        subscriptions: subs.map((sub: any) => ({
          id: sub.id,
          public_feed_id: sub.public_feed_id,
          group_id: sub.group_id,
          custom_title: sub.custom_title,
          sort_order: sub.sort_order,
          needs_translation: sub.needs_translation,
          is_active: sub.is_active,
          source: 'public',
          article_count: articleCountMap.get(sub.public_feed_id) || 0,
          public_feed: formatPublicFeedSummary(sub.public_feed),
          group: sub.group,
        })),
      };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '获取订阅列表失败' });
    }
  });

  fastify.post('/', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const body = req.body as {
      public_feed_id?: number;
      group_id?: number | null;
      custom_title?: string | null;
      needs_translation?: boolean;
    };

    const publicFeedId = Number(body.public_feed_id);
    if (!Number.isFinite(publicFeedId)) {
      return res.status(400).send({ error: 'public_feed_id 无效' });
    }

    try {
      const subscription = await createPublicSubscription({
        userId,
        public_feed_id: publicFeedId,
        ...(body.group_id !== undefined ? { group_id: body.group_id } : {}),
        ...(body.custom_title !== undefined ? { custom_title: body.custom_title } : {}),
        ...(body.needs_translation !== undefined ? { needs_translation: body.needs_translation } : {}),
      });
      return {
        subscription: {
          id: subscription.id,
          public_feed_id: subscription.public_feed_id,
          public_feed: formatPublicFeedSummary(subscription.public_feed),
        },
      };
    } catch (error: any) {
      req.log.error(error);
      if (error?.code === 'PUBLIC_SUB_LIMIT') {
        return res.status(400).send({ error: '公开源订阅数量已达上限' });
      }
      if (error?.code === 'ALREADY_SUBSCRIBED') {
        return res.status(409).send({ error: '已订阅该公开源' });
      }
      if (error?.code === 'NOT_FOUND') {
        return res.status(404).send({ error: error.message });
      }
      if (error?.code === 'GROUP_NOT_FOUND') {
        return res.status(404).send({ error: '分组不存在' });
      }
      return res.status(500).send({ error: '订阅失败' });
    }
  });

  fastify.delete('/:id', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const subscriptionId = Number(req.params.id);
    if (!Number.isFinite(subscriptionId)) {
      return res.status(400).send({ error: 'id 无效' });
    }

    try {
      await cancelPublicSubscription(userId, subscriptionId);
      return { ok: true };
    } catch (error: any) {
      req.log.error(error);
      if (error?.code === 'NOT_FOUND') {
        return res.status(404).send({ error: '订阅不存在' });
      }
      return res.status(500).send({ error: '取消订阅失败' });
    }
  });
};

const userContributionsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/me/contributions', async (req: any, res: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).send({ error: 'Authentication required' });
    }
    try {
      const decoded: any = await req.jwtVerify();
      const userId = decoded?.userId;
      if (!userId) {
        return res.status(401).send({ error: 'Invalid token payload' });
      }
      const contributions = await getUserContributions(userId);
      return contributions;
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '获取贡献统计失败' });
    }
  });
};

export { publicFeedRoutes, publicSubscriptionRoutes, userContributionsRoutes };

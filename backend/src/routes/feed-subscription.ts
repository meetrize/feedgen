import { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../server';

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

const ALLOWED_GROUP_ICONS = new Set([
  'folder',
  'folders',
  'star',
  'bookmark',
  'rss',
  'globe',
  'newspaper',
  'bell',
  'heart',
  'tag',
  'layers',
  'layout-grid',
  'book-open',
  'zap',
  'flame',
  'coffee',
  'code',
  'briefcase',
  'home',
  'inbox',
]);

function normalizeGroupIcon(icon: unknown): string | null {
  const raw = String(icon || '').trim().toLowerCase();
  if (!raw) return null;
  if (!/^[a-z0-9-]+$/.test(raw) || raw.length > 50) return null;
  return ALLOWED_GROUP_ICONS.has(raw) ? raw : 'folder';
}

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
    return decoded.userId;
  } catch {
    res.status(401).send({ error: 'Invalid or expired token' });
    return null;
  }
}

function getSubscriptionRouteError(error: any): { statusCode: number; message: string } {
  const message = String(error?.message || '');

  // Prisma Client 未更新时，delegate 可能为 undefined（例如 prisma.userFeedSubscription 不存在）
  if (
    message.includes('userFeedSubscription') ||
    message.includes('userFeedGroup') ||
    message.includes('user_article_reads') ||
    message.includes('user_article_likes') ||
    message.includes('is not a function') ||
    message.includes('Cannot read properties of undefined')
  ) {
    return {
      statusCode: 500,
      message: '订阅模块未完成初始化，请在 backend 执行 npm run db:migrate && npm run db:generate 后重启服务',
    };
  }

  // 新增表未迁移到数据库
  if (error?.code === 'P2021') {
    return {
      statusCode: 500,
      message: '数据库缺少订阅相关表，请在 backend 执行 npm run db:migrate 并重启服务',
    };
  }

  // 数据库触发器限制：用户可创建 Feed 数量达到上限（Postgres P0001）
  if (message.includes('用户Feed数量已达上限') || message.includes('code: "P0001"') || message.includes('code: \'P0001\'')) {
    return {
      statusCode: 400,
      message: '用户Feed数量已达上限，请先删除部分 Feed，或直接选择已有 Feed 进行订阅',
    };
  }

  return {
    statusCode: 500,
    message: 'Failed to create subscription',
  };
}

/** 从文章查询条件中提取 feed_id 列表（用于「喜欢」等需按关联表筛选的场景） */
function feedIdsFromArticleWhere(articleWhere: any): number[] {
  const fid = articleWhere?.feed_id;
  if (typeof fid === 'number' && Number.isFinite(fid)) return [fid];
  if (fid && typeof fid === 'object' && Array.isArray(fid.in)) {
    return (fid.in as unknown[]).map((id) => Number(id)).filter((id) => Number.isFinite(id));
  }
  return [];
}

async function resolveFeedIdsForArticleWhere(articleWhere: any, userId: number): Promise<number[]> {
  const directFeedIds = feedIdsFromArticleWhere(articleWhere);
  if (directFeedIds.length) return directFeedIds;

  const feedFilter = articleWhere?.feeds || {};
  const rows = await prisma.feed.findMany({
    where: {
      user_id: userId,
      ...(feedFilter.group_id !== undefined ? { group_id: feedFilter.group_id } : {}),
    },
    select: { id: true },
  });
  return rows.map((row: { id: number }) => Number(row.id)).filter((id: number) => Number.isFinite(id));
}

function getArticleSortTime(item: any): number {
  const createdTime = item?.created_at ? new Date(item.created_at).getTime() : NaN;
  if (Number.isFinite(createdTime)) return createdTime;
  const pubTime = item?.pub_date ? new Date(item.pub_date).getTime() : NaN;
  if (Number.isFinite(pubTime)) return pubTime;
  return 0;
}

function sortArticlesByCreatedTimeDesc<T extends { pub_date?: any; created_at?: any }>(articles: T[]): T[] {
  return [...articles].sort((a, b) => {
    const diff = getArticleSortTime(b) - getArticleSortTime(a);
    if (diff !== 0) return diff;
    const aPub = a?.pub_date ? new Date(a.pub_date).getTime() : 0;
    const bPub = b?.pub_date ? new Date(b.pub_date).getTime() : 0;
    return bPub - aPub;
  });
}

const feedSubscriptionRoutes: FastifyPluginAsync = async (fastify) => {
  // 按分组/Feed读取文章列表（数据来自 articles 表）
  fastify.get('/articles', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const query = req.query as {
      groupId?: string;
      feedId?: string;
      limit?: string;
      offset?: string;
      includeContent?: string;
      scope?: string;
      unread?: string;
      ungrouped?: string;
    };

    const ungroupedOnly = query.ungrouped === '1' || query.ungrouped === 'true';
    const groupId = query.groupId ? Number(query.groupId) : null;
    const feedId = query.feedId ? Number(query.feedId) : null;
    const limitRaw = query.limit ? Number(query.limit) : 100;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 300) : 100;
    const offsetRaw = query.offset ? Number(query.offset) : 0;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
    const includeContent = query.includeContent === '1' || query.includeContent === 'true';
    const scope = String(query.scope || 'all').trim().toLowerCase();
    const unreadOnly = query.unread === '1' || query.unread === 'true';
    const isTodayScope = scope === 'today';
    const isLikedScope = scope === 'liked';

    if (query.groupId && !ungroupedOnly && !Number.isFinite(groupId)) {
      return res.status(400).send({ error: 'groupId 无效' });
    }
    if (query.feedId && !Number.isFinite(feedId)) {
      return res.status(400).send({ error: 'feedId 无效' });
    }

    try {
      let articleWhere: any;
      if (feedId != null) {
        const feed = await prisma.feed.findFirst({
          where: {
            id: feedId,
            user_id: userId,
            ...(groupId != null ? { group_id: groupId } : ungroupedOnly ? { group_id: null } : {}),
          },
          select: { id: true },
        });
        if (!feed) return { articles: [], total: 0 };
        articleWhere = { feed_id: feed.id };
      } else {
        articleWhere = {
          feeds: {
            user_id: userId,
            ...(ungroupedOnly ? { group_id: null } : groupId != null ? { group_id: groupId } : {}),
          },
        };
      }

      if (isTodayScope) {
        const now = new Date();
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        articleWhere = {
          ...articleWhere,
          AND: [
            {
              OR: [
                { pub_date: { gte: start, lt: end } },
                { created_at: { gte: start, lt: end } },
              ],
            },
          ],
        };
      }

      const articleSelectBase: any = {
        id: true,
        feed_id: true,
        title: true,
        description: true,
        url: true,
        author: true,
        pub_date: true,
        created_at: true,
        feeds: { select: { title: true } },
      };
      if (includeContent) articleSelectBase.content = true;

      if (isLikedScope) {
        let scopedFeedIds = feedIdsFromArticleWhere(articleWhere);
        if (!scopedFeedIds.length) {
          const scopedFeeds = await prisma.feed.findMany({
            where: {
              user_id: userId,
              ...(ungroupedOnly ? { group_id: null } : groupId != null ? { group_id: groupId } : {}),
            },
            select: { id: true },
          });
          scopedFeedIds = scopedFeeds.map((feed: any) => Number(feed.id)).filter((id: number) => Number.isFinite(id));
        }
        if (!scopedFeedIds.length) return { articles: [], total: 0 };

        let todayFilterSql = Prisma.empty;
        if (isTodayScope) {
          const now = new Date();
          const start = new Date(now);
          start.setHours(0, 0, 0, 0);
          const end = new Date(start);
          end.setDate(end.getDate() + 1);
          todayFilterSql = Prisma.sql` AND ((a."pub_date" >= ${start} AND a."pub_date" < ${end}) OR (a."created_at" >= ${start} AND a."created_at" < ${end}))`;
        }

        const likedRows = (await prisma.$queryRaw(Prisma.sql`
          SELECT l."article_id" AS article_id
          FROM "user_article_likes" l
          INNER JOIN "articles" a ON a."id" = l."article_id"
          WHERE l."user_id" = ${userId}
            AND a."feed_id" IN (${Prisma.join(scopedFeedIds)})
            ${todayFilterSql}
          ORDER BY a."created_at" DESC NULLS LAST, a."pub_date" DESC NULLS LAST, l."liked_at" DESC NULLS LAST
          LIMIT ${limit} OFFSET ${offset}
        `)) as Array<{ article_id: number }>;

        const totalRows = (await prisma.$queryRaw(Prisma.sql`
          SELECT COUNT(*)::int AS c
          FROM "user_article_likes" l
          INNER JOIN "articles" a ON a."id" = l."article_id"
          WHERE l."user_id" = ${userId}
            AND a."feed_id" IN (${Prisma.join(scopedFeedIds)})
            ${todayFilterSql}
        `)) as Array<{ c: number }>;
        const totalCount = Number(totalRows[0]?.c || 0);

        const orderedIds = likedRows.map((r) => Number(r.article_id)).filter((id) => Number.isFinite(id));
        if (!orderedIds.length) return { articles: [], total: totalCount };

        const likedArticles = await prisma.article.findMany({ where: { id: { in: orderedIds } }, select: articleSelectBase });
        const byId = new Map(likedArticles.map((item: any) => [item.id, item]));
        const sortedArticles = sortArticlesByCreatedTimeDesc(orderedIds.map((id) => byId.get(id)).filter(Boolean) as any[]);
        const articleIds = sortedArticles.map((item: any) => item.id);

        let readIdSet = new Set<number>();
        if (articleIds.length) {
          const readRows = (await prisma.$queryRaw(Prisma.sql`SELECT "article_id" FROM "user_article_reads" WHERE "user_id" = ${userId} AND "article_id" IN (${Prisma.join(articleIds)})`)) as Array<{ article_id: number }>;
          readIdSet = new Set(readRows.map((row) => row.article_id));
        }

        const mappedArticles = sortedArticles.map((item: any) => ({
          id: item.id,
          feed_id: item.feed_id,
          title: item.title,
          description: item.description,
          ...(includeContent ? { content: item.content } : {}),
          url: item.url,
          author: item.author,
          pub_date: item.pub_date,
          created_at: item.created_at,
          feed_title: item.feeds?.title || '',
          is_read: readIdSet.has(item.id),
          is_liked: true,
        }));

        return { articles: mappedArticles, total: totalCount };
      }

      if (unreadOnly) {
        const scopedFeedIds = await resolveFeedIdsForArticleWhere(articleWhere, userId);
        if (!scopedFeedIds.length) return { articles: [], total: 0 };

        let todayFilterSql = Prisma.empty;
        if (isTodayScope) {
          const now = new Date();
          const start = new Date(now);
          start.setHours(0, 0, 0, 0);
          const end = new Date(start);
          end.setDate(end.getDate() + 1);
          todayFilterSql = Prisma.sql` AND ((a."pub_date" >= ${start} AND a."pub_date" < ${end}) OR (a."created_at" >= ${start} AND a."created_at" < ${end}))`;
        }

        const unreadRows = (await prisma.$queryRaw(Prisma.sql`
          SELECT a."id" AS article_id
          FROM "articles" a
          LEFT JOIN "user_article_reads" r ON r."article_id" = a."id" AND r."user_id" = ${userId}
          WHERE a."feed_id" IN (${Prisma.join(scopedFeedIds)})
            AND r."article_id" IS NULL
            ${todayFilterSql}
          ORDER BY a."created_at" DESC NULLS LAST, a."pub_date" DESC NULLS LAST
          LIMIT ${limit} OFFSET ${offset}
        `)) as Array<{ article_id: number }>;

        const totalRows = (await prisma.$queryRaw(Prisma.sql`
          SELECT COUNT(*)::int AS c
          FROM "articles" a
          LEFT JOIN "user_article_reads" r ON r."article_id" = a."id" AND r."user_id" = ${userId}
          WHERE a."feed_id" IN (${Prisma.join(scopedFeedIds)})
            AND r."article_id" IS NULL
            ${todayFilterSql}
        `)) as Array<{ c: number }>;
        const totalCount = Number(totalRows[0]?.c || 0);
        const orderedIds = unreadRows.map((r) => Number(r.article_id)).filter((id) => Number.isFinite(id));
        if (!orderedIds.length) return { articles: [], total: totalCount };

        const unreadArticles = await prisma.article.findMany({ where: { id: { in: orderedIds } }, select: articleSelectBase });
        const byId = new Map(unreadArticles.map((item: any) => [item.id, item]));
        const sortedArticles = sortArticlesByCreatedTimeDesc(orderedIds.map((id) => byId.get(id)).filter(Boolean) as any[]);
        const articleIds = sortedArticles.map((item: any) => item.id);

        let likedIdSet = new Set<number>();
        if (articleIds.length) {
          const likedRows = (await prisma.$queryRaw(Prisma.sql`SELECT "article_id" FROM "user_article_likes" WHERE "user_id" = ${userId} AND "article_id" IN (${Prisma.join(articleIds)})`)) as Array<{ article_id: number }>;
          likedIdSet = new Set(likedRows.map((row) => row.article_id));
        }

        const mappedArticles = sortedArticles.map((item: any) => ({
          id: item.id,
          feed_id: item.feed_id,
          title: item.title,
          description: item.description,
          ...(includeContent ? { content: item.content } : {}),
          url: item.url,
          author: item.author,
          pub_date: item.pub_date,
          created_at: item.created_at,
          feed_title: item.feeds?.title || '',
          is_read: false,
          is_liked: likedIdSet.has(item.id),
        }));

        return { articles: mappedArticles, total: totalCount };
      }

      const [listTotal, articles] = await Promise.all([
        prisma.article.count({ where: articleWhere }),
        prisma.article.findMany({
          where: articleWhere,
          select: articleSelectBase,
          orderBy: [{ created_at: 'desc' }, { pub_date: 'desc' }],
          skip: offset,
          take: limit,
        }),
      ]);

      const sortedArticles = sortArticlesByCreatedTimeDesc(articles as any[]);
      const articleIds = sortedArticles.map((item: any) => item.id);

      let readIdSet = new Set<number>();
      if (articleIds.length) {
        const readRows = (await prisma.$queryRaw(Prisma.sql`SELECT "article_id" FROM "user_article_reads" WHERE "user_id" = ${userId} AND "article_id" IN (${Prisma.join(articleIds)})`)) as Array<{ article_id: number }>;
        readIdSet = new Set(readRows.map((row) => row.article_id));
      }

      let likedIdSet = new Set<number>();
      if (articleIds.length) {
        const likedRows = (await prisma.$queryRaw(Prisma.sql`SELECT "article_id" FROM "user_article_likes" WHERE "user_id" = ${userId} AND "article_id" IN (${Prisma.join(articleIds)})`)) as Array<{ article_id: number }>;
        likedIdSet = new Set(likedRows.map((row) => row.article_id));
      }

      const mappedArticles = sortedArticles.map((item: any) => ({
        id: item.id,
        feed_id: item.feed_id,
        title: item.title,
        description: item.description,
        ...(includeContent ? { content: item.content } : {}),
        url: item.url,
        author: item.author,
        pub_date: item.pub_date,
        created_at: item.created_at,
        feed_title: item.feeds?.title || '',
        is_read: readIdSet.has(item.id),
        is_liked: likedIdSet.has(item.id),
      }));

      return { articles: mappedArticles, total: listTotal };
    } catch (error: any) {
      req.log.error(error);
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });
  // 文章统计（用于左侧菜单精确计数）
  fastify.get('/articles/stats', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    try {
      const feeds = await prisma.feed.findMany({
        where: { user_id: userId },
        select: { id: true },
      });
      const feedIds = feeds.map((item: any) => item.id).filter((id: any) => Number.isFinite(Number(id)));
      if (!feedIds.length) {
        return {
          total_count: 0,
          unread_count: 0,
          today_count: 0,
          liked_count: 0,
        };
      }

      const now = new Date();
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);

      const [totalCount, todayCount, readRows, likedRows] = await Promise.all([
        prisma.article.count({
          where: { feed_id: { in: feedIds } },
        }),
        prisma.article.count({
          where: {
            feed_id: { in: feedIds },
            OR: [
              { pub_date: { gte: start, lt: end } },
              { created_at: { gte: start, lt: end } },
            ],
          },
        }),
        prisma.$queryRaw(
          Prisma.sql`SELECT COUNT(DISTINCT r."article_id")::int AS count
                     FROM "user_article_reads" r
                     JOIN "articles" a ON a."id" = r."article_id"
                     WHERE r."user_id" = ${userId}
                       AND a."feed_id" IN (${Prisma.join(feedIds)})`
        ) as Promise<Array<{ count: number }>>,
        prisma.$queryRaw(
          Prisma.sql`SELECT COUNT(DISTINCT l."article_id")::int AS count
                     FROM "user_article_likes" l
                     JOIN "articles" a ON a."id" = l."article_id"
                     WHERE l."user_id" = ${userId}
                       AND a."feed_id" IN (${Prisma.join(feedIds)})`
        ) as Promise<Array<{ count: number }>>,
      ]);

      const readCount = Number(readRows?.[0]?.count || 0);
      const likedCount = Number(likedRows?.[0]?.count || 0);
      const unreadCount = Math.max(0, Number(totalCount || 0) - readCount);

      return {
        total_count: Number(totalCount || 0),
        unread_count: unreadCount,
        today_count: Number(todayCount || 0),
        liked_count: Math.max(0, likedCount),
      };
    } catch (error: any) {
      req.log.error(error);
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  // 获取单篇文章详情（按需返回 content，避免列表接口传大字段）
  fastify.get('/articles/:articleId', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const articleId = Number(req.params.articleId);
    if (!Number.isFinite(articleId)) {
      return res.status(400).send({ error: 'articleId 无效' });
    }

    try {
      const article = await prisma.article.findUnique({
        where: { id: articleId },
        select: {
          id: true,
          feed_id: true,
          title: true,
          description: true,
          content: true,
          url: true,
          author: true,
          pub_date: true,
          created_at: true,
          feeds: {
            select: {
              id: true,
              title: true,
              user_id: true,
            },
          },
        },
      });
      if (!article) {
        return res.status(404).send({ error: '文章不存在' });
      }
      if (!article.feeds || article.feeds.user_id !== userId) {
        return res.status(403).send({ error: '无权限查看该文章' });
      }

      const readRows = (await prisma.$queryRaw(
        Prisma.sql`SELECT 1 FROM "user_article_reads" WHERE "user_id" = ${userId} AND "article_id" = ${articleId} LIMIT 1`
      )) as Array<{ "?column?": number }>;
      const isRead = readRows.length > 0;
      const likeRows = (await prisma.$queryRaw(
        Prisma.sql`SELECT 1 FROM "user_article_likes" WHERE "user_id" = ${userId} AND "article_id" = ${articleId} LIMIT 1`
      )) as Array<{ "?column?": number }>;
      const isLiked = likeRows.length > 0;

      return {
        article: {
          id: article.id,
          feed_id: article.feed_id,
          title: article.title,
          description: article.description,
          content: article.content,
          url: article.url,
          author: article.author,
          pub_date: article.pub_date,
          created_at: article.created_at,
          feed_title: article.feeds.title || '',
          is_read: isRead,
          is_liked: isLiked,
        },
      };
    } catch (error: any) {
      req.log.error(error);
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  // 标记文章已读（点击文章卡片后调用）
  fastify.post('/articles/:articleId/read', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const articleId = Number(req.params.articleId);
    if (!Number.isFinite(articleId)) {
      return res.status(400).send({ error: 'articleId 无效' });
    }

    try {
      const article = await prisma.article.findUnique({
        where: { id: articleId },
        select: { id: true, feed_id: true },
      });
      if (!article) {
        return res.status(404).send({ error: '文章不存在' });
      }

      const feed = await prisma.feed.findFirst({
        where: { id: article.feed_id, user_id: userId },
        select: { id: true },
      });
      if (!feed) {
        return res.status(403).send({ error: '无权限标记该文章' });
      }

      await prisma.$executeRaw(
        Prisma.sql`INSERT INTO "user_article_reads" ("user_id", "article_id", "read_at")
                   VALUES (${userId}, ${articleId}, CURRENT_TIMESTAMP)
                   ON CONFLICT ("user_id", "article_id")
                   DO UPDATE SET "read_at" = EXCLUDED."read_at"`
      );

      return { success: true };
    } catch (error: any) {
      req.log.error(error);
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  // 取消文章已读（用于“标记为未读”）
  fastify.delete('/articles/:articleId/read', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const articleId = Number(req.params.articleId);
    if (!Number.isFinite(articleId)) {
      return res.status(400).send({ error: 'articleId 无效' });
    }

    try {
      const article = await prisma.article.findUnique({
        where: { id: articleId },
        select: { id: true, feed_id: true },
      });
      if (!article) {
        return res.status(404).send({ error: '文章不存在' });
      }

      const feed = await prisma.feed.findFirst({
        where: { id: article.feed_id, user_id: userId },
        select: { id: true },
      });
      if (!feed) {
        return res.status(403).send({ error: '无权限标记该文章' });
      }

      await prisma.$executeRaw(
        Prisma.sql`DELETE FROM "user_article_reads" WHERE "user_id" = ${userId} AND "article_id" = ${articleId}`
      );

      return { success: true };
    } catch (error: any) {
      req.log.error(error);
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  // 标记文章喜欢
  fastify.post('/articles/:articleId/like', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const articleId = Number(req.params.articleId);
    if (!Number.isFinite(articleId)) {
      return res.status(400).send({ error: 'articleId 无效' });
    }

    try {
      const article = await prisma.article.findUnique({
        where: { id: articleId },
        select: { id: true, feed_id: true },
      });
      if (!article) {
        return res.status(404).send({ error: '文章不存在' });
      }

      const feed = await prisma.feed.findFirst({
        where: { id: article.feed_id, user_id: userId },
        select: { id: true },
      });
      if (!feed) {
        return res.status(403).send({ error: '无权限操作该文章' });
      }

      await prisma.$executeRaw(
        Prisma.sql`INSERT INTO "user_article_likes" ("user_id", "article_id", "liked_at")
                   VALUES (${userId}, ${articleId}, CURRENT_TIMESTAMP)
                   ON CONFLICT ("user_id", "article_id")
                   DO UPDATE SET "liked_at" = EXCLUDED."liked_at"`
      );
      return { success: true };
    } catch (error: any) {
      req.log.error(error);
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  // 取消文章喜欢
  fastify.delete('/articles/:articleId/like', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const articleId = Number(req.params.articleId);
    if (!Number.isFinite(articleId)) {
      return res.status(400).send({ error: 'articleId 无效' });
    }

    try {
      const article = await prisma.article.findUnique({
        where: { id: articleId },
        select: { id: true, feed_id: true },
      });
      if (!article) {
        return res.status(404).send({ error: '文章不存在' });
      }

      const feed = await prisma.feed.findFirst({
        where: { id: article.feed_id, user_id: userId },
        select: { id: true },
      });
      if (!feed) {
        return res.status(403).send({ error: '无权限操作该文章' });
      }

      await prisma.$executeRaw(
        Prisma.sql`DELETE FROM "user_article_likes" WHERE "user_id" = ${userId} AND "article_id" = ${articleId}`
      );
      return { success: true };
    } catch (error: any) {
      req.log.error(error);
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  // 获取订阅列表与分组
  fastify.get('/', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    try {
      const [groups, feeds] = await Promise.all([
        prisma.userFeedGroup.findMany({
          where: { user_id: userId },
          orderBy: { created_at: 'asc' },
        }),
        prisma.feed.findMany({
          where: { user_id: userId },
          orderBy: { created_at: 'desc' },
        }),
      ]);
      const feedIds = feeds.map((item: any) => item.id).filter((id: any) => Number.isFinite(Number(id)));
      let feedArticleCountMap = new Map<number, number>();
      if (feedIds.length) {
        const grouped = await prisma.article.groupBy({
          by: ['feed_id'],
          where: { feed_id: { in: feedIds } },
          _count: { _all: true },
        });
        feedArticleCountMap = new Map<number, number>(
          grouped.map((item: any) => [item.feed_id, Number(item._count?._all || 0)])
        );
      }

      const feedsWithArticleCount = feeds.map((feed: any) => ({
        ...feed,
        article_count: feedArticleCountMap.get(feed.id) || 0,
      }));

      return { groups, feeds: feedsWithArticleCount };
    } catch (error) {
      req.log.error(error);
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  // 获取可选 feed（当前用户自己的 feed）
  fastify.get('/available-feeds', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    try {
      const feeds = await prisma.feed.findMany({
        where: { user_id: userId },
        orderBy: { updated_at: 'desc' },
        select: {
          id: true,
          title: true,
          url: true,
          is_active: true,
        },
      });
      return { feeds };
    } catch (error) {
      req.log.error(error);
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  // 新增分组
  fastify.post('/groups', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const { name, icon } = req.body as { name?: string; icon?: string };
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      return res.status(400).send({ error: '分组名称不能为空' });
    }
    if (cleanName.length > 100) {
      return res.status(400).send({ error: '分组名称不能超过 100 字符' });
    }
    const cleanIcon = normalizeGroupIcon(icon);

    try {
      const group = await prisma.userFeedGroup.create({
        data: {
          user_id: userId,
          name: cleanName,
          icon: cleanIcon,
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
      return { group };
    } catch (error: any) {
      req.log.error(error);
      if (error?.code === 'P2002') {
        return res.status(409).send({ error: '分组名称已存在' });
      }
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  // 重命名分组
  fastify.patch('/groups/:groupId', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const groupId = Number(req.params.groupId);
    if (!Number.isFinite(groupId)) {
      return res.status(400).send({ error: 'groupId 无效' });
    }

    const { name, icon } = req.body as { name?: string; icon?: string };
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      return res.status(400).send({ error: '分组名称不能为空' });
    }
    if (cleanName.length > 100) {
      return res.status(400).send({ error: '分组名称不能超过 100 字符' });
    }
    const cleanIcon = icon === undefined ? undefined : normalizeGroupIcon(icon);

    try {
      const existing = await prisma.userFeedGroup.findFirst({
        where: { id: groupId, user_id: userId },
        select: { id: true },
      });
      if (!existing) {
        return res.status(404).send({ error: '分组不存在' });
      }

      const group = await prisma.userFeedGroup.update({
        where: { id: groupId },
        data: {
          name: cleanName,
          ...(cleanIcon !== undefined ? { icon: cleanIcon } : {}),
          updated_at: new Date(),
        },
      });
      return { group };
    } catch (error: any) {
      req.log.error(error);
      if (error?.code === 'P2002') {
        return res.status(409).send({ error: '分组名称已存在' });
      }
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  // 删除分组（分组内 Feed 自动移动到未分组）
  fastify.delete('/groups/:groupId', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const groupId = Number(req.params.groupId);
    if (!Number.isFinite(groupId)) {
      return res.status(400).send({ error: 'groupId 无效' });
    }

    try {
      const existing = await prisma.userFeedGroup.findFirst({
        where: { id: groupId, user_id: userId },
        select: { id: true },
      });
      if (!existing) {
        return res.status(404).send({ error: '分组不存在' });
      }

      // 优先依赖数据库外键 onDelete: SetNull，直接删除分组。
      // 若线上历史库未应用该约束，再回退到“先迁移 feed 到未分组，再删分组”。
      try {
        await prisma.userFeedGroup.delete({
          where: { id: groupId },
        });
      } catch (deleteError: any) {
        const message = String(deleteError?.message || '');
        const isFkRestricted = deleteError?.code === 'P2003' || message.includes('Foreign key constraint');
        if (!isFkRestricted) {
          throw deleteError;
        }

        await prisma.$transaction([
          prisma.feed.updateMany({
            where: {
              user_id: userId,
              group_id: groupId,
            },
            data: {
              group_id: null,
              updated_at: new Date(),
            },
          }),
          prisma.userFeedGroup.delete({
            where: { id: groupId },
          }),
        ]);
      }

      return { success: true };
    } catch (error: any) {
      req.log.error(error);
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({
        error: mapped.message,
        details: String(error?.message || '').slice(0, 400),
      });
    }
  });

  // 新增订阅（可直接订阅已有 feed，也可先创建 feed 再订阅）
  fastify.post('/', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const { feedId, feedTitle, feedUrl, faviconUrl, groupId } = req.body as {
      feedId?: number;
      feedTitle?: string;
      feedUrl?: string;
      faviconUrl?: string;
      groupId?: number | null;
    };

    try {
      if (feedId != null) {
        const existingFeed = await prisma.feed.findFirst({
          where: { id: Number(feedId), user_id: userId },
          select: { id: true, group_id: true },
        });
        if (!existingFeed) {
          return res.status(404).send({ error: 'Feed 不存在' });
        }
        let normalizedGroupId: number | null = null;
        if (groupId != null) {
          const group = await prisma.userFeedGroup.findFirst({
            where: { id: Number(groupId), user_id: userId },
            select: { id: true },
          });
          if (!group) {
            return res.status(404).send({ error: '分组不存在' });
          }
          normalizedGroupId = group.id;
        }
        const updatedFeed = await prisma.feed.update({
          where: { id: existingFeed.id },
          data: {
            group_id: normalizedGroupId,
            updated_at: new Date(),
          },
        });
        return { feed: updatedFeed };
      } else {
        const title = String(feedTitle || '').trim();
        const url = String(feedUrl || '').trim();
        const cleanFaviconUrl = String(faviconUrl || '').trim();
        if (!title) {
          return res.status(400).send({ error: '请输入 Feed 标题' });
        }
        if (!url || !isValidUrl(url)) {
          return res.status(400).send({ error: '请输入合法的 Feed URL' });
        }
        if (cleanFaviconUrl && !isValidUrl(cleanFaviconUrl)) {
          return res.status(400).send({ error: '请输入合法的 Favicon URL' });
        }

        let normalizedGroupId: number | null = null;
        if (groupId != null) {
          const group = await prisma.userFeedGroup.findFirst({
            where: { id: Number(groupId), user_id: userId },
            select: { id: true },
          });
          if (!group) {
            return res.status(404).send({ error: '分组不存在' });
          }
          normalizedGroupId = group.id;
        }

        const createdFeed = await prisma.feed.create({
          data: {
            user_id: userId,
            title: title.slice(0, 255),
            url: url.slice(0, 500),
            favicon_url: cleanFaviconUrl ? cleanFaviconUrl.slice(0, 2000) : null,
            description: '',
            feed_type: 'rss',
            source_type: 'native',
            group_id: normalizedGroupId,
            is_active: true,
            update_interval: 1800,
            created_at: new Date(),
            updated_at: new Date(),
          },
        });
        return { feed: createdFeed };
      }
    } catch (error: any) {
      req.log.error(error);
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });
};

export { feedSubscriptionRoutes };

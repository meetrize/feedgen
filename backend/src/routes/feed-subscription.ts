import { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../server';
import { translateArticleForUser } from '../services/translation/articleTranslation';
import { assertCanCreatePrivateFeed, formatPublicFeedSummary } from '../services/publicFeedService';

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

/** 校验 Tag 颜色：#RGB 或 #RRGGBB；undefined=未传，null=清空，string=合法值 */
function normalizeTagColor(color: unknown): string | null | undefined {
  if (color === undefined) return undefined;
  const raw = String(color ?? '').trim();
  if (!raw) return null;
  if (/^#[0-9a-fA-F]{3}$/.test(raw) || /^#[0-9a-fA-F]{6}$/.test(raw)) {
    return raw;
  }
  return undefined;
}

function formatTagResponse(tag: {
  id: number;
  name: string;
  slug: string | null;
  color: string | null;
  icon: string | null;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: tag.id,
    name: tag.name,
    slug: tag.slug,
    color: tag.color,
    icon: tag.icon,
    sort_order: tag.sort_order,
    created_at: tag.created_at,
    updated_at: tag.updated_at,
  };
}

async function listUserTagsWithCounts(userId: number) {
  const tags = await prisma.userTag.findMany({
    where: { user_id: userId },
    orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
  });
  const tagIds = tags.map((tag: { id: number }) => tag.id);
  let countMap = new Map<number, number>();
  if (tagIds.length) {
    const grouped = await prisma.userArticleTag.groupBy({
      by: ['tag_id'],
      where: { user_id: userId, tag_id: { in: tagIds } },
      _count: { _all: true },
    });
    countMap = new Map(
      grouped.map((row: { tag_id: number; _count: { _all: number } }) => [
        row.tag_id,
        Number(row._count?._all || 0),
      ])
    );
  }
  return tags.map((tag: {
    id: number;
    name: string;
    slug: string | null;
    color: string | null;
    icon: string | null;
    sort_order: number;
    created_at: Date;
    updated_at: Date;
  }) => ({
    ...formatTagResponse(tag),
    article_count: countMap.get(tag.id) || 0,
  }));
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
    message.includes('user_tags') ||
    message.includes('user_article_tags') ||
    message.includes('userTag') ||
    message.includes('userArticleTag') ||
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
      message: '私有 Feed 数量已达上限，请删除部分私有源或改用公开源订阅',
    };
  }

  if (message.includes('公开源订阅数量已达上限') || error?.code === 'PUBLIC_SUB_LIMIT') {
    return {
      statusCode: 400,
      message: '公开源订阅数量已达上限',
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

const MAX_TAGS_PER_ARTICLE = 20;

async function assertArticleOwnedByUser(
  userId: number,
  articleId: number
): Promise<{ id: number; feed_id: number } | null> {
  return prisma.article.findFirst({
    where: { id: articleId, feeds: { user_id: userId } },
    select: { id: true, feed_id: true },
  });
}

async function assertTagOwnedByUser(userId: number, tagId: number): Promise<boolean> {
  const tag = await prisma.userTag.findFirst({
    where: { id: tagId, user_id: userId },
    select: { id: true },
  });
  return !!tag;
}

type ArticleTagChip = { id: number; name: string; color: string | null; icon: string | null };

async function listArticleTagsForUser(userId: number, articleId: number): Promise<ArticleTagChip[]> {
  const rows = await prisma.userArticleTag.findMany({
    where: { user_id: userId, article_id: articleId },
    include: {
      tag: {
        select: { id: true, name: true, color: true, icon: true, sort_order: true },
      },
    },
  });
  return rows
    .map((row: { tag: { id: number; name: string; color: string | null; icon: string | null; sort_order: number } }) => row.tag)
    .sort(
      (
        a: { sort_order: number; name: string },
        b: { sort_order: number; name: string }
      ) => {
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
        return a.name.localeCompare(b.name, 'zh-CN');
      }
    )
    .map((tag: { id: number; name: string; color: string | null; icon: string | null }) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      icon: tag.icon,
    }));
}

async function countArticleTagsForUser(userId: number, articleId: number): Promise<number> {
  return prisma.userArticleTag.count({
    where: { user_id: userId, article_id: articleId },
  });
}

type ArticleListTagChip = { id: number; name: string; color: string | null; icon: string | null };

type ArticleListAiCategory = {
  id: number;
  code: string;
  name: string;
  color: string | null;
  confidence: number | null;
  need_review: boolean;
} | null;

/** 批量加载文章列表用 tags，避免 N+1 */
async function buildArticleTagsMap(
  userId: number,
  articleIds: number[]
): Promise<Map<number, ArticleListTagChip[]>> {
  const map = new Map<number, ArticleListTagChip[]>();
  for (const articleId of articleIds) {
    map.set(articleId, []);
  }
  if (!articleIds.length) return map;

  const rows = await prisma.userArticleTag.findMany({
    where: { user_id: userId, article_id: { in: articleIds } },
    include: {
      tag: {
        select: { id: true, name: true, color: true, icon: true, sort_order: true },
      },
    },
  });

  const grouped = new Map<number, Array<{ id: number; name: string; color: string | null; icon: string | null; sort_order: number }>>();
  for (const row of rows) {
    const list = grouped.get(row.article_id) || [];
    list.push(row.tag);
    grouped.set(row.article_id, list);
  }

  for (const [articleId, tagRows] of grouped.entries()) {
    map.set(
      articleId,
      tagRows
        .sort((a, b) => {
          if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
          return a.name.localeCompare(b.name, 'zh-CN');
        })
        .map((tag) => ({
          id: tag.id,
          name: tag.name,
          color: tag.color,
          icon: tag.icon,
        }))
    );
  }

  return map;
}

/** 批量加载文章列表用 ai_category，避免 N+1 */
async function buildArticleAiCategoryMap(
  articleIds: number[],
): Promise<Map<number, ArticleListAiCategory>> {
  const map = new Map<number, ArticleListAiCategory>();
  for (const articleId of articleIds) {
    map.set(articleId, null);
  }
  if (!articleIds.length) return map;

  const rows = await prisma.articleClassification.findMany({
    where: { article_id: { in: articleIds } },
    include: {
      category: {
        select: { id: true, code: true, name: true, color: true, status: true },
      },
    },
  });

  for (const row of rows) {
    if (!row.category || row.category.status !== 'active' || row.category_id == null) {
      map.set(row.article_id, null);
      continue;
    }
    map.set(row.article_id, {
      id: row.category.id,
      code: row.category.code,
      name: row.category.name,
      color: row.category.color,
      confidence: row.confidence,
      need_review: row.need_review,
    });
  }

  return map;
}

function appendArticleSearchFilter(where: Record<string, unknown>, keyword: string): Record<string, unknown> {
  const q = keyword.trim();
  if (!q) return where;
  const searchClause = {
    OR: [
      { title: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
      { author: { contains: q, mode: 'insensitive' } },
    ],
  };
  const existingAnd = where.AND;
  const andList = Array.isArray(existingAnd) ? [...existingAnd] : existingAnd ? [existingAnd] : [];
  andList.push(searchClause);
  return { ...where, AND: andList };
}

const feedSubscriptionRoutes: FastifyPluginAsync = async (fastify) => {
  // 按分组/Feed读取文章列表（数据来自 articles 表）
  fastify.get('/articles', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const query = req.query as {
      groupId?: string;
      feedId?: string;
      publicSubscriptionId?: string;
      limit?: string;
      offset?: string;
      includeContent?: string;
      scope?: string;
      unread?: string;
      ungrouped?: string;
      tagId?: string;
      categoryId?: string;
      q?: string;
    };

    const ungroupedOnly = query.ungrouped === '1' || query.ungrouped === 'true';
    const groupId = query.groupId ? Number(query.groupId) : null;
    let feedId = query.feedId ? Number(query.feedId) : null;
    const publicSubscriptionIdRaw = query.publicSubscriptionId
      ? Number(query.publicSubscriptionId)
      : null;
    if (publicSubscriptionIdRaw != null && Number.isFinite(publicSubscriptionIdRaw)) {
      feedId = -publicSubscriptionIdRaw;
    }
    const limitRaw = query.limit ? Number(query.limit) : 100;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 300) : 100;
    const offsetRaw = query.offset ? Number(query.offset) : 0;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
    const includeContent = query.includeContent === '1' || query.includeContent === 'true';
    const searchQuery = String(query.q || '').trim();
    const hasSearch = searchQuery.length > 0;
    const scope = String(query.scope || 'all').trim().toLowerCase();
    const unreadOnly = !hasSearch && (query.unread === '1' || query.unread === 'true');
    const isTodayScope = !hasSearch && scope === 'today';
    const isLikedScope = !hasSearch && scope === 'liked';
    const hasCategoryIdFilter =
      !hasSearch &&
      query.categoryId !== undefined &&
      query.categoryId !== null &&
      String(query.categoryId).trim() !== '';
    let categoryIdFilter: number | null = null;
    if (hasCategoryIdFilter) {
      categoryIdFilter = Number(query.categoryId);
      if (!Number.isFinite(categoryIdFilter)) {
        return res.status(400).send({ error: 'categoryId 无效' });
      }
    }

    const hasTagIdFilter =
      !hasSearch &&
      query.tagId !== undefined &&
      query.tagId !== null &&
      String(query.tagId).trim() !== '';
    let tagIdFilter: number | null = null;
    if (hasTagIdFilter) {
      tagIdFilter = Number(query.tagId);
      if (!Number.isFinite(tagIdFilter)) {
        return res.status(400).send({ error: 'tagId 无效' });
      }
    }

    if (query.groupId && !ungroupedOnly && !Number.isFinite(groupId)) {
      return res.status(400).send({ error: 'groupId 无效' });
    }
    if (query.feedId && !Number.isFinite(feedId)) {
      return res.status(400).send({ error: 'feedId 无效' });
    }

    try {
      let articleWhere: any;
      if (feedId != null) {
        if (feedId < 0) {
          const subId = -feedId;
          const sub = await prisma.userFeedSubscription.findFirst({
            where: {
              id: subId,
              user_id: userId,
              is_active: true,
              ...(groupId != null ? { group_id: groupId } : ungroupedOnly ? { group_id: null } : {}),
            },
            select: { public_feed_id: true },
          });
          if (!sub) return { articles: [], total: 0 };
          articleWhere = { public_feed_id: sub.public_feed_id };
        } else {
          const feed = await prisma.feed.findFirst({
            where: {
              id: feedId,
              user_id: userId,
              public_feed_id: null,
              ...(groupId != null ? { group_id: groupId } : ungroupedOnly ? { group_id: null } : {}),
            },
            select: { id: true },
          });
          if (!feed) return { articles: [], total: 0 };
          articleWhere = { feed_id: feed.id };
        }
      } else {
        const groupFilter =
          ungroupedOnly ? { group_id: null } : groupId != null ? { group_id: groupId } : {};
        articleWhere = {
          OR: [
            {
              feeds: {
                user_id: userId,
                public_feed_id: null,
                ...groupFilter,
              },
            },
            {
              public_feed: {
                subscriptions: {
                  some: {
                    user_id: userId,
                    is_active: true,
                    ...groupFilter,
                  },
                },
              },
            },
          ],
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

      if (hasSearch) {
        articleWhere = appendArticleSearchFilter(articleWhere, searchQuery);
      }

      const articleSelectBase: any = {
        id: true,
        feed_id: true,
        public_feed_id: true,
        title: true,
        title_zh: true,
        description: true,
        description_zh: true,
        url: true,
        author: true,
        pub_date: true,
        created_at: true,
        feeds: { select: { title: true } },
        public_feed: { select: { title: true } },
      };
      if (includeContent) articleSelectBase.content = true;

      // categoryId 与 tagId、scope=liked 互斥：有 categoryId 时按 AI 类别筛选，忽略 tagId 与 scope=liked
      if (hasCategoryIdFilter && categoryIdFilter != null) {
        const activeCategory = await prisma.newsCategory.findFirst({
          where: { id: categoryIdFilter, status: 'active' },
          select: { id: true },
        });
        if (!activeCategory) {
          return res.status(404).send({ error: '类别不存在' });
        }

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

        let unreadFilterSql = Prisma.empty;
        if (unreadOnly) {
          unreadFilterSql = Prisma.sql` AND NOT EXISTS (
            SELECT 1 FROM "user_article_reads" r
            WHERE r."article_id" = a."id" AND r."user_id" = ${userId}
          )`;
        }

        const classifiedRows = (await prisma.$queryRaw(Prisma.sql`
          SELECT ac."article_id" AS article_id
          FROM "article_classifications" ac
          INNER JOIN "articles" a ON a."id" = ac."article_id"
          WHERE ac."category_id" = ${categoryIdFilter}
            AND a."feed_id" IN (${Prisma.join(scopedFeedIds)})
            ${todayFilterSql}
            ${unreadFilterSql}
          ORDER BY ac."classified_at" DESC NULLS LAST, a."created_at" DESC NULLS LAST, a."pub_date" DESC NULLS LAST
          LIMIT ${limit} OFFSET ${offset}
        `)) as Array<{ article_id: number }>;

        const totalRows = (await prisma.$queryRaw(Prisma.sql`
          SELECT COUNT(*)::int AS c
          FROM "article_classifications" ac
          INNER JOIN "articles" a ON a."id" = ac."article_id"
          WHERE ac."category_id" = ${categoryIdFilter}
            AND a."feed_id" IN (${Prisma.join(scopedFeedIds)})
            ${todayFilterSql}
            ${unreadFilterSql}
        `)) as Array<{ c: number }>;
        const totalCount = Number(totalRows[0]?.c || 0);

        const orderedIds = classifiedRows.map((r) => Number(r.article_id)).filter((id) => Number.isFinite(id));
        if (!orderedIds.length) return { articles: [], total: totalCount };

        const classifiedArticles = await prisma.article.findMany({
          where: { id: { in: orderedIds } },
          select: articleSelectBase,
        });
        const byId = new Map(classifiedArticles.map((item: any) => [item.id, item]));
        const sortedArticles = orderedIds.map((id) => byId.get(id)).filter(Boolean) as any[];
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

        const [articleTagsMap, articleAiCategoryMap] = await Promise.all([
          buildArticleTagsMap(userId, articleIds),
          buildArticleAiCategoryMap(articleIds),
        ]);

        const mappedArticles = sortedArticles.map((item: any) => ({
          id: item.id,
          feed_id: item.feed_id,
          title: item.title,
          title_zh: item.title_zh,
          description: item.description,
          description_zh: item.description_zh,
          ...(includeContent ? { content: item.content } : {}),
          url: item.url,
          author: item.author,
          pub_date: item.pub_date,
          created_at: item.created_at,
          feed_title: item.feeds?.title || '',
          is_read: readIdSet.has(item.id),
          is_liked: likedIdSet.has(item.id),
          tags: articleTagsMap.get(item.id) || [],
          ai_category: articleAiCategoryMap.get(item.id) ?? null,
        }));

        return { articles: mappedArticles, total: totalCount };
      }

      // tagId 与 scope=liked 互斥：有 tagId 时按标签筛选，忽略 scope=liked
      if (hasTagIdFilter && tagIdFilter != null) {
        const ownedTag = await prisma.userTag.findFirst({
          where: { id: tagIdFilter, user_id: userId },
          select: { id: true },
        });
        if (!ownedTag) {
          return res.status(404).send({ error: '标签不存在' });
        }

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

        let unreadFilterSql = Prisma.empty;
        if (unreadOnly) {
          unreadFilterSql = Prisma.sql` AND NOT EXISTS (
            SELECT 1 FROM "user_article_reads" r
            WHERE r."article_id" = a."id" AND r."user_id" = ${userId}
          )`;
        }

        const taggedRows = (await prisma.$queryRaw(Prisma.sql`
          SELECT t."article_id" AS article_id
          FROM "user_article_tags" t
          INNER JOIN "articles" a ON a."id" = t."article_id"
          WHERE t."user_id" = ${userId}
            AND t."tag_id" = ${tagIdFilter}
            AND a."feed_id" IN (${Prisma.join(scopedFeedIds)})
            ${todayFilterSql}
            ${unreadFilterSql}
          ORDER BY t."tagged_at" DESC NULLS LAST, a."created_at" DESC NULLS LAST, a."pub_date" DESC NULLS LAST
          LIMIT ${limit} OFFSET ${offset}
        `)) as Array<{ article_id: number }>;

        const totalRows = (await prisma.$queryRaw(Prisma.sql`
          SELECT COUNT(*)::int AS c
          FROM "user_article_tags" t
          INNER JOIN "articles" a ON a."id" = t."article_id"
          WHERE t."user_id" = ${userId}
            AND t."tag_id" = ${tagIdFilter}
            AND a."feed_id" IN (${Prisma.join(scopedFeedIds)})
            ${todayFilterSql}
            ${unreadFilterSql}
        `)) as Array<{ c: number }>;
        const totalCount = Number(totalRows[0]?.c || 0);

        const orderedIds = taggedRows.map((r) => Number(r.article_id)).filter((id) => Number.isFinite(id));
        if (!orderedIds.length) return { articles: [], total: totalCount };

        const taggedArticles = await prisma.article.findMany({
          where: { id: { in: orderedIds } },
          select: articleSelectBase,
        });
        const byId = new Map(taggedArticles.map((item: any) => [item.id, item]));
        const sortedArticles = orderedIds.map((id) => byId.get(id)).filter(Boolean) as any[];
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

        const [articleTagsMap, articleAiCategoryMap] = await Promise.all([
          buildArticleTagsMap(userId, articleIds),
          buildArticleAiCategoryMap(articleIds),
        ]);

        const mappedArticles = sortedArticles.map((item: any) => ({
          id: item.id,
          feed_id: item.feed_id,
          title: item.title,
          title_zh: item.title_zh,
          description: item.description,
          description_zh: item.description_zh,
          ...(includeContent ? { content: item.content } : {}),
          url: item.url,
          author: item.author,
          pub_date: item.pub_date,
          created_at: item.created_at,
          feed_title: item.feeds?.title || '',
          is_read: readIdSet.has(item.id),
          is_liked: likedIdSet.has(item.id),
          tags: articleTagsMap.get(item.id) || [],
          ai_category: articleAiCategoryMap.get(item.id) ?? null,
        }));

        return { articles: mappedArticles, total: totalCount };
      }

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

        const [articleTagsMap, articleAiCategoryMap] = await Promise.all([
          buildArticleTagsMap(userId, articleIds),
          buildArticleAiCategoryMap(articleIds),
        ]);

        const mappedArticles = sortedArticles.map((item: any) => ({
          id: item.id,
          feed_id: item.feed_id,
          title: item.title,
          title_zh: item.title_zh,
          description: item.description,
          description_zh: item.description_zh,
          ...(includeContent ? { content: item.content } : {}),
          url: item.url,
          author: item.author,
          pub_date: item.pub_date,
          created_at: item.created_at,
          feed_title: item.feeds?.title || '',
          is_read: readIdSet.has(item.id),
          is_liked: true,
          tags: articleTagsMap.get(item.id) || [],
          ai_category: articleAiCategoryMap.get(item.id) ?? null,
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

        const [articleTagsMap, articleAiCategoryMap] = await Promise.all([
          buildArticleTagsMap(userId, articleIds),
          buildArticleAiCategoryMap(articleIds),
        ]);

        const mappedArticles = sortedArticles.map((item: any) => ({
          id: item.id,
          feed_id: item.feed_id,
          title: item.title,
          title_zh: item.title_zh,
          description: item.description,
          description_zh: item.description_zh,
          ...(includeContent ? { content: item.content } : {}),
          url: item.url,
          author: item.author,
          pub_date: item.pub_date,
          created_at: item.created_at,
          feed_title: item.feeds?.title || '',
          is_read: false,
          is_liked: likedIdSet.has(item.id),
          tags: articleTagsMap.get(item.id) || [],
          ai_category: articleAiCategoryMap.get(item.id) ?? null,
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

      const [articleTagsMap, articleAiCategoryMap] = await Promise.all([
        buildArticleTagsMap(userId, articleIds),
        buildArticleAiCategoryMap(articleIds),
      ]);

      const mappedArticles = sortedArticles.map((item: any) => ({
        id: item.id,
        feed_id: item.feed_id,
        title: item.title,
        title_zh: item.title_zh,
        description: item.description,
        description_zh: item.description_zh,
        ...(includeContent ? { content: item.content } : {}),
        url: item.url,
        author: item.author,
        pub_date: item.pub_date,
        created_at: item.created_at,
        feed_title: item.feeds?.title || '',
        is_read: readIdSet.has(item.id),
        is_liked: likedIdSet.has(item.id),
        tags: articleTagsMap.get(item.id) || [],
        ai_category: articleAiCategoryMap.get(item.id) ?? null,
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
          title_zh: true,
          description: true,
          description_zh: true,
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
          title_zh: article.title_zh,
          description: article.description,
          description_zh: article.description_zh,
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

  // 翻译单篇文章标题与简介
  fastify.post('/articles/:articleId/translate', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const articleId = Number(req.params.articleId);
    if (!Number.isFinite(articleId)) {
      return res.status(400).send({ error: 'articleId 无效' });
    }

    try {
      const result = await translateArticleForUser(articleId, userId);
      return {
        success: true,
        title_zh: result.title_zh,
        description_zh: result.description_zh,
      };
    } catch (error: any) {
      req.log.error(error);
      const message = error instanceof Error ? error.message : '翻译失败';
      const statusCode = message.includes('不存在') ? 404
        : message.includes('权限') || message.includes('未开启') ? 403
        : 500;
      return res.status(statusCode).send({ error: message });
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

  // ---------- 批量文章 Tag（须在 /articles/:articleId/tags 之前注册） ----------

  fastify.post('/articles/batch-tags', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const { article_ids: articleIdsRaw, tag_ids: tagIdsRaw, action: actionRaw } = req.body as {
      article_ids?: unknown;
      tag_ids?: unknown;
      action?: string;
    };

    if (!Array.isArray(articleIdsRaw)) {
      return res.status(400).send({ error: 'article_ids 必须为数组' });
    }
    if (!Array.isArray(tagIdsRaw)) {
      return res.status(400).send({ error: 'tag_ids 必须为数组' });
    }

    const articleIds = articleIdsRaw.map((id) => Number(id)).filter((id) => Number.isFinite(id));
    if (articleIds.length !== articleIdsRaw.length) {
      return res.status(400).send({ error: 'article_ids 含无效 id' });
    }

    const uniqueArticleIds = [...new Set(articleIds)];
    if (!uniqueArticleIds.length || uniqueArticleIds.length > 100) {
      return res.status(400).send({ error: 'article_ids 数量须在 1～100 之间' });
    }

    const tagIds = tagIdsRaw.map((id) => Number(id)).filter((id) => Number.isFinite(id));
    if (tagIds.length !== tagIdsRaw.length) {
      return res.status(400).send({ error: 'tag_ids 含无效 id' });
    }

    const uniqueTagIds = [...new Set(tagIds)];
    if (!uniqueTagIds.length) {
      return res.status(400).send({ error: 'tag_ids 至少包含 1 个有效 id' });
    }

    const action = String(actionRaw || '').trim().toLowerCase();
    if (action !== 'add' && action !== 'remove' && action !== 'set') {
      return res.status(400).send({ error: 'action 须为 add、remove 或 set' });
    }

    if (action === 'set' && uniqueTagIds.length > MAX_TAGS_PER_ARTICLE) {
      return res.status(400).send({ error: `单篇文章最多 ${MAX_TAGS_PER_ARTICLE} 个标签` });
    }

    try {
      const ownedArticles = await prisma.article.findMany({
        where: {
          id: { in: uniqueArticleIds },
          feeds: { user_id: userId },
        },
        select: { id: true },
      });
      const ownedArticleIdSet = new Set(ownedArticles.map((row: { id: number }) => row.id));
      const invalidIds = uniqueArticleIds.filter((id) => !ownedArticleIdSet.has(id));
      if (invalidIds.length) {
        return res.status(400).send({
          error: '部分文章不存在或无权限',
          invalid_ids: invalidIds,
        });
      }

      const ownedTags = await prisma.userTag.findMany({
        where: { user_id: userId, id: { in: uniqueTagIds } },
        select: { id: true },
      });
      if (ownedTags.length !== uniqueTagIds.length) {
        return res.status(400).send({ error: 'tag_ids 含无效或不属于当前用户的标签' });
      }

      const validArticleIds = uniqueArticleIds;
      let updated = 0;
      const skipped: number[] = [];

      if (action === 'add') {
        for (const articleId of validArticleIds) {
          const existingRows = await prisma.userArticleTag.findMany({
            where: { user_id: userId, article_id: articleId },
            select: { tag_id: true },
          });
          const existingTagIds = new Set(existingRows.map((row: { tag_id: number }) => row.tag_id));
          const toAdd = uniqueTagIds.filter((tagId) => !existingTagIds.has(tagId));
          if (!toAdd.length) {
            skipped.push(articleId);
            continue;
          }
          if (existingTagIds.size + toAdd.length > MAX_TAGS_PER_ARTICLE) {
            return res.status(400).send({
              error: `文章 ${articleId} 超过单篇 ${MAX_TAGS_PER_ARTICLE} 个标签上限`,
            });
          }
          await prisma.userArticleTag.createMany({
            data: toAdd.map((tagId) => ({
              user_id: userId,
              article_id: articleId,
              tag_id: tagId,
              source: 'manual',
            })),
            skipDuplicates: true,
          });
          updated += 1;
        }
      } else if (action === 'remove') {
        await prisma.userArticleTag.deleteMany({
          where: {
            user_id: userId,
            article_id: { in: validArticleIds },
            tag_id: { in: uniqueTagIds },
          },
        });
        updated = validArticleIds.length;
      } else {
        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await tx.userArticleTag.deleteMany({
            where: {
              user_id: userId,
              article_id: { in: validArticleIds },
            },
          });
          if (uniqueTagIds.length) {
            const rows = validArticleIds.flatMap((articleId) =>
              uniqueTagIds.map((tagId) => ({
                user_id: userId,
                article_id: articleId,
                tag_id: tagId,
                source: 'manual',
              }))
            );
            await tx.userArticleTag.createMany({ data: rows, skipDuplicates: true });
          }
        });
        updated = validArticleIds.length;
      }

      const response: { ok: boolean; updated: number; skipped?: number[] } = {
        ok: true,
        updated,
      };
      if (skipped.length) response.skipped = skipped;
      return response;
    } catch (error: any) {
      req.log.error(error);
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  // ---------- 单篇文章 Tag ----------

  fastify.get('/articles/:articleId/tags', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const articleId = Number(req.params.articleId);
    if (!Number.isFinite(articleId)) {
      return res.status(400).send({ error: 'articleId 无效' });
    }

    try {
      const article = await assertArticleOwnedByUser(userId, articleId);
      if (!article) {
        return res.status(404).send({ error: '文章不存在' });
      }

      const tags = await listArticleTagsForUser(userId, articleId);
      return { tags };
    } catch (error: any) {
      req.log.error(error);
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  fastify.put('/articles/:articleId/tags', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const articleId = Number(req.params.articleId);
    if (!Number.isFinite(articleId)) {
      return res.status(400).send({ error: 'articleId 无效' });
    }

    const { tag_ids: tagIdsRaw } = req.body as { tag_ids?: unknown };
    if (!Array.isArray(tagIdsRaw)) {
      return res.status(400).send({ error: 'tag_ids 必须为数组' });
    }

    const tagIds = tagIdsRaw.map((id) => Number(id)).filter((id) => Number.isFinite(id));
    if (tagIds.length !== tagIdsRaw.length) {
      return res.status(400).send({ error: 'tag_ids 含无效 id' });
    }

    const uniqueTagIds = [...new Set(tagIds)];
    if (uniqueTagIds.length > MAX_TAGS_PER_ARTICLE) {
      return res.status(400).send({ error: `单篇文章最多 ${MAX_TAGS_PER_ARTICLE} 个标签` });
    }

    try {
      const article = await assertArticleOwnedByUser(userId, articleId);
      if (!article) {
        return res.status(404).send({ error: '文章不存在' });
      }

      if (uniqueTagIds.length) {
        const owned = await prisma.userTag.findMany({
          where: { user_id: userId, id: { in: uniqueTagIds } },
          select: { id: true },
        });
        if (owned.length !== uniqueTagIds.length) {
          return res.status(400).send({ error: 'tag_ids 含无效或不属于当前用户的标签' });
        }
      }

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.userArticleTag.deleteMany({
          where: { user_id: userId, article_id: articleId },
        });
        if (uniqueTagIds.length) {
          await tx.userArticleTag.createMany({
            data: uniqueTagIds.map((tagId) => ({
              user_id: userId,
              article_id: articleId,
              tag_id: tagId,
              source: 'manual',
            })),
          });
        }
      });

      const tags = await listArticleTagsForUser(userId, articleId);
      return { tags };
    } catch (error: any) {
      req.log.error(error);
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  fastify.post('/articles/:articleId/tags', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const articleId = Number(req.params.articleId);
    if (!Number.isFinite(articleId)) {
      return res.status(400).send({ error: 'articleId 无效' });
    }

    const { tag_id: tagIdRaw, name } = req.body as { tag_id?: number; name?: string };
    const hasTagId = tagIdRaw !== undefined && tagIdRaw !== null;
    const hasName = name !== undefined && name !== null && String(name).trim() !== '';

    if (hasTagId === hasName) {
      return res.status(400).send({ error: '请提供 tag_id 或 name 其中之一' });
    }

    try {
      const article = await assertArticleOwnedByUser(userId, articleId);
      if (!article) {
        return res.status(404).send({ error: '文章不存在' });
      }

      let targetTagId: number;

      if (hasTagId) {
        const tagId = Number(tagIdRaw);
        if (!Number.isFinite(tagId)) {
          return res.status(400).send({ error: 'tag_id 无效' });
        }
        if (!(await assertTagOwnedByUser(userId, tagId))) {
          return res.status(400).send({ error: '标签不存在' });
        }
        targetTagId = tagId;

        const existing = await prisma.userArticleTag.findUnique({
          where: {
            user_id_article_id_tag_id: {
              user_id: userId,
              article_id: articleId,
              tag_id: targetTagId,
            },
          },
          select: { tag_id: true },
        });
        if (!existing) {
          const currentCount = await countArticleTagsForUser(userId, articleId);
          if (currentCount >= MAX_TAGS_PER_ARTICLE) {
            return res.status(400).send({ error: `单篇文章最多 ${MAX_TAGS_PER_ARTICLE} 个标签` });
          }
          await prisma.userArticleTag.create({
            data: {
              user_id: userId,
              article_id: articleId,
              tag_id: targetTagId,
              source: 'manual',
            },
          });
        }
      } else {
        const cleanName = String(name || '').trim();
        if (!cleanName) {
          return res.status(400).send({ error: '标签名称不能为空' });
        }
        if (cleanName.length > 50) {
          return res.status(400).send({ error: '标签名称不能超过 50 字符' });
        }

        let tag = await prisma.userTag.findFirst({
          where: { user_id: userId, name: cleanName },
          select: { id: true },
        });
        if (!tag) {
          try {
            tag = await prisma.userTag.create({
              data: {
                user_id: userId,
                name: cleanName,
                created_at: new Date(),
                updated_at: new Date(),
              },
              select: { id: true },
            });
          } catch (createError: any) {
            if (createError?.code === 'P2002') {
              tag = await prisma.userTag.findFirst({
                where: { user_id: userId, name: cleanName },
                select: { id: true },
              });
            } else {
              throw createError;
            }
          }
        }
        if (!tag) {
          return res.status(500).send({ error: '创建标签失败' });
        }
        targetTagId = tag.id;

        const existing = await prisma.userArticleTag.findUnique({
          where: {
            user_id_article_id_tag_id: {
              user_id: userId,
              article_id: articleId,
              tag_id: targetTagId,
            },
          },
          select: { tag_id: true },
        });
        if (!existing) {
          const currentCount = await countArticleTagsForUser(userId, articleId);
          if (currentCount >= MAX_TAGS_PER_ARTICLE) {
            return res.status(400).send({ error: `单篇文章最多 ${MAX_TAGS_PER_ARTICLE} 个标签` });
          }
          await prisma.userArticleTag.create({
            data: {
              user_id: userId,
              article_id: articleId,
              tag_id: targetTagId,
              source: 'manual',
            },
          });
        }
      }

      const tags = await listArticleTagsForUser(userId, articleId);
      return { tags };
    } catch (error: any) {
      req.log.error(error);
      if (error?.code === 'P2002') {
        const tags = await listArticleTagsForUser(userId, articleId);
        return { tags };
      }
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  fastify.delete('/articles/:articleId/tags/:tagId', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const articleId = Number(req.params.articleId);
    const tagId = Number(req.params.tagId);
    if (!Number.isFinite(articleId)) {
      return res.status(400).send({ error: 'articleId 无效' });
    }
    if (!Number.isFinite(tagId)) {
      return res.status(400).send({ error: 'tagId 无效' });
    }

    try {
      const article = await assertArticleOwnedByUser(userId, articleId);
      if (!article) {
        return res.status(404).send({ error: '文章不存在' });
      }

      await prisma.userArticleTag.deleteMany({
        where: {
          user_id: userId,
          article_id: articleId,
          tag_id: tagId,
        },
      });

      return { ok: true };
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
      const [groups, feeds, publicSubs] = await Promise.all([
        prisma.userFeedGroup.findMany({
          where: { user_id: userId },
          orderBy: { created_at: 'asc' },
        }),
        prisma.feed.findMany({
          where: { user_id: userId, public_feed_id: null },
          orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
        }),
        prisma.userFeedSubscription.findMany({
          where: { user_id: userId, is_active: true },
          orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
          include: {
            public_feed: { include: { contributor: { select: { id: true, username: true } } } },
          },
        }),
      ]);
      const feedIds = feeds.map((item: any) => item.id).filter((id: any) => Number.isFinite(Number(id)));
      const publicFeedIds = publicSubs.map((s: any) => s.public_feed_id);
      let feedArticleCountMap = new Map<number, number>();
      if (feedIds.length) {
        const grouped = await prisma.article.groupBy({
          by: ['feed_id'],
          where: { feed_id: { in: feedIds } },
          _count: { _all: true },
        });
        feedArticleCountMap = new Map<number, number>(
          grouped
            .filter((item: any) => item.feed_id != null)
            .map((item: any) => [item.feed_id as number, Number(item._count?._all || 0)])
        );
      }
      let publicArticleCountMap = new Map<number, number>();
      if (publicFeedIds.length) {
        const groupedPublic = await prisma.article.groupBy({
          by: ['public_feed_id'],
          where: { public_feed_id: { in: publicFeedIds } },
          _count: { _all: true },
        });
        publicArticleCountMap = new Map<number, number>(
          groupedPublic
            .filter((item: any) => item.public_feed_id != null)
            .map((item: any) => [item.public_feed_id as number, Number(item._count?._all || 0)])
        );
      }

      const feedsWithArticleCount = feeds.map((feed: any) => ({
        ...feed,
        source: 'private',
        article_count: feedArticleCountMap.get(feed.id) || 0,
      }));

      const publicSubscriptions = publicSubs.map((sub: any) => ({
        id: sub.id,
        public_feed_id: sub.public_feed_id,
        group_id: sub.group_id,
        custom_title: sub.custom_title,
        sort_order: sub.sort_order,
        needs_translation: sub.needs_translation,
        is_active: sub.is_active,
        source: 'public',
        title: sub.custom_title || sub.public_feed.title,
        url: sub.public_feed.url,
        favicon_url: sub.public_feed.favicon_url,
        article_count: publicArticleCountMap.get(sub.public_feed_id) || 0,
        public_feed: formatPublicFeedSummary(sub.public_feed),
      }));

      return { groups, feeds: feedsWithArticleCount, public_subscriptions: publicSubscriptions };
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
        orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
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

  // ---------- Tag 词汇表 CRUD ----------

  fastify.get('/tags', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    try {
      const tags = await listUserTagsWithCounts(userId);
      return { tags };
    } catch (error: any) {
      req.log.error(error);
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  fastify.post('/tags', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const { name, color, icon } = req.body as { name?: string; color?: string; icon?: string };
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      return res.status(400).send({ error: '标签名称不能为空' });
    }
    if (cleanName.length > 50) {
      return res.status(400).send({ error: '标签名称不能超过 50 字符' });
    }

    const colorInput = normalizeTagColor(color);
    if (color !== undefined && color !== null && String(color).trim() && colorInput === undefined) {
      return res.status(400).send({ error: 'color 格式无效，须为 #RGB 或 #RRGGBB' });
    }
    const cleanIcon = normalizeGroupIcon(icon);

    try {
      const tag = await prisma.userTag.create({
        data: {
          user_id: userId,
          name: cleanName,
          color: colorInput === undefined ? null : colorInput,
          icon: cleanIcon,
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
      return { tag: formatTagResponse(tag) };
    } catch (error: any) {
      req.log.error(error);
      if (error?.code === 'P2002') {
        return res.status(409).send({ error: '标签名称已存在' });
      }
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  fastify.put('/tags/reorder', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const { ordered_ids: orderedIdsRaw } = req.body as { ordered_ids?: unknown };
    if (!Array.isArray(orderedIdsRaw)) {
      return res.status(400).send({ error: 'ordered_ids 必须为数组' });
    }

    const orderedIds = orderedIdsRaw.map((id) => Number(id)).filter((id) => Number.isFinite(id));
    if (orderedIds.length !== orderedIdsRaw.length) {
      return res.status(400).send({ error: 'ordered_ids 含无效 id' });
    }
    if (new Set(orderedIds).size !== orderedIds.length) {
      return res.status(400).send({ error: 'ordered_ids 不能含重复 id' });
    }

    try {
      if (orderedIds.length) {
        const owned = await prisma.userTag.findMany({
          where: { user_id: userId, id: { in: orderedIds } },
          select: { id: true },
        });
        if (owned.length !== orderedIds.length) {
          return res.status(400).send({ error: 'ordered_ids 含不属于当前用户的标签' });
        }

        const now = new Date();
        await prisma.$transaction(
          orderedIds.map((tagId, index) =>
            prisma.userTag.update({
              where: { id: tagId },
              data: { sort_order: index, updated_at: now },
            })
          )
        );
      }

      const tags = await listUserTagsWithCounts(userId);
      return { tags };
    } catch (error: any) {
      req.log.error(error);
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  fastify.patch('/tags/:tagId', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const tagId = Number(req.params.tagId);
    if (!Number.isFinite(tagId)) {
      return res.status(400).send({ error: 'tagId 无效' });
    }

    const { name, color, icon, sort_order: sortOrderRaw } = req.body as {
      name?: string;
      color?: string | null;
      icon?: string;
      sort_order?: number;
    };

    if (
      name === undefined &&
      color === undefined &&
      icon === undefined &&
      sortOrderRaw === undefined
    ) {
      return res.status(400).send({ error: '至少提供一个可更新字段' });
    }

    const updateData: {
      name?: string;
      color?: string | null;
      icon?: string | null;
      sort_order?: number;
      updated_at: Date;
    } = { updated_at: new Date() };

    if (name !== undefined) {
      const cleanName = String(name || '').trim();
      if (!cleanName) {
        return res.status(400).send({ error: '标签名称不能为空' });
      }
      if (cleanName.length > 50) {
        return res.status(400).send({ error: '标签名称不能超过 50 字符' });
      }
      updateData.name = cleanName;
    }

    if (color !== undefined) {
      const colorInput = normalizeTagColor(color);
      if (color !== null && String(color).trim() && colorInput === undefined) {
        return res.status(400).send({ error: 'color 格式无效，须为 #RGB 或 #RRGGBB' });
      }
      updateData.color = colorInput === undefined ? null : colorInput;
    }

    if (icon !== undefined) {
      updateData.icon = normalizeGroupIcon(icon);
    }

    if (sortOrderRaw !== undefined) {
      const sortOrder = Number(sortOrderRaw);
      if (!Number.isFinite(sortOrder)) {
        return res.status(400).send({ error: 'sort_order 无效' });
      }
      updateData.sort_order = Math.floor(sortOrder);
    }

    try {
      const existing = await prisma.userTag.findFirst({
        where: { id: tagId, user_id: userId },
        select: { id: true },
      });
      if (!existing) {
        return res.status(404).send({ error: '标签不存在' });
      }

      const tag = await prisma.userTag.update({
        where: { id: tagId },
        data: updateData,
      });
      return { tag: formatTagResponse(tag) };
    } catch (error: any) {
      req.log.error(error);
      if (error?.code === 'P2002') {
        return res.status(409).send({ error: '标签名称已存在' });
      }
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  fastify.delete('/tags/:tagId', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const tagId = Number(req.params.tagId);
    if (!Number.isFinite(tagId)) {
      return res.status(400).send({ error: 'tagId 无效' });
    }

    try {
      const existing = await prisma.userTag.findFirst({
        where: { id: tagId, user_id: userId },
        select: { id: true },
      });
      if (!existing) {
        return res.status(404).send({ error: '标签不存在' });
      }

      await prisma.userTag.delete({ where: { id: tagId } });
      return { ok: true };
    } catch (error: any) {
      req.log.error(error);
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  // 新增订阅（可直接订阅已有 feed，也可先创建 feed 再订阅）
  fastify.post('/', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const { feedId, feedTitle, feedUrl, faviconUrl, groupId, useProxy, needsTranslation } = req.body as {
      feedId?: number;
      feedTitle?: string;
      feedUrl?: string;
      faviconUrl?: string;
      groupId?: number | null;
      useProxy?: boolean;
      needsTranslation?: boolean;
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

        const guard = await assertCanCreatePrivateFeed(userId, {
          url,
          source_type: 'native',
        });
        if (guard.blocked) {
          return res.status(409).send({
            error: '该源已在公开目录中，请直接订阅',
            check: guard.check,
          });
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

        const sortAgg = await prisma.feed.aggregate({
          where: { user_id: userId },
          _max: { sort_order: true },
        });
        const nextSortOrder = (sortAgg._max.sort_order ?? -1) + 1;

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
            sort_order: nextSortOrder,
            use_proxy: useProxy === true,
            needs_translation: needsTranslation === true,
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

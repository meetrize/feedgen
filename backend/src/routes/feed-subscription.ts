import { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../server';
import { buildArticleFinanceMap } from '../services/finance/financeMatchService';
import { buildArticleImportanceMap } from '../services/importance/scoringService';
import { translateArticleForUser } from '../services/translation/articleTranslation';
import { fetchArticleFulltext } from '../services/fulltext/fulltextService';
import { translateArticleFulltextForUser } from '../services/fulltext/fulltextTranslate';
import { assertCanCreatePrivateFeed, formatPublicFeedSummary } from '../services/publicFeedService';
import {
  clampThemeImportance,
  normalizeThemeKeywordList,
} from '../services/theme/themeKeywordNorm';
import { replaceThemeKeywords } from '../services/theme/themeMatchService';
import { addThemeBackfillJob } from '../services/theme/themeMatchQueue';
import { getThemeRematchProgress } from '../services/theme/themeRematchProgress';
import { effectivePubDateForSort } from '../utils/pubDate';

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
  importance?: number | null;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
  keywords?: Array<{ keyword: string }> | string[];
}) {
  const keywords = Array.isArray(tag.keywords)
    ? tag.keywords.map((item) => (typeof item === 'string' ? item : item.keyword)).filter(Boolean)
    : [];
  return {
    id: tag.id,
    name: tag.name,
    slug: tag.slug,
    color: tag.color,
    icon: tag.icon,
    importance: clampThemeImportance(tag.importance, 3),
    keywords,
    sort_order: tag.sort_order,
    created_at: tag.created_at,
    updated_at: tag.updated_at,
  };
}

async function listUserTagsWithCounts(userId: number) {
  const tags = await prisma.userTag.findMany({
    where: { user_id: userId },
    orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    include: {
      keywords: {
        select: { keyword: true },
        orderBy: { id: 'asc' },
      },
    },
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
    importance: number;
    sort_order: number;
    created_at: Date;
    updated_at: Date;
    keywords: Array<{ keyword: string }>;
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

/** 从 articleWhere（含 OR/AND 嵌套）中取出 feeds 过滤条件 */
function extractFeedsFilterFromArticleWhere(articleWhere: any): Record<string, unknown> {
  if (!articleWhere || typeof articleWhere !== 'object') return {};
  if (articleWhere.feeds && typeof articleWhere.feeds === 'object') {
    return articleWhere.feeds as Record<string, unknown>;
  }
  if (Array.isArray(articleWhere.OR)) {
    for (const branch of articleWhere.OR) {
      if (branch?.feeds && typeof branch.feeds === 'object') {
        return branch.feeds as Record<string, unknown>;
      }
    }
  }
  if (Array.isArray(articleWhere.AND)) {
    for (const part of articleWhere.AND) {
      const nested = extractFeedsFilterFromArticleWhere(part);
      if (Object.keys(nested).length) return nested;
    }
  }
  return {};
}

async function resolveFeedIdsForArticleWhere(
  articleWhere: any,
  userId: number,
  opts?: { groupId?: number | null; ungroupedOnly?: boolean },
): Promise<number[]> {
  const directFeedIds = feedIdsFromArticleWhere(articleWhere);
  if (directFeedIds.length) return directFeedIds;

  let groupClause: { group_id?: number | null } = {};
  if (opts?.ungroupedOnly) {
    groupClause = { group_id: null };
  } else if (opts?.groupId != null && Number.isFinite(opts.groupId)) {
    groupClause = { group_id: opts.groupId };
  } else {
    const feedFilter = extractFeedsFilterFromArticleWhere(articleWhere);
    if (Object.prototype.hasOwnProperty.call(feedFilter, 'group_id')) {
      groupClause = { group_id: feedFilter.group_id as number | null };
    }
  }

  const rows = await prisma.feed.findMany({
    where: {
      user_id: userId,
      ...groupClause,
    },
    select: { id: true },
  });
  return rows.map((row: { id: number }) => Number(row.id)).filter((id: number) => Number.isFinite(id));
}

function getArticleSortTime(item: any): number {
  const effective = effectivePubDateForSort(item?.pub_date, item?.created_at);
  return effective ? effective.getTime() : 0;
}

function sortArticlesByCreatedTimeDesc<T extends { pub_date?: any; created_at?: any }>(articles: T[]): T[] {
  return [...articles].sort((a, b) => {
    const diff = getArticleSortTime(b) - getArticleSortTime(a);
    if (diff !== 0) return diff;
    const aCreated = a?.created_at ? new Date(a.created_at).getTime() : 0;
    const bCreated = b?.created_at ? new Date(b.created_at).getTime() : 0;
    return bCreated - aCreated;
  });
}

/** 按发布时间排序的有效时间：无发布时间或未来时间回退入库时间（库内时间为 UTC naive） */
function articleEffectivePubDateSql(): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN a."pub_date" IS NULL THEN a."created_at"
    WHEN a."pub_date" > ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '5 minutes') THEN a."created_at"
    ELSE a."pub_date"
  END`;
}

const ARTICLE_SORT_FIELDS = new Set([
  'importance',
  'pub_date',
  'created_at',
  'updated_at',
  'title',
  'author',
]);

type ArticleSortBy =
  | 'importance'
  | 'pub_date'
  | 'created_at'
  | 'updated_at'
  | 'title'
  | 'author';
type ArticleSortDir = 'asc' | 'desc';

function parseArticleListSort(query: {
  sortBy?: string;
  sortDir?: string;
}): { sortBy: ArticleSortBy; sortDir: ArticleSortDir } {
  let sortByRaw = String(query.sortBy || 'pub_date').trim().toLowerCase();
  let sortDirRaw = String(query.sortDir || '').trim().toLowerCase();

  // 兼容旧值：sortBy=importance 视为重要度降序
  if (sortByRaw === 'importance' && !sortDirRaw) {
    return { sortBy: 'importance', sortDir: 'desc' };
  }
  if (sortByRaw.endsWith('_asc') || sortByRaw.endsWith('_desc')) {
    const parts = sortByRaw.split('_');
    const dirPart = parts.pop() as string;
    const fieldPart = parts.join('_');
    sortByRaw = fieldPart;
    sortDirRaw = dirPart;
  }

  const sortBy = (ARTICLE_SORT_FIELDS.has(sortByRaw) ? sortByRaw : 'pub_date') as ArticleSortBy;
  const sortDir: ArticleSortDir = sortDirRaw === 'asc' ? 'asc' : 'desc';
  return { sortBy, sortDir };
}

function buildPrismaArticleOrderBy(
  sortBy: ArticleSortBy,
  sortDir: ArticleSortDir,
): any[] {
  const dir = sortDir;
  const secondaryDir = 'desc' as const;
  switch (sortBy) {
    case 'importance':
      return [
        { importance: { score: dir } },
        { importance: { stars: dir } },
        { created_at: secondaryDir },
      ];
    case 'created_at':
      return [{ created_at: dir }, { id: dir }];
    case 'updated_at':
      return [{ updated_at: dir }, { id: dir }];
    case 'title':
      return [{ title: dir }, { id: secondaryDir }];
    case 'author':
      return [{ author: dir }, { id: secondaryDir }];
    case 'pub_date':
    default:
      return [{ pub_date: dir }, { created_at: dir }, { id: secondaryDir }];
  }
}

/** 原始 SQL 列表排序：返回可选 JOIN + ORDER BY */
function buildArticleListSortSql(
  sortBy: ArticleSortBy,
  sortDir: ArticleSortDir,
): { joinSql: Prisma.Sql; orderSql: Prisma.Sql } {
  if (sortBy === 'importance') {
    return {
      joinSql: Prisma.sql` LEFT JOIN "article_importance" ai_sort ON ai_sort."article_id" = a."id" `,
      orderSql:
        sortDir === 'asc'
          ? Prisma.sql` ORDER BY ai_sort."score" ASC NULLS LAST, ai_sort."stars" ASC NULLS LAST, a."created_at" DESC NULLS LAST, a."id" DESC `
          : Prisma.sql` ORDER BY ai_sort."score" DESC NULLS LAST, ai_sort."stars" DESC NULLS LAST, a."created_at" DESC NULLS LAST, a."id" DESC `,
    };
  }
  if (sortBy === 'created_at') {
    return {
      joinSql: Prisma.empty,
      orderSql:
        sortDir === 'asc'
          ? Prisma.sql` ORDER BY a."created_at" ASC NULLS LAST, a."id" ASC `
          : Prisma.sql` ORDER BY a."created_at" DESC NULLS LAST, a."id" DESC `,
    };
  }
  if (sortBy === 'updated_at') {
    return {
      joinSql: Prisma.empty,
      orderSql:
        sortDir === 'asc'
          ? Prisma.sql` ORDER BY a."updated_at" ASC NULLS LAST, a."id" ASC `
          : Prisma.sql` ORDER BY a."updated_at" DESC NULLS LAST, a."id" DESC `,
    };
  }
  if (sortBy === 'title') {
    return {
      joinSql: Prisma.empty,
      orderSql:
        sortDir === 'asc'
          ? Prisma.sql` ORDER BY a."title" ASC NULLS LAST, a."id" DESC `
          : Prisma.sql` ORDER BY a."title" DESC NULLS LAST, a."id" DESC `,
    };
  }
  if (sortBy === 'author') {
    return {
      joinSql: Prisma.empty,
      orderSql:
        sortDir === 'asc'
          ? Prisma.sql` ORDER BY a."author" ASC NULLS LAST, a."id" DESC `
          : Prisma.sql` ORDER BY a."author" DESC NULLS LAST, a."id" DESC `,
    };
  }
  // pub_date：无发布时间或未来时间回退 created_at，避免顶置
  const effectivePub = articleEffectivePubDateSql();
  return {
    joinSql: Prisma.empty,
    orderSql:
      sortDir === 'asc'
        ? Prisma.sql` ORDER BY ${effectivePub} ASC NULLS LAST, a."created_at" ASC NULLS LAST, a."id" DESC `
        : Prisma.sql` ORDER BY ${effectivePub} DESC NULLS LAST, a."created_at" DESC NULLS LAST, a."id" DESC `,
  };
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
      minStars?: string;
      sortBy?: string;
      sortDir?: string;
      dedupe?: string;
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
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 100;
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

    let minStarsFilter: number | null = null;
    if (query.minStars !== undefined && query.minStars !== null && String(query.minStars).trim() !== '') {
      const parsedMinStars = Number(query.minStars);
      if (!Number.isInteger(parsedMinStars) || parsedMinStars < 1 || parsedMinStars > 5) {
        return res.status(400).send({ error: 'minStars 须为 1–5 的整数' });
      }
      minStarsFilter = parsedMinStars;
    }
    const { sortBy: articleSortBy, sortDir: articleSortDir } = parseArticleListSort(query);
    const articleSortSql = buildArticleListSortSql(articleSortBy, articleSortDir);
    const dedupeDisplay = query.dedupe === '1' || query.dedupe === 'true';

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

      if (minStarsFilter != null) {
        articleWhere = {
          ...articleWhere,
          importance: { stars: { gte: minStarsFilter } },
        };
      }

      const minStarsFilterSql =
        minStarsFilter != null
          ? Prisma.sql` AND EXISTS (
              SELECT 1 FROM "article_importance" ai
              WHERE ai."article_id" = a."id" AND ai."stars" >= ${minStarsFilter}
            )`
          : Prisma.empty;

      // 去重显示：只留簇内 primary；未检查过的文章仍显示（dup_cluster_id IS NULL）
      const dedupeFilterSql = dedupeDisplay
        ? Prisma.sql` AND (a."dup_is_primary" = true OR a."dup_cluster_id" IS NULL)`
        : Prisma.empty;

      if (dedupeDisplay) {
        articleWhere = {
          AND: [
            articleWhere,
            { OR: [{ dup_is_primary: true }, { dup_cluster_id: null }] },
          ],
        };
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
        fulltext_status: true,
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
          ${articleSortSql.joinSql}
          WHERE ac."category_id" = ${categoryIdFilter}
            AND a."feed_id" IN (${Prisma.join(scopedFeedIds)})
            ${todayFilterSql}
            ${unreadFilterSql}
            ${minStarsFilterSql}
            ${dedupeFilterSql}
          ${articleSortSql.orderSql}
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
            ${minStarsFilterSql}
            ${dedupeFilterSql}
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

        const [articleTagsMap, articleAiCategoryMap, articleFinanceMap, articleImportanceMap] = await Promise.all([
          buildArticleTagsMap(userId, articleIds),
          buildArticleAiCategoryMap(articleIds),
          buildArticleFinanceMap(articleIds),
          buildArticleImportanceMap(articleIds),
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
          fulltext_status: item.fulltext_status || null,
          feed_title: item.feeds?.title || '',
          is_read: readIdSet.has(item.id),
          is_liked: likedIdSet.has(item.id),
          tags: articleTagsMap.get(item.id) || [],
          ai_category: articleAiCategoryMap.get(item.id) ?? null,
          finance_instruments: articleFinanceMap.get(item.id) || [],
          importance: articleImportanceMap.get(item.id) ?? null,
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
          ${articleSortSql.joinSql}
          WHERE t."user_id" = ${userId}
            AND t."tag_id" = ${tagIdFilter}
            AND a."feed_id" IN (${Prisma.join(scopedFeedIds)})
            ${todayFilterSql}
            ${unreadFilterSql}
            ${minStarsFilterSql}
            ${dedupeFilterSql}
          ${articleSortSql.orderSql}
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
            ${minStarsFilterSql}
            ${dedupeFilterSql}
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

        const [articleTagsMap, articleAiCategoryMap, articleFinanceMap, articleImportanceMap] = await Promise.all([
          buildArticleTagsMap(userId, articleIds),
          buildArticleAiCategoryMap(articleIds),
          buildArticleFinanceMap(articleIds),
          buildArticleImportanceMap(articleIds),
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
          fulltext_status: item.fulltext_status || null,
          feed_title: item.feeds?.title || '',
          is_read: readIdSet.has(item.id),
          is_liked: likedIdSet.has(item.id),
          tags: articleTagsMap.get(item.id) || [],
          ai_category: articleAiCategoryMap.get(item.id) ?? null,
          finance_instruments: articleFinanceMap.get(item.id) || [],
          importance: articleImportanceMap.get(item.id) ?? null,
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
          ${articleSortSql.joinSql}
          WHERE l."user_id" = ${userId}
            AND a."feed_id" IN (${Prisma.join(scopedFeedIds)})
            ${todayFilterSql}
            ${minStarsFilterSql}
            ${dedupeFilterSql}
          ${articleSortSql.orderSql}
          LIMIT ${limit} OFFSET ${offset}
        `)) as Array<{ article_id: number }>;

        const totalRows = (await prisma.$queryRaw(Prisma.sql`
          SELECT COUNT(*)::int AS c
          FROM "user_article_likes" l
          INNER JOIN "articles" a ON a."id" = l."article_id"
          WHERE l."user_id" = ${userId}
            AND a."feed_id" IN (${Prisma.join(scopedFeedIds)})
            ${todayFilterSql}
            ${minStarsFilterSql}
            ${dedupeFilterSql}
        `)) as Array<{ c: number }>;
        const totalCount = Number(totalRows[0]?.c || 0);

        const orderedIds = likedRows.map((r) => Number(r.article_id)).filter((id) => Number.isFinite(id));
        if (!orderedIds.length) return { articles: [], total: totalCount };

        const likedArticles = await prisma.article.findMany({ where: { id: { in: orderedIds } }, select: articleSelectBase });
        const byId = new Map(likedArticles.map((item: any) => [item.id, item]));
        const sortedArticles = orderedIds.map((id) => byId.get(id)).filter(Boolean) as any[];
        const articleIds = sortedArticles.map((item: any) => item.id);

        let readIdSet = new Set<number>();
        if (articleIds.length) {
          const readRows = (await prisma.$queryRaw(Prisma.sql`SELECT "article_id" FROM "user_article_reads" WHERE "user_id" = ${userId} AND "article_id" IN (${Prisma.join(articleIds)})`)) as Array<{ article_id: number }>;
          readIdSet = new Set(readRows.map((row) => row.article_id));
        }

        const [articleTagsMap, articleAiCategoryMap, articleFinanceMap, articleImportanceMap] = await Promise.all([
          buildArticleTagsMap(userId, articleIds),
          buildArticleAiCategoryMap(articleIds),
          buildArticleFinanceMap(articleIds),
          buildArticleImportanceMap(articleIds),
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
          fulltext_status: item.fulltext_status || null,
          feed_title: item.feeds?.title || '',
          is_read: readIdSet.has(item.id),
          is_liked: true,
          tags: articleTagsMap.get(item.id) || [],
          ai_category: articleAiCategoryMap.get(item.id) ?? null,
          finance_instruments: articleFinanceMap.get(item.id) || [],
          importance: articleImportanceMap.get(item.id) ?? null,
        }));

        return { articles: mappedArticles, total: totalCount };
      }

      if (unreadOnly) {
        const scopedFeedIds = await resolveFeedIdsForArticleWhere(articleWhere, userId, {
          groupId,
          ungroupedOnly,
        });
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
          ${articleSortSql.joinSql}
          WHERE a."feed_id" IN (${Prisma.join(scopedFeedIds)})
            AND r."article_id" IS NULL
            ${todayFilterSql}
            ${minStarsFilterSql}
            ${dedupeFilterSql}
          ${articleSortSql.orderSql}
          LIMIT ${limit} OFFSET ${offset}
        `)) as Array<{ article_id: number }>;

        const totalRows = (await prisma.$queryRaw(Prisma.sql`
          SELECT COUNT(*)::int AS c
          FROM "articles" a
          LEFT JOIN "user_article_reads" r ON r."article_id" = a."id" AND r."user_id" = ${userId}
          WHERE a."feed_id" IN (${Prisma.join(scopedFeedIds)})
            AND r."article_id" IS NULL
            ${todayFilterSql}
            ${minStarsFilterSql}
            ${dedupeFilterSql}
        `)) as Array<{ c: number }>;
        const totalCount = Number(totalRows[0]?.c || 0);
        const orderedIds = unreadRows.map((r) => Number(r.article_id)).filter((id) => Number.isFinite(id));
        if (!orderedIds.length) return { articles: [], total: totalCount };

        const unreadArticles = await prisma.article.findMany({ where: { id: { in: orderedIds } }, select: articleSelectBase });
        const byId = new Map(unreadArticles.map((item: any) => [item.id, item]));
        const sortedArticles = orderedIds.map((id) => byId.get(id)).filter(Boolean) as any[];
        const articleIds = sortedArticles.map((item: any) => item.id);

        let likedIdSet = new Set<number>();
        if (articleIds.length) {
          const likedRows = (await prisma.$queryRaw(Prisma.sql`SELECT "article_id" FROM "user_article_likes" WHERE "user_id" = ${userId} AND "article_id" IN (${Prisma.join(articleIds)})`)) as Array<{ article_id: number }>;
          likedIdSet = new Set(likedRows.map((row) => row.article_id));
        }

        const [articleTagsMap, articleAiCategoryMap, articleFinanceMap, articleImportanceMap] = await Promise.all([
          buildArticleTagsMap(userId, articleIds),
          buildArticleAiCategoryMap(articleIds),
          buildArticleFinanceMap(articleIds),
          buildArticleImportanceMap(articleIds),
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
          fulltext_status: item.fulltext_status || null,
          feed_title: item.feeds?.title || '',
          is_read: false,
          is_liked: likedIdSet.has(item.id),
          tags: articleTagsMap.get(item.id) || [],
          ai_category: articleAiCategoryMap.get(item.id) ?? null,
          finance_instruments: articleFinanceMap.get(item.id) || [],
          importance: articleImportanceMap.get(item.id) ?? null,
        }));

        return { articles: mappedArticles, total: totalCount };
      }

      // pub_date 排序依赖 SQL CASE（无发布时间/未来时间回退入库时间），Prisma orderBy 无法表达
      if (articleSortBy === 'pub_date') {
        const scopedFeedIds = await resolveFeedIdsForArticleWhere(articleWhere, userId, {
          groupId,
          ungroupedOnly,
        });
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

        let searchFilterSql = Prisma.empty;
        if (hasSearch) {
          const like = `%${searchQuery}%`;
          searchFilterSql = Prisma.sql` AND (
            a."title" ILIKE ${like}
            OR a."description" ILIKE ${like}
            OR a."author" ILIKE ${like}
            OR a."title_zh" ILIKE ${like}
            OR a."description_zh" ILIKE ${like}
          )`;
        }

        const listRows = (await prisma.$queryRaw(Prisma.sql`
          SELECT a."id" AS article_id
          FROM "articles" a
          ${articleSortSql.joinSql}
          WHERE a."feed_id" IN (${Prisma.join(scopedFeedIds)})
            ${todayFilterSql}
            ${searchFilterSql}
            ${minStarsFilterSql}
            ${dedupeFilterSql}
          ${articleSortSql.orderSql}
          LIMIT ${limit} OFFSET ${offset}
        `)) as Array<{ article_id: number }>;

        const totalRows = (await prisma.$queryRaw(Prisma.sql`
          SELECT COUNT(*)::int AS c
          FROM "articles" a
          WHERE a."feed_id" IN (${Prisma.join(scopedFeedIds)})
            ${todayFilterSql}
            ${searchFilterSql}
            ${minStarsFilterSql}
            ${dedupeFilterSql}
        `)) as Array<{ c: number }>;
        const listTotal = Number(totalRows[0]?.c || 0);
        const orderedIds = listRows.map((r) => Number(r.article_id)).filter((id) => Number.isFinite(id));
        if (!orderedIds.length) return { articles: [], total: listTotal };

        const pageArticles = await prisma.article.findMany({
          where: { id: { in: orderedIds } },
          select: articleSelectBase,
        });
        const byId = new Map(pageArticles.map((item: any) => [item.id, item]));
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

        const [articleTagsMap, articleAiCategoryMap, articleFinanceMap, articleImportanceMap] = await Promise.all([
          buildArticleTagsMap(userId, articleIds),
          buildArticleAiCategoryMap(articleIds),
          buildArticleFinanceMap(articleIds),
          buildArticleImportanceMap(articleIds),
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
          fulltext_status: item.fulltext_status || null,
          feed_title: item.feeds?.title || '',
          is_read: readIdSet.has(item.id),
          is_liked: likedIdSet.has(item.id),
          tags: articleTagsMap.get(item.id) || [],
          ai_category: articleAiCategoryMap.get(item.id) ?? null,
          finance_instruments: articleFinanceMap.get(item.id) || [],
          importance: articleImportanceMap.get(item.id) ?? null,
        }));

        return { articles: mappedArticles, total: listTotal };
      }

      const listOrderBy = buildPrismaArticleOrderBy(articleSortBy, articleSortDir);

      const [listTotal, articles] = await Promise.all([
        prisma.article.count({ where: articleWhere }),
        prisma.article.findMany({
          where: articleWhere,
          select: articleSelectBase,
          orderBy: listOrderBy as any,
          skip: offset,
          take: limit,
        }),
      ]);

      // 排序已由数据库完成，保持返回顺序
      const sortedArticles = articles as any[];
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

      const [articleTagsMap, articleAiCategoryMap, articleFinanceMap, articleImportanceMap] = await Promise.all([
        buildArticleTagsMap(userId, articleIds),
        buildArticleAiCategoryMap(articleIds),
        buildArticleFinanceMap(articleIds),
        buildArticleImportanceMap(articleIds),
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
        fulltext_status: item.fulltext_status || null,
        feed_title: item.feeds?.title || '',
        is_read: readIdSet.has(item.id),
        is_liked: likedIdSet.has(item.id),
        tags: articleTagsMap.get(item.id) || [],
        ai_category: articleAiCategoryMap.get(item.id) ?? null,
        finance_instruments: articleFinanceMap.get(item.id) || [],
        importance: articleImportanceMap.get(item.id) ?? null,
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

  /** 查重簇：按自然日聚合近重复标题（member_count DESC） */
  fastify.get('/articles/dup-clusters', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const query = req.query as {
      day?: string;
      groupId?: string;
      feedId?: string;
      publicSubscriptionId?: string;
      ungrouped?: string;
      limit?: string;
    };

    const dayRaw = String(query.day || '').trim();
    const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayRaw);
    let runDayStr: string;
    if (dayMatch) {
      runDayStr = dayRaw;
    } else {
      const now = new Date();
      runDayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }
    const [yy, mm, dd] = runDayStr.split('-').map((x) => Number(x));
    const runDayDate = new Date(Date.UTC(yy!, mm! - 1, dd!));
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 100));

    const ungroupedOnly = query.ungrouped === '1' || query.ungrouped === 'true';
    const groupId = query.groupId ? Number(query.groupId) : null;
    let feedId = query.feedId ? Number(query.feedId) : null;
    const publicSubscriptionIdRaw = query.publicSubscriptionId
      ? Number(query.publicSubscriptionId)
      : null;
    if (publicSubscriptionIdRaw != null && Number.isFinite(publicSubscriptionIdRaw)) {
      feedId = -publicSubscriptionIdRaw;
    }

    try {
      let privateFeedIds: number[] = [];
      let publicFeedIds: number[] = [];

      if (feedId != null && Number.isFinite(feedId)) {
        if (feedId < 0) {
          const sub = await prisma.userFeedSubscription.findFirst({
            where: {
              id: -feedId,
              user_id: userId,
              is_active: true,
              ...(groupId != null ? { group_id: groupId } : ungroupedOnly ? { group_id: null } : {}),
            },
            select: { public_feed_id: true },
          });
          if (sub) publicFeedIds = [sub.public_feed_id];
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
          if (feed) privateFeedIds = [feed.id];
        }
      } else {
        const groupFilter =
          ungroupedOnly ? { group_id: null } : groupId != null ? { group_id: groupId } : {};
        const [feeds, subs] = await Promise.all([
          prisma.feed.findMany({
            where: { user_id: userId, public_feed_id: null, ...groupFilter },
            select: { id: true },
          }),
          prisma.userFeedSubscription.findMany({
            where: { user_id: userId, is_active: true, ...groupFilter },
            select: { public_feed_id: true },
          }),
        ]);
        privateFeedIds = feeds.map((f: { id: number }) => f.id);
        publicFeedIds = subs.map((s: { public_feed_id: number }) => s.public_feed_id);
      }

      if (!privateFeedIds.length && !publicFeedIds.length) {
        return res.send({ day: runDayStr, clusters: [], checked: false });
      }

      const ownershipSql =
        privateFeedIds.length && publicFeedIds.length
          ? Prisma.sql`(a."feed_id" IN (${Prisma.join(privateFeedIds)}) OR a."public_feed_id" IN (${Prisma.join(publicFeedIds)}))`
          : privateFeedIds.length
            ? Prisma.sql`a."feed_id" IN (${Prisma.join(privateFeedIds)})`
            : Prisma.sql`a."public_feed_id" IN (${Prisma.join(publicFeedIds)})`;

      const dayStart = new Date(yy!, mm! - 1, dd!, 0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      const clusterRows = (await prisma.$queryRaw(Prisma.sql`
        SELECT c."id", c."run_day", c."primary_article_id", c."member_count", c."sample_title",
               c."created_at", c."updated_at"
        FROM "article_dup_clusters" c
        WHERE c."run_day" = ${runDayDate}::date
          AND c."member_count" >= 2
          AND EXISTS (
            SELECT 1 FROM "articles" a
            WHERE a."dup_cluster_id" = c."id" AND ${ownershipSql}
          )
        ORDER BY c."member_count" DESC, c."id" ASC
        LIMIT ${limit}
      `)) as Array<{
        id: number;
        run_day: Date;
        primary_article_id: number;
        member_count: number;
        sample_title: string;
        created_at: Date;
        updated_at: Date;
      }>;

      const ownershipWhere: any = {
        OR: [
          ...(privateFeedIds.length ? [{ feed_id: { in: privateFeedIds } }] : []),
          ...(publicFeedIds.length ? [{ public_feed_id: { in: publicFeedIds } }] : []),
        ],
      };

      const checkedCount = await prisma.article.count({
        where: {
          AND: [
            ownershipWhere,
            { dup_checked_at: { not: null } },
            {
              OR: [
                { pub_date: { gte: dayStart, lt: dayEnd } },
                { AND: [{ pub_date: null }, { created_at: { gte: dayStart, lt: dayEnd } }] },
              ],
            },
          ],
        },
      });

      if (!clusterRows.length) {
        return res.send({
          day: runDayStr,
          clusters: [],
          checked: checkedCount > 0,
        });
      }

      const clusterIds = clusterRows.map((c) => c.id);
      const members = await prisma.article.findMany({
        where: {
          dup_cluster_id: { in: clusterIds },
          ...ownershipWhere,
        },
        select: {
          id: true,
          title: true,
          title_zh: true,
          url: true,
          pub_date: true,
          created_at: true,
          dup_cluster_id: true,
          dup_is_primary: true,
          feeds: { select: { title: true } },
          public_feed: { select: { title: true } },
        },
        orderBy: [{ pub_date: 'asc' }, { created_at: 'asc' }, { id: 'asc' }],
      });

      const membersByCluster = new Map<number, typeof members>();
      for (const m of members) {
        const cid = m.dup_cluster_id!;
        const list = membersByCluster.get(cid) || [];
        list.push(m);
        membersByCluster.set(cid, list);
      }

      type MemberRow = (typeof members)[number];
      const clusters = clusterRows.map((c) => {
        const list: MemberRow[] = membersByCluster.get(c.id) || [];
        const primary = list.find((m: MemberRow) => m.dup_is_primary) || list[0] || null;
        return {
          id: c.id,
          run_day: runDayStr,
          member_count: list.length || c.member_count,
          sample_title: c.sample_title,
          primary: primary
            ? {
                id: primary.id,
                title: primary.title_zh || primary.title,
                url: primary.url,
                pub_date: primary.pub_date,
                created_at: primary.created_at,
                feed_title: primary.feeds?.title || primary.public_feed?.title || '',
              }
            : null,
          members: list.map((m: (typeof list)[number]) => ({
            id: m.id,
            title: m.title_zh || m.title,
            url: m.url,
            pub_date: m.pub_date,
            created_at: m.created_at,
            is_primary: m.dup_is_primary,
            feed_title: m.feeds?.title || m.public_feed?.title || '',
          })),
        };
      });

      return res.send({
        day: runDayStr,
        clusters,
        checked: checkedCount > 0 || clusters.length > 0,
      });
    } catch (error: any) {
      req.log.error(error);
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  // 获取单篇文章详情（按需返回 content / fulltext，避免列表接口传大字段）
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
          public_feed_id: true,
          title: true,
          title_zh: true,
          description: true,
          description_zh: true,
          content: true,
          url: true,
          author: true,
          pub_date: true,
          created_at: true,
          fulltext_status: true,
          feeds: {
            select: {
              id: true,
              title: true,
              user_id: true,
              needs_translation: true,
            },
          },
          public_feed: {
            select: {
              id: true,
              title: true,
              subscriptions: {
                where: { user_id: userId, is_active: true },
                select: { id: true, needs_translation: true },
                take: 1,
              },
            },
          },
          fulltext: {
            select: {
              status: true,
              body_html: true,
              body_text: true,
              word_count: true,
              extractor: true,
              final_url: true,
              fetched_at: true,
              body_html_zh: true,
              body_text_zh: true,
              translation_status: true,
              translation_error: true,
              translated_at: true,
              translation_segments: true,
            },
          },
        },
      });
      if (!article) {
        return res.status(404).send({ error: '文章不存在' });
      }

      const ownsPrivate = !!(article.feeds && article.feeds.user_id === userId);
      const ownsPublic = !!(article.public_feed && article.public_feed.subscriptions.length > 0);
      if (!ownsPrivate && !ownsPublic) {
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

      const ft = article.fulltext;
      const fulltextHtml =
        ft && ft.status === 'success' ? ft.body_html || null : null;
      const fulltextHtmlZh =
        ft && ft.translation_status === 'success' ? ft.body_html_zh || null : null;
      const needsTranslation = ownsPrivate
        ? article.feeds?.needs_translation === true
        : article.public_feed?.subscriptions?.[0]?.needs_translation === true;

      return {
        article: {
          id: article.id,
          feed_id: article.feed_id,
          public_feed_id: article.public_feed_id,
          title: article.title,
          title_zh: article.title_zh,
          description: article.description,
          description_zh: article.description_zh,
          content: article.content,
          // 权威正文：优先 fulltext
          fulltext_html: fulltextHtml,
          fulltext_status: article.fulltext_status || ft?.status || null,
          fulltext_word_count: ft?.word_count ?? null,
          fulltext_extractor: ft?.extractor ?? null,
          fulltext_html_zh: fulltextHtmlZh,
          fulltext_translation_status: ft?.translation_status || null,
          fulltext_translation_error: ft?.translation_error || null,
          fulltext_translation_segments:
            ft && ft.translation_status === 'success' && Array.isArray(ft.translation_segments)
              ? ft.translation_segments
              : null,
          needs_translation: !!needsTranslation,
          url: article.url,
          author: article.author,
          pub_date: article.pub_date,
          created_at: article.created_at,
          feed_title: article.feeds?.title || article.public_feed?.title || '',
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

  // 翻译单篇正文（按段落对齐；force 可重翻）
  fastify.post('/articles/:articleId/fulltext/translate', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const articleId = Number(req.params.articleId);
    if (!Number.isFinite(articleId)) {
      return res.status(400).send({ error: 'articleId 无效' });
    }

    const body = (req.body || {}) as { force?: boolean; auto?: boolean };
    try {
      const result = await translateArticleFulltextForUser(articleId, userId, {
        force: body.force === true,
        auto: body.auto === true,
      });
      return {
        success: result.translation_status === 'success',
        ...result,
      };
    } catch (error: any) {
      req.log.error(error);
      const message = error instanceof Error ? error.message : '正文翻译失败';
      const statusCode = Number(error?.statusCode) || (
        message.includes('不存在') ? 404
          : message.includes('权限') || message.includes('未开启') ? 403
            : message.includes('配置') || message.includes('抓取') ? 400
              : 500
      );
      return res.status(statusCode).send({ error: message });
    }
  });

  // 手动抓取单篇原文正文（同步，force 覆盖已有成功结果）
  fastify.post('/articles/:articleId/fulltext', async (req: any, res: any) => {
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
          url: true,
          feeds: { select: { user_id: true } },
          public_feed: {
            select: {
              subscriptions: {
                where: { user_id: userId, is_active: true },
                select: { id: true },
                take: 1,
              },
            },
          },
        },
      });
      if (!article) {
        return res.status(404).send({ error: '文章不存在' });
      }
      const ownsPrivate = !!(article.feeds && article.feeds.user_id === userId);
      const ownsPublic = !!(article.public_feed && article.public_feed.subscriptions.length > 0);
      if (!ownsPrivate && !ownsPublic) {
        return res.status(403).send({ error: '无权限操作该文章' });
      }

      const result = await fetchArticleFulltext(articleId, { force: true });
      let fulltextHtml: string | null = null;
      let wordCount: number | null = result.wordCount ?? null;
      if (result.status === 'success') {
        const row = await prisma.articleFulltext.findUnique({
          where: { article_id: articleId },
          select: { body_html: true, word_count: true },
        });
        fulltextHtml = row?.body_html || null;
        if (row?.word_count != null) wordCount = row.word_count;
      }

      return {
        success: result.status === 'success',
        status: result.status,
        error: result.error || null,
        fulltext_status: result.status,
        fulltext_html: fulltextHtml,
        fulltext_word_count: wordCount,
      };
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

      const tags = await listArticleTagsForUser(userId, articleId);
      return { ok: true, tags };
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
          orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
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
      const sortAgg = await prisma.userFeedGroup.aggregate({
        where: { user_id: userId },
        _max: { sort_order: true },
      });
      const nextSortOrder = (sortAgg._max.sort_order ?? -1) + 1;

      const group = await prisma.userFeedGroup.create({
        data: {
          user_id: userId,
          name: cleanName,
          icon: cleanIcon,
          sort_order: nextSortOrder,
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

  // 分组拖拽排序
  fastify.put('/groups/reorder', async (req: any, res: any) => {
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
      const owned = await prisma.userFeedGroup.findMany({
        where: { user_id: userId },
        select: { id: true },
      });
      const ownedIds = new Set(owned.map((item: { id: number }) => item.id));
      if (orderedIds.some((id) => !ownedIds.has(id))) {
        return res.status(400).send({ error: 'ordered_ids 含不属于当前用户的分组' });
      }
      if (orderedIds.length !== ownedIds.size) {
        return res.status(400).send({ error: 'ordered_ids 必须包含当前用户全部真实分组' });
      }

      const now = new Date();
      await prisma.$transaction(
        orderedIds.map((groupId, index) =>
          prisma.userFeedGroup.update({
            where: { id: groupId },
            data: { sort_order: index * 10, updated_at: now },
          })
        )
      );

      const groups = await prisma.userFeedGroup.findMany({
        where: { user_id: userId },
        orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
      });
      return { groups };
    } catch (error: any) {
      req.log.error(error);
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

    const { name, color, icon, importance: importanceRaw, keywords: keywordsRaw } = req.body as {
      name?: string;
      color?: string;
      icon?: string;
      importance?: number;
      keywords?: unknown;
    };
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      return res.status(400).send({ error: '主题名称不能为空' });
    }
    if (cleanName.length > 50) {
      return res.status(400).send({ error: '主题名称不能超过 50 字符' });
    }

    const colorInput = normalizeTagColor(color);
    if (color !== undefined && color !== null && String(color).trim() && colorInput === undefined) {
      return res.status(400).send({ error: 'color 格式无效，须为 #RGB 或 #RRGGBB' });
    }
    const cleanIcon = normalizeGroupIcon(icon);
    const importance = clampThemeImportance(
      importanceRaw !== undefined ? importanceRaw : 3,
      3,
    );
    if (
      importanceRaw !== undefined &&
      (!Number.isInteger(Number(importanceRaw)) ||
        Number(importanceRaw) < 1 ||
        Number(importanceRaw) > 5)
    ) {
      return res.status(400).send({ error: 'importance 须为 1–5 的整数' });
    }
    const keywords = normalizeThemeKeywordList(keywordsRaw);

    try {
      const tag = await prisma.userTag.create({
        data: {
          user_id: userId,
          name: cleanName,
          color: colorInput === undefined ? null : colorInput,
          icon: cleanIcon,
          importance,
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
      const savedKeywords = await replaceThemeKeywords(tag.id, keywords);
      // 有关键词时默认全量回扫，把历史文章能关联的都挂上
      if (savedKeywords.length) {
        await addThemeBackfillJob(userId, { tagId: tag.id });
      }
      return {
        tag: formatTagResponse({ ...tag, keywords: savedKeywords }),
        rematch_queued: savedKeywords.length > 0,
      };
    } catch (error: any) {
      req.log.error(error);
      if (error?.code === 'P2002') {
        return res.status(409).send({ error: '主题名称已存在' });
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

    const {
      name,
      color,
      icon,
      sort_order: sortOrderRaw,
      importance: importanceRaw,
      keywords: keywordsRaw,
    } = req.body as {
      name?: string;
      color?: string | null;
      icon?: string;
      sort_order?: number;
      importance?: number;
      keywords?: unknown;
    };

    if (
      name === undefined &&
      color === undefined &&
      icon === undefined &&
      sortOrderRaw === undefined &&
      importanceRaw === undefined &&
      keywordsRaw === undefined
    ) {
      return res.status(400).send({ error: '至少提供一个可更新字段' });
    }

    const updateData: {
      name?: string;
      color?: string | null;
      icon?: string | null;
      sort_order?: number;
      importance?: number;
      updated_at: Date;
    } = { updated_at: new Date() };

    if (name !== undefined) {
      const cleanName = String(name || '').trim();
      if (!cleanName) {
        return res.status(400).send({ error: '主题名称不能为空' });
      }
      if (cleanName.length > 50) {
        return res.status(400).send({ error: '主题名称不能超过 50 字符' });
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

    if (importanceRaw !== undefined) {
      if (
        !Number.isInteger(Number(importanceRaw)) ||
        Number(importanceRaw) < 1 ||
        Number(importanceRaw) > 5
      ) {
        return res.status(400).send({ error: 'importance 须为 1–5 的整数' });
      }
      updateData.importance = clampThemeImportance(importanceRaw, 3);
    }

    try {
      const existing = await prisma.userTag.findFirst({
        where: { id: tagId, user_id: userId },
        select: { id: true },
      });
      if (!existing) {
        return res.status(404).send({ error: '主题不存在' });
      }

      const tag = await prisma.userTag.update({
        where: { id: tagId },
        data: updateData,
      });

      let keywords: string[] | undefined;
      let keywordsChanged = false;
      if (keywordsRaw !== undefined) {
        if (!Array.isArray(keywordsRaw)) {
          return res.status(400).send({ error: 'keywords 必须为数组' });
        }
        keywords = await replaceThemeKeywords(tagId, normalizeThemeKeywordList(keywordsRaw));
        keywordsChanged = true;
      } else {
        const rows = await prisma.userTagKeyword.findMany({
          where: { tag_id: tagId },
          select: { keyword: true },
          orderBy: { id: 'asc' },
        });
        keywords = rows.map((r: { keyword: string }) => r.keyword);
      }

      if (keywordsChanged) {
        await addThemeBackfillJob(userId, { tagId });
      }

      return {
        tag: formatTagResponse({ ...tag, keywords }),
        rematch_queued: keywordsChanged,
      };
    } catch (error: any) {
      req.log.error(error);
      if (error?.code === 'P2002') {
        return res.status(409).send({ error: '主题名称已存在' });
      }
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  /** 查询主题全量关联进度 */
  fastify.get('/tags/:tagId/rematch', async (req: any, res: any) => {
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
        return res.status(404).send({ error: '主题不存在' });
      }
      const progress = getThemeRematchProgress(userId, tagId);
      return {
        progress: progress || {
          status: 'idle',
          scanned: 0,
          total: 0,
          matched: 0,
          percent: 0,
          updated_at: Date.now(),
          started_at: null,
          finished_at: null,
          error: null,
          tag_id: tagId,
          user_id: userId,
        },
      };
    } catch (error: any) {
      req.log.error(error);
      const mapped = getSubscriptionRouteError(error);
      return res.status(mapped.statusCode).send({ error: mapped.message });
    }
  });

  /** 手动触发：用该主题关键词全量回扫可见文章并重建 auto 关联 */
  fastify.post('/tags/:tagId/rematch', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    const tagId = Number(req.params.tagId);
    if (!Number.isFinite(tagId)) {
      return res.status(400).send({ error: 'tagId 无效' });
    }

    try {
      const existing = await prisma.userTag.findFirst({
        where: { id: tagId, user_id: userId },
        select: {
          id: true,
          name: true,
          keywords: { select: { id: true }, take: 1 },
        },
      });
      if (!existing) {
        return res.status(404).send({ error: '主题不存在' });
      }
      if (!existing.keywords.length) {
        return res.status(400).send({ error: '该主题尚无关键词，请先添加关键词再关联' });
      }

      const current = getThemeRematchProgress(userId, tagId);
      if (current && (current.status === 'queued' || current.status === 'running')) {
        return {
          ok: true,
          queued: true,
          already_running: true,
          tag_id: tagId,
          progress: current,
          message: `关联进行中 ${current.percent}%（${current.scanned}/${current.total || '?'}）`,
        };
      }

      const job = await addThemeBackfillJob(userId, { tagId });
      const progress = getThemeRematchProgress(userId, tagId);
      return {
        ok: true,
        queued: !!job,
        tag_id: tagId,
        progress: progress || null,
        message: job
          ? '已开始全量关联，可在主题菜单查看进度'
          : '关联任务未能入队（可能队列未启用），请稍后重试',
      };
    } catch (error: any) {
      req.log.error(error);
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
        return res.status(404).send({ error: '主题不存在' });
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

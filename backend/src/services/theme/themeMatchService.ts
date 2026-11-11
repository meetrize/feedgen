import type { Prisma } from '@prisma/client';
import { prisma } from '../../server';
import { normalizeThemeKeyword, normalizeThemeMatchText } from './themeKeywordNorm';
import {
  markThemeRematchDone,
  markThemeRematchFailed,
  markThemeRematchRunning,
  updateThemeRematchProgress,
} from './themeRematchProgress';

/** 全量回扫时每批文章数；limit 未传时扫完全部可见文章 */
const BACKFILL_BATCH_SIZE = 200;

type ThemeKeywordRow = {
  tag_id: number;
  keyword: string;
  keyword_norm: string;
};

export type ThemeBackfillOptions = {
  /** 限制扫描篇数；不传则扫全部 */
  limit?: number;
  /** 仅重算某一个主题的 auto 关联 */
  tagId?: number;
};

function buildMatchCorpus(article: {
  title?: string | null;
  title_zh?: string | null;
  description?: string | null;
  description_zh?: string | null;
}): string {
  return normalizeThemeMatchText(
    [article.title, article.title_zh, article.description, article.description_zh]
      .filter(Boolean)
      .join('\n'),
  );
}

function matchThemeIds(
  corpus: string,
  keywords: ThemeKeywordRow[],
): Map<number, string> {
  const hits = new Map<number, string>();
  if (!corpus) return hits;
  for (const row of keywords) {
    if (hits.has(row.tag_id)) continue;
    const norm = row.keyword_norm || normalizeThemeKeyword(row.keyword);
    if (!norm || norm.length < 2) continue;
    if (corpus.includes(norm)) {
      hits.set(row.tag_id, row.keyword);
    }
  }
  return hits;
}

async function loadUserThemeKeywords(
  userId: number,
  tagId?: number,
): Promise<ThemeKeywordRow[]> {
  const rows = await prisma.userTagKeyword.findMany({
    where: {
      tag: { user_id: userId },
      ...(tagId != null ? { tag_id: tagId } : {}),
    },
    select: { tag_id: true, keyword: true, keyword_norm: true },
  });
  return rows;
}

function userVisibleArticleWhere(userId: number): Prisma.ArticleWhereInput {
  return {
    OR: [
      { feeds: { user_id: userId, public_feed_id: null } },
      {
        public_feed: {
          subscriptions: { some: { user_id: userId, is_active: true } },
        },
      },
    ],
  };
}

/** 解析文章应对哪些用户做主题匹配 */
export async function resolveThemeMatchUserIds(articleId: number): Promise<number[]> {
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: {
      feed_id: true,
      public_feed_id: true,
      feeds: { select: { user_id: true, public_feed_id: true } },
    },
  });
  if (!article) return [];

  const userIds = new Set<number>();

  if (article.feeds?.user_id && !article.feeds.public_feed_id) {
    userIds.add(article.feeds.user_id);
  }

  const publicFeedId = article.public_feed_id || article.feeds?.public_feed_id || null;
  if (publicFeedId) {
    const subs = await prisma.userFeedSubscription.findMany({
      where: { public_feed_id: publicFeedId, is_active: true },
      select: { user_id: true },
    });
    for (const sub of subs) userIds.add(sub.user_id);
  }

  return [...userIds];
}

/** 对单用户 + 单篇文章重建 source=auto 主题关联（保留 manual） */
export async function matchThemesForUserArticle(
  userId: number,
  articleId: number,
): Promise<{ matched: number }> {
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: { id: true, title: true, title_zh: true, description: true, description_zh: true },
  });
  if (!article) return { matched: 0 };

  const keywords = await loadUserThemeKeywords(userId);
  if (!keywords.length) {
    await prisma.userArticleTag.deleteMany({
      where: { user_id: userId, article_id: articleId, source: 'auto' },
    });
    return { matched: 0 };
  }

  const corpus = buildMatchCorpus(article);
  const hitMap = matchThemeIds(corpus, keywords);
  const matchedTagIds = [...hitMap.keys()];

  const existingManual = await prisma.userArticleTag.findMany({
    where: { user_id: userId, article_id: articleId, source: 'manual' },
    select: { tag_id: true },
  });
  const manualSet = new Set(existingManual.map((r: { tag_id: number }) => r.tag_id));

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.userArticleTag.deleteMany({
      where: { user_id: userId, article_id: articleId, source: 'auto' },
    });
    const toInsert = matchedTagIds.filter((tagId) => !manualSet.has(tagId));
    if (toInsert.length) {
      await tx.userArticleTag.createMany({
        data: toInsert.map((tagId) => ({
          user_id: userId,
          article_id: articleId,
          tag_id: tagId,
          source: 'auto',
        })),
        skipDuplicates: true,
      });
    }
  });

  return { matched: matchedTagIds.length };
}

/** 新文章：对所有相关用户做主题匹配 */
export async function matchThemesForArticle(articleId: number): Promise<{ users: number; matched: number }> {
  const userIds = await resolveThemeMatchUserIds(articleId);
  let matched = 0;
  for (const userId of userIds) {
    const result = await matchThemesForUserArticle(userId, articleId);
    matched += result.matched;
  }
  return { users: userIds.length, matched };
}

/**
 * 主题关键词变更 / 手动处理后：回扫用户可见文章并重建 source=auto 关联。
 * 默认扫全部；可传 limit 限制篇数，或 tagId 仅重算某一个主题。
 */
export async function backfillThemesForUser(
  userId: number,
  options: ThemeBackfillOptions | number = {},
): Promise<{ scanned: number; matched: number; total: number }> {
  const opts: ThemeBackfillOptions =
    typeof options === 'number' ? { limit: options } : options || {};
  const tagId =
    opts.tagId != null && Number.isInteger(opts.tagId) && opts.tagId > 0
      ? opts.tagId
      : undefined;
  const maxScan =
    opts.limit != null && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : null;

  try {
    const keywords = await loadUserThemeKeywords(userId, tagId);
    const hasKeywords = keywords.length > 0;
    const scopedTagIds = tagId != null ? [tagId] : null;
    const visibleWhere = userVisibleArticleWhere(userId);
    const totalCount = await prisma.article.count({ where: visibleWhere });
    const total = maxScan != null ? Math.min(totalCount, maxScan) : totalCount;
    const progressTagId = tagId ?? null;

    markThemeRematchRunning(userId, { tagId: progressTagId, total });

    // 无关键词时：清掉对应 auto 关联后结束
    if (!hasKeywords) {
      await prisma.userArticleTag.deleteMany({
        where: {
          user_id: userId,
          source: 'auto',
          ...(scopedTagIds ? { tag_id: { in: scopedTagIds } } : {}),
        },
      });
      markThemeRematchDone(userId, {
        tagId: progressTagId,
        scanned: 0,
        total,
        matched: 0,
      });
      return { scanned: 0, matched: 0, total };
    }

    let scanned = 0;
    let matchedTotal = 0;
    let cursorId: number | null = null;

    type BackfillArticleRow = {
      id: number;
      title: string;
      title_zh: string | null;
      description: string | null;
      description_zh: string | null;
    };

    while (true) {
      const remaining = maxScan != null ? maxScan - scanned : BACKFILL_BATCH_SIZE;
      if (remaining <= 0) break;
      const take = Math.min(BACKFILL_BATCH_SIZE, remaining);

      const articles: BackfillArticleRow[] = await prisma.article.findMany({
        where: {
          ...visibleWhere,
          ...(cursorId != null ? { id: { lt: cursorId } } : {}),
        },
        orderBy: [{ id: 'desc' }],
        take,
        select: {
          id: true,
          title: true,
          title_zh: true,
          description: true,
          description_zh: true,
        },
      });
      if (!articles.length) break;

      const articleIds = articles.map((a: { id: number }) => a.id);
      const manualRows = await prisma.userArticleTag.findMany({
        where: {
          user_id: userId,
          article_id: { in: articleIds },
          source: 'manual',
          ...(scopedTagIds ? { tag_id: { in: scopedTagIds } } : {}),
        },
        select: { article_id: true, tag_id: true },
      });
      const manualByArticle = new Map<number, Set<number>>();
      for (const row of manualRows as Array<{ article_id: number; tag_id: number }>) {
        let set = manualByArticle.get(row.article_id);
        if (!set) {
          set = new Set<number>();
          manualByArticle.set(row.article_id, set);
        }
        set.add(row.tag_id);
      }

      const toInsert: Array<{
        user_id: number;
        article_id: number;
        tag_id: number;
        source: string;
      }> = [];
      const hitArticleIds: number[] = [];

      for (const article of articles) {
        const corpus = buildMatchCorpus(article);
        const hitMap = matchThemeIds(corpus, keywords);
        const matchedTagIds = [...hitMap.keys()];
        matchedTotal += matchedTagIds.length;
        hitArticleIds.push(article.id);
        const manualSet = manualByArticle.get(article.id) || new Set<number>();
        for (const matchedTagId of matchedTagIds) {
          if (manualSet.has(matchedTagId)) continue;
          toInsert.push({
            user_id: userId,
            article_id: article.id,
            tag_id: matchedTagId,
            source: 'auto',
          });
        }
      }

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.userArticleTag.deleteMany({
          where: {
            user_id: userId,
            article_id: { in: hitArticleIds },
            source: 'auto',
            ...(scopedTagIds ? { tag_id: { in: scopedTagIds } } : {}),
          },
        });
        if (toInsert.length) {
          await tx.userArticleTag.createMany({
            data: toInsert,
            skipDuplicates: true,
          });
        }
      });

      scanned += articles.length;
      updateThemeRematchProgress(userId, {
        tagId: progressTagId,
        scanned,
        total,
        matched: matchedTotal,
      });
      const last = articles[articles.length - 1];
      if (!last) break;
      cursorId = last.id;
      if (articles.length < take) break;
    }

    markThemeRematchDone(userId, {
      tagId: progressTagId,
      scanned,
      total: total || scanned,
      matched: matchedTotal,
    });
    return { scanned, matched: matchedTotal, total: total || scanned };
  } catch (error) {
    const failedTagId =
      typeof options === 'number' ? null : options?.tagId != null ? options.tagId : null;
    markThemeRematchFailed(userId, {
      tagId: failedTagId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** 替换主题关键词列表；返回规范化后的关键词文案 */
export async function replaceThemeKeywords(
  tagId: number,
  keywords: string[],
): Promise<string[]> {
  const rows = keywords
    .map((keyword) => {
      const clean = String(keyword || '').trim().slice(0, 80);
      const keyword_norm = normalizeThemeKeyword(clean);
      return clean && keyword_norm ? { tag_id: tagId, keyword: clean, keyword_norm } : null;
    })
    .filter((row): row is { tag_id: number; keyword: string; keyword_norm: string } => !!row);

  const deduped: { tag_id: number; keyword: string; keyword_norm: string }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.keyword_norm)) continue;
    seen.add(row.keyword_norm);
    deduped.push(row);
  }

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.userTagKeyword.deleteMany({ where: { tag_id: tagId } });
    if (deduped.length) {
      await tx.userTagKeyword.createMany({ data: deduped });
    }
  });

  return deduped.map((r) => r.keyword);
}

import { getPrisma } from '../../server';
import { getEffectiveTranslationConfig } from './translationConfig';
import { isTranslationEnabled, textTranslateEnToZh } from './translateClient';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** OpenAI/DeepSeek 网页桥批量翻译时，文章之间再额外歇一会 */
async function pauseBetweenBatchArticles(userId: number, index: number): Promise<void> {
  if (index <= 0) return;
  const config = await getEffectiveTranslationConfig(userId);
  if (config?.provider !== 'openai' && config?.provider !== 'gemini') return;
  const extraMs = Math.max(
    0,
    Number(process.env.TRANSLATE_BATCH_ARTICLE_GAP_MS || (config.provider === 'openai' ? 4000 : 0)) ||
      0,
  );
  if (extraMs > 0) {
    await sleep(extraMs);
  }
}

export type NewArticleForTranslation = {
  id: number;
  title: string;
  description: string | null;
};

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export type TranslateArticleResult = {
  title_zh: string | null;
  description_zh: string | null;
};

async function translateSingleArticle(
  userId: number,
  articleId: number,
  title: string,
  description: string | null,
): Promise<TranslateArticleResult> {
  const prisma = await getPrisma();
  const normalizedTitle = title.trim();
  const titleZh = normalizedTitle ? await textTranslateEnToZh(userId, normalizedTitle) : null;
  let descriptionZh: string | null = null;

  if (description) {
    const plain = stripHtmlTags(description);
    if (plain) {
      // 很多源（如美联储）标题与摘要完全相同，避免同一提示词请求两次
      if (normalizedTitle && plain === normalizedTitle) {
        descriptionZh = titleZh;
      } else {
        descriptionZh = await textTranslateEnToZh(userId, plain);
      }
    }
  }

  const normalizedTitleZh = titleZh ? titleZh.slice(0, 500) : null;
  await prisma.article.update({
    where: { id: articleId },
    data: {
      title_zh: normalizedTitleZh,
      description_zh: descriptionZh,
      updated_at: new Date(),
    },
  });

  return {
    title_zh: normalizedTitleZh,
    description_zh: descriptionZh,
  };
}

export async function translateArticleForUser(
  articleId: number,
  userId: number,
): Promise<TranslateArticleResult> {
  if (!(await isTranslationEnabled(userId))) {
    throw new Error('请先在设置页配置并启用翻译服务');
  }

  const prisma = await getPrisma();
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: {
      id: true,
      title: true,
      description: true,
      feed_id: true,
      feeds: { select: { user_id: true, needs_translation: true } },
    },
  });

  if (!article) {
    throw new Error('文章不存在');
  }
  if (!article.feeds || article.feeds.user_id !== userId) {
    throw new Error('无权限操作该文章');
  }
  if (!article.feeds.needs_translation) {
    throw new Error('该 Feed 未开启需要翻译');
  }

  return translateSingleArticle(userId, article.id, article.title, article.description);
}

export async function translateNewArticlesForFeed(
  feedId: number,
  articles: NewArticleForTranslation[],
): Promise<void> {
  if (!articles.length) return;

  const prisma = await getPrisma();
  const feed = await prisma.feed.findUnique({
    where: { id: feedId },
    select: { needs_translation: true, user_id: true },
  });
  if (!feed?.needs_translation) return;

  const userId = feed.user_id;
  if (userId == null) {
    console.warn(`[Translation] Feed ${feedId} 无所属用户，跳过翻译`);
    return;
  }
  if (!(await isTranslationEnabled(userId))) {
    console.warn(`[Translation] 用户 ${userId} 未配置翻译，Feed ${feedId} 跳过翻译`);
    return;
  }

  console.log(`[Translation] Feed ${feedId} 开始翻译 ${articles.length} 篇新文章（用户 ${userId}）`);
  let successCount = 0;

  for (let i = 0; i < articles.length; i += 1) {
    const article = articles[i]!;
    try {
      await pauseBetweenBatchArticles(userId, i);
      await translateSingleArticle(userId, article.id, article.title, article.description);
      successCount++;
    } catch (error) {
      console.warn(
        `[Translation] 文章 ${article.id} 翻译失败:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  console.log(`[Translation] Feed ${feedId} 翻译完成：${successCount}/${articles.length}`);
}

export type TranslateFeedResult = {
  total: number;
  translated: number;
  failed: number;
  aborted?: boolean;
  error?: string | null;
};

function isFatalTranslationError(error: unknown): boolean {
  const err = error as { quotaExceeded?: boolean; message?: string };
  if (err?.quotaExceeded) return true;
  const msg = String(err?.message || error || '');
  return /免费额度已用尽|quota|请先在设置页配置|翻译功能已关闭/i.test(msg);
}

function isRateLimitTranslationError(error: unknown): boolean {
  const err = error as { rateLimited?: boolean; statusCode?: number; message?: string };
  if (err?.rateLimited) return true;
  if (err?.statusCode === 429) return true;
  const msg = String(err?.message || error || '');
  return /queue full|rate.?limit|too many requests|限流/i.test(msg);
}

export async function translateAllArticlesForFeed(feedId: number): Promise<TranslateFeedResult> {
  const prisma = await getPrisma();
  const feed = await prisma.feed.findUnique({
    where: { id: feedId },
    select: { needs_translation: true, user_id: true },
  });
  if (!feed) {
    throw new Error('Feed 不存在');
  }
  if (!feed.needs_translation) {
    throw new Error('该 Feed 未开启需要翻译');
  }

  const userId = feed.user_id;
  if (userId == null) {
    throw new Error('该 Feed 无所属用户，无法翻译');
  }
  if (!(await isTranslationEnabled(userId))) {
    throw new Error('请先在设置页配置并启用翻译服务');
  }

  const articles = await prisma.article.findMany({
    where: { feed_id: feedId },
    select: { id: true, title: true, description: true },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
  });

  if (!articles.length) {
    return { total: 0, translated: 0, failed: 0 };
  }

  console.log(`[Translation] Feed ${feedId} 手动触发全量翻译，共 ${articles.length} 篇（用户 ${userId}）`);
  let translated = 0;
  let failed = 0;
  let aborted = false;
  let fatalError: string | null = null;
  let consecutiveRateLimits = 0;

  for (let i = 0; i < articles.length; i += 1) {
    const article = articles[i]!;
    try {
      await pauseBetweenBatchArticles(userId, i);
      await translateSingleArticle(userId, article.id, article.title, article.description);
      translated++;
      consecutiveRateLimits = 0;
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Translation] 文章 ${article.id} 翻译失败:`, message);
      if (isFatalTranslationError(error)) {
        aborted = true;
        fatalError = message;
        break;
      }
      if (isRateLimitTranslationError(error)) {
        consecutiveRateLimits += 1;
        // 连续限流时加长冷却，避免继续打爆 DeepSeek 网页桥
        const coolDown = Math.min(30000, 5000 * consecutiveRateLimits);
        console.warn(`[Translation] 连续限流 ${consecutiveRateLimits} 次，冷却 ${coolDown}ms`);
        await sleep(coolDown);
        if (consecutiveRateLimits >= 5) {
          aborted = true;
          fatalError = message;
          break;
        }
      } else {
        consecutiveRateLimits = 0;
      }
    }
  }

  console.log(
    `[Translation] Feed ${feedId} 全量翻译完成：${translated}/${articles.length}，失败 ${failed}` +
      (aborted ? `（中止：${fatalError}）` : ''),
  );
  return {
    total: articles.length,
    translated,
    failed,
    aborted,
    error: fatalError,
  };
}

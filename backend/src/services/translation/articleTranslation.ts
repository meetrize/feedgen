import { getPrisma } from '../../server';
import { isTranslationEnabled, textTranslateEnToZh } from './tencentClient';

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

async function translateSingleArticle(
  articleId: number,
  title: string,
  description: string | null,
): Promise<void> {
  const prisma = await getPrisma();
  const titleZh = title.trim() ? await textTranslateEnToZh(title.trim()) : null;
  let descriptionZh: string | null = null;

  if (description) {
    const plain = stripHtmlTags(description);
    if (plain) {
      descriptionZh = await textTranslateEnToZh(plain);
    }
  }

  await prisma.article.update({
    where: { id: articleId },
    data: {
      title_zh: titleZh ? titleZh.slice(0, 500) : null,
      description_zh: descriptionZh,
      updated_at: new Date(),
    },
  });
}

export async function translateNewArticlesForFeed(
  feedId: number,
  articles: NewArticleForTranslation[],
): Promise<void> {
  if (!isTranslationEnabled() || !articles.length) return;

  const prisma = await getPrisma();
  const feed = await prisma.feed.findUnique({
    where: { id: feedId },
    select: { needs_translation: true },
  });
  if (!feed?.needs_translation) return;

  console.log(`[Translation] Feed ${feedId} 开始翻译 ${articles.length} 篇新文章`);
  let successCount = 0;

  for (const article of articles) {
    try {
      await translateSingleArticle(article.id, article.title, article.description);
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

import { prisma } from '../../server';
import * as mlClient from './mlClient';

export type ArticleClassificationResult = {
  article_id: number;
  category_id: number | null;
  category_code: string | null;
  confidence: number | null;
  model_version: string | null;
  need_review: boolean;
  classified_at: Date;
};

function bytesToVector(bytes: Buffer): number[] {
  if (!bytes.length) {
    return [];
  }
  const float32 = new Float32Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  return Array.from(float32);
}

async function loadActiveCategoriesWithPrototypes(): Promise<mlClient.CategoryPrototypeInput[]> {
  const categories = await prisma.newsCategory.findMany({
    where: { status: 'active' },
    include: { prototype: true },
    orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
  });

  const result: mlClient.CategoryPrototypeInput[] = [];
  for (const category of categories) {
    if (!category.prototype?.embedding) {
      continue;
    }
    const prototype = bytesToVector(Buffer.from(category.prototype.embedding));
    if (!prototype.length) {
      continue;
    }
    result.push({
      id: category.id,
      code: category.code,
      prototype,
    });
  }
  return result;
}

export async function classifyArticle(articleId: number): Promise<ArticleClassificationResult> {
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: { id: true, title: true },
  });

  if (!article) {
    throw new Error('文章不存在');
  }

  const title = article.title?.trim();
  if (!title) {
    throw new Error('文章标题为空，无法分类');
  }

  const categories = await loadActiveCategoriesWithPrototypes();
  const mlResult = await mlClient.classify(title, categories);
  const classifiedAt = new Date();

  const record = await prisma.articleClassification.upsert({
    where: { article_id: articleId },
    create: {
      article_id: articleId,
      category_id: mlResult.category_id,
      confidence: mlResult.confidence,
      model_version: mlResult.model_version,
      need_review: mlResult.need_review,
      classified_at: classifiedAt,
    },
    update: {
      category_id: mlResult.category_id,
      confidence: mlResult.confidence,
      model_version: mlResult.model_version,
      need_review: mlResult.need_review,
      classified_at: classifiedAt,
    },
  });

  let categoryCode: string | null = mlResult.category_code;
  if (!categoryCode && record.category_id != null) {
    const category = await prisma.newsCategory.findUnique({
      where: { id: record.category_id },
      select: { code: true },
    });
    categoryCode = category?.code ?? null;
  }

  return {
    article_id: articleId,
    category_id: record.category_id,
    category_code: categoryCode,
    confidence: record.confidence,
    model_version: record.model_version,
    need_review: record.need_review,
    classified_at: record.classified_at,
  };
}

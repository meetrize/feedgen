import { FastifyPluginAsync } from 'fastify';

import * as annotationService from '../services/classification/annotationService';
import { listPublicCategories } from '../services/classification/categoryService';

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
    return decoded.userId as number;
  } catch {
    res.status(401).send({ error: 'Invalid or expired token' });
    return null;
  }
}

const classificationPublicRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/categories', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    try {
      const categories = await listPublicCategories();
      return { categories };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '获取类别列表失败' });
    }
  });

  /** 阅读器内人工纠错：更新全局 AI 分类并写入标注记录（供训练回流） */
  fastify.post('/annotate', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    try {
      const body = req.body as { article_id?: number; category_id?: number };
      const articleId = Number(body?.article_id);
      const categoryId = Number(body?.category_id);
      if (!Number.isInteger(articleId) || articleId <= 0) {
        return res.status(400).send({ error: 'article_id 必须为有效正整数' });
      }
      if (!Number.isInteger(categoryId) || categoryId <= 0) {
        return res.status(400).send({ error: 'category_id 必须为有效正整数' });
      }

      const results = await annotationService.annotateArticles({
        article_ids: [articleId],
        category_id: categoryId,
        labeled_by: userId,
      });

      const category = (await listPublicCategories()).find((item) => item.id === categoryId) ?? null;

      return {
        annotated: results.length,
        result: results[0] ?? null,
        ai_category: category
          ? {
              id: category.id,
              code: category.code,
              name: category.name,
              color: category.color,
              confidence: 1,
            }
          : null,
      };
    } catch (error) {
      if (error instanceof Error) {
        const message = error.message;
        if (
          message.includes('不能为空') ||
          message.includes('类别已禁用') ||
          message.includes('类别不存在')
        ) {
          return res.status(400).send({ error: message });
        }
        if (message.includes('部分文章不存在') || message.includes('文章不存在')) {
          return res.status(404).send({ error: message });
        }
      }
      req.log.error(error);
      return res.status(500).send({ error: '标注失败' });
    }
  });
};

export { classificationPublicRoutes };

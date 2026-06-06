import { FastifyPluginAsync } from 'fastify';

import { prisma } from '../server';
import * as annotationService from '../services/classification/annotationService';
import * as batchClassificationService from '../services/classification/batchClassificationService';
import { classifyArticle } from '../services/classification/classificationService';
import * as categoryService from '../services/classification/categoryService';
import * as statsService from '../services/classification/statsService';
import * as trainingService from '../services/classification/trainingService';

/** 管理接口：仅接受有效用户 JWT，且 users.is_admin = true */
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

function handleServiceError(error: unknown, req: any, res: any, fallback: string) {
  if (error instanceof Error) {
    const message = error.message;
    if (
      message.includes('不能为空') ||
      message.includes('code 仅允许') ||
      message.includes('examples 不能为空') ||
      message.includes('titles 不能为空') ||
      message.includes('article_ids 不能为空') ||
      message.includes('类别已禁用') ||
      message.includes('训练样本不足') ||
      message.includes('训练至少需要') ||
      message.includes('模型版本不存在') ||
      message.includes('没有符合条件的文章') ||
      message.includes('feed_id 无效') ||
      message.includes('since 日期格式无效') ||
      message.includes('Feed 不存在')
    ) {
      return res.status(400).send({ error: message });
    }
    if (message.includes('部分文章不存在')) {
      return res.status(404).send({ error: message });
    }
    if (message.includes('不存在') || message.includes('无法分类')) {
      return res.status(404).send({ error: message });
    }
    if (message.includes('ML 服务') || message.includes('ML_SERVICE_TOKEN')) {
      req.log.error(error);
      return res.status(502).send({ error: message });
    }
    if ((error as { code?: string }).code === 'P2002') {
      return res.status(409).send({ error: '类别 code 已存在' });
    }
  }
  req.log.error(error);
  return res.status(500).send({ error: fallback });
}

const classificationAdminRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', verifyAdmin);

  fastify.get('/categories', async (req: any, res: any) => {
    try {
      const categories = await categoryService.listCategories();
      return { categories };
    } catch (error) {
      return handleServiceError(error, req, res, '获取类别列表失败');
    }
  });

  fastify.post('/categories', async (req: any, res: any) => {
    try {
      const body = req.body as {
        code?: string;
        name?: string;
        description?: string | null;
        color?: string | null;
        sort_order?: number;
        examples?: string[];
      };

      if (!body?.code || !body?.name) {
        return res.status(400).send({ error: 'code 与 name 为必填项' });
      }

      const payload: categoryService.CreateCategoryInput = {
        code: body.code,
        name: body.name,
        description: body.description ?? null,
        color: body.color ?? null,
      };
      if (body.sort_order !== undefined) {
        payload.sort_order = body.sort_order;
      }
      if (body.examples !== undefined) {
        payload.examples = body.examples;
      }

      const category = await categoryService.createCategory(payload);
      return res.status(201).send({ category });
    } catch (error) {
      return handleServiceError(error, req, res, '创建类别失败');
    }
  });

  fastify.patch('/categories/:id', async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id)) {
        return res.status(400).send({ error: '无效的类别 ID' });
      }

      const body = req.body as categoryService.UpdateCategoryInput;
      const category = await categoryService.updateCategory(id, body);
      return { category };
    } catch (error) {
      return handleServiceError(error, req, res, '更新类别失败');
    }
  });

  fastify.delete('/categories/:id', async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id)) {
        return res.status(400).send({ error: '无效的类别 ID' });
      }

      const category = await categoryService.disableCategory(id);
      return { category };
    } catch (error) {
      return handleServiceError(error, req, res, '禁用类别失败');
    }
  });

  fastify.get('/pending', async (req: any, res: any) => {
    try {
      const query = req.query as Record<string, string | undefined>;
      const needReviewRaw = query.need_review;
      const needReview =
        needReviewRaw === undefined ? true : needReviewRaw === 'true' || needReviewRaw === '1';

      const payload: annotationService.PendingQuery = {
        need_review: needReview,
      };

      if (query.limit !== undefined) {
        payload.limit = Number(query.limit);
      }
      if (query.offset !== undefined) {
        payload.offset = Number(query.offset);
      }
      if (query.category_id !== undefined) {
        payload.category_id = Number(query.category_id);
      }
      if (query.feed_id !== undefined) {
        payload.feed_id = Number(query.feed_id);
      }

      const result = await annotationService.listPending(payload);
      return result;
    } catch (error) {
      return handleServiceError(error, req, res, '获取待标注队列失败');
    }
  });

  fastify.post('/annotate', async (req: any, res: any) => {
    try {
      const body = req.body as { article_ids?: number[]; category_id?: number };
      const categoryId = Number(body?.category_id);
      if (!Number.isInteger(categoryId) || categoryId <= 0) {
        return res.status(400).send({ error: 'category_id 必须为有效正整数' });
      }
      if (!body?.article_ids?.length) {
        return res.status(400).send({ error: 'article_ids 不能为空' });
      }

      const annotatePayload: annotationService.AnnotateInput = {
        article_ids: body.article_ids,
        category_id: categoryId,
      };
      if (req.adminUserId != null) {
        annotatePayload.labeled_by = req.adminUserId as number;
      }

      const results = await annotationService.annotateArticles(annotatePayload);

      return { annotated: results.length, results };
    } catch (error) {
      return handleServiceError(error, req, res, '标注失败');
    }
  });

  fastify.get('/stats', async (req: any, res: any) => {
    try {
      const stats = await annotationService.getAnnotationStats();
      return { stats };
    } catch (error) {
      return handleServiceError(error, req, res, '获取标注统计失败');
    }
  });

  fastify.get('/reports/classification', async (req: any, res: any) => {
    try {
      const query = req.query as { sample_size?: string };
      const sampleSize = query.sample_size !== undefined ? Number(query.sample_size) : undefined;
      const report = await statsService.getClassificationReport(sampleSize);
      return { report };
    } catch (error) {
      return handleServiceError(error, req, res, '获取统计报表失败');
    }
  });

  fastify.post('/classify', async (req: any, res: any) => {
    try {
      const body = req.body as { article_id?: number };
      const articleId = Number(body?.article_id);
      if (!Number.isInteger(articleId) || articleId <= 0) {
        return res.status(400).send({ error: 'article_id 必须为有效正整数' });
      }

      const result = await classifyArticle(articleId);
      return { classification: result };
    } catch (error) {
      return handleServiceError(error, req, res, '文章分类失败');
    }
  });

  fastify.post('/classify/batch', async (req: any, res: any) => {
    try {
      if (process.env.CLASSIFICATION_ENABLED === '0') {
        return res.status(503).send({ error: '分类功能已关闭（CLASSIFICATION_ENABLED=0）' });
      }

      const body = req.body as {
        article_ids?: number[];
        feed_id?: number;
        since?: string;
        only_unclassified?: boolean;
        limit?: number;
      };

      const hasArticleIds = !!body?.article_ids?.length;
      const payload: batchClassificationService.BatchClassifyInput = {};

      if (hasArticleIds && body.article_ids) {
        payload.article_ids = body.article_ids;
        payload.only_unclassified = false;
      } else {
        if (body?.feed_id != null) {
          payload.feed_id = Number(body.feed_id);
        }
        if (body?.since?.trim()) {
          payload.since = body.since.trim();
        }
        if (body.only_unclassified !== undefined) {
          payload.only_unclassified = !!body.only_unclassified;
        }
      }
      if (body.limit !== undefined) {
        payload.limit = Number(body.limit);
      }

      const result = await batchClassificationService.submitBatchClassification(payload);
      return res.status(201).send({
        job_id: result.job_id,
        total: result.total,
        enqueued: result.total,
      });
    } catch (error) {
      return handleServiceError(error, req, res, '批量分类入队失败');
    }
  });

  fastify.get('/classify/batch/:jobId', async (req: any, res: any) => {
    try {
      const jobId = req.params.jobId as string;
      const progress = await batchClassificationService.getBatchClassificationProgress(jobId);
      if (!progress) {
        return res.status(404).send({ error: '批量任务不存在' });
      }
      return { job: progress };
    } catch (error) {
      return handleServiceError(error, req, res, '获取批量任务进度失败');
    }
  });

  fastify.post('/training/start', async (req: any, res: any) => {
    try {
      const body = req.body as { trigger_reason?: string } | undefined;
      const job = await trainingService.startTraining(body?.trigger_reason ?? 'manual');
      return res.status(201).send({ job });
    } catch (error) {
      return handleServiceError(error, req, res, '启动训练失败');
    }
  });

  fastify.get('/training/jobs', async (req: any, res: any) => {
    try {
      const query = req.query as { limit?: string };
      const limit = query.limit !== undefined ? Number(query.limit) : 20;
      const jobs = await trainingService.listTrainingJobs(limit);
      return { jobs };
    } catch (error) {
      return handleServiceError(error, req, res, '获取训练任务列表失败');
    }
  });

  fastify.get('/training/jobs/:id', async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id)) {
        return res.status(400).send({ error: '无效的训练任务 ID' });
      }

      const job = await trainingService.getTrainingJob(id);
      if (!job) {
        return res.status(404).send({ error: '训练任务不存在' });
      }
      return { job };
    } catch (error) {
      return handleServiceError(error, req, res, '获取训练任务失败');
    }
  });

  fastify.get('/models/active', async (req: any, res: any) => {
    try {
      const model = await trainingService.getActiveModel();
      return { model };
    } catch (error) {
      return handleServiceError(error, req, res, '获取当前模型失败');
    }
  });

  fastify.put('/models/active', async (req: any, res: any) => {
    try {
      const body = req.body as { version?: string };
      const version = body?.version?.trim();
      if (!version) {
        return res.status(400).send({ error: 'version 为必填项' });
      }

      const model = await trainingService.publishModelVersion(version);
      return { model };
    } catch (error) {
      return handleServiceError(error, req, res, '发布模型失败');
    }
  });

  fastify.post('/categories/:id/examples', async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id)) {
        return res.status(400).send({ error: '无效的类别 ID' });
      }

      const body = req.body as { titles?: string[] };
      if (!body?.titles?.length) {
        return res.status(400).send({ error: 'titles 不能为空' });
      }

      const category = await categoryService.appendExamples(id, body.titles);
      return { category };
    } catch (error) {
      return handleServiceError(error, req, res, '追加示例失败');
    }
  });
};

export { classificationAdminRoutes };

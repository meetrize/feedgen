import { FastifyPluginAsync } from 'fastify';

import { runTitleInsight } from '../services/ai/titleInsightService';
import type { TitleInsightMode } from '../services/ai/titleInsightPrompts';
import { suggestThemeKeywords } from '../services/ai/themeKeywordSuggestService';
import {
  createInsightRecipe,
  deleteInsightRecipe,
  getInsightRecipeRun,
  getInsightRunsDigest,
  getLatestInsightRecipeRun,
  listInsightRecipeRuns,
  listInsightRecipes,
  resetInsightRecipe,
  runInsightRecipe,
  updateInsightRecipe,
  type InsightContextField,
} from '../services/ai/insightRecipeService';

async function requireUserId(req: any, res: any): Promise<number | null> {
  const authHeader = req.headers.authorization as string | undefined;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).send({ error: '需要登录' });
    return null;
  }
  try {
    const decoded: any = await req.jwtVerify();
    const userId = Number(decoded.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      res.status(401).send({ error: '无效令牌' });
      return null;
    }
    return userId;
  } catch {
    res.status(401).send({ error: '登录已过期，请重新登录' });
    return null;
  }
}

function handleAiError(error: unknown, req: any, res: any) {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    if (code === 'AI_NOT_CONFIGURED') {
      return res.status(503).send({ error: error.message });
    }
    if (code === 'EMPTY_TITLES' || code === 'AI_BAD_REQUEST') {
      return res.status(400).send({ error: error.message });
    }
    if (code === 'NOT_FOUND') {
      return res.status(404).send({ error: error.message });
    }
    if (code === 'AI_HTTP_ERROR' || code === 'AI_REQUEST_FAILED' || code === 'AI_EMPTY_RESPONSE') {
      req.log.error(error);
      return res.status(502).send({ error: error.message });
    }
  }
  req.log.error(error);
  return res.status(500).send({ error: 'AI 分析失败' });
}

function parseRecipeId(raw: unknown): number | null {
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

const aiInsightRoutes: FastifyPluginAsync = async (fastify) => {
  /** 兼容：基于当前页面标题做 AI 总结 / AI 挖掘（内部转调内置配方） */
  fastify.post('/titles', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    try {
      const body = req.body as {
        mode?: string;
        titles?: string[];
        scope_label?: string;
      };
      const modeRaw = String(body?.mode || 'summary').trim().toLowerCase();
      const mode: TitleInsightMode = modeRaw === 'mining' ? 'mining' : 'summary';

      const insightInput: {
        mode: TitleInsightMode;
        titles: string[];
        scope_label?: string;
        userId: number;
      } = {
        mode,
        titles: Array.isArray(body?.titles) ? body.titles : [],
        userId,
      };
      if (body?.scope_label?.trim()) insightInput.scope_label = body.scope_label.trim();

      const result = await runTitleInsight(insightInput);

      return { insight: result };
    } catch (error) {
      return handleAiError(error, req, res);
    }
  });

  /** 列出当前用户洞察配方（首次自动 seed 内置） */
  fastify.get('/recipes', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;
    try {
      const recipes = await listInsightRecipes(userId);
      return { recipes };
    } catch (error) {
      return handleAiError(error, req, res);
    }
  });

  /** 新建自定义配方 */
  fastify.post('/recipes', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;
    try {
      const body = (req.body || {}) as {
        name?: string;
        description?: string | null;
        icon?: string | null;
        system_prompt?: string;
        user_prompt_template?: string;
        context_fields?: InsightContextField[];
        enabled?: boolean;
        sort_order?: number;
      };
      const createInput: Parameters<typeof createInsightRecipe>[1] = {
        name: String(body.name || ''),
        description: body.description ?? null,
        icon: body.icon ?? null,
        system_prompt: String(body.system_prompt || ''),
        user_prompt_template: String(body.user_prompt_template || ''),
        context_fields: Array.isArray(body.context_fields) ? body.context_fields : ['title'],
        enabled: body.enabled !== false,
      };
      if (body.sort_order != null && Number.isFinite(Number(body.sort_order))) {
        createInput.sort_order = Number(body.sort_order);
      }
      const recipe = await createInsightRecipe(userId, createInput);
      return { recipe };
    } catch (error) {
      return handleAiError(error, req, res);
    }
  });

  /** 更新配方 */
  fastify.patch('/recipes/:id', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;
    const recipeId = parseRecipeId((req.params as { id?: string })?.id);
    if (!recipeId) return res.status(400).send({ error: '无效配方 ID' });
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const patch: Parameters<typeof updateInsightRecipe>[2] = {};
      if (body.name !== undefined) patch.name = String(body.name || '');
      if (body.description !== undefined) {
        patch.description = body.description == null ? null : String(body.description);
      }
      if (body.icon !== undefined) {
        patch.icon = body.icon == null ? null : String(body.icon);
      }
      if (body.system_prompt !== undefined) patch.system_prompt = String(body.system_prompt || '');
      if (body.user_prompt_template !== undefined) {
        patch.user_prompt_template = String(body.user_prompt_template || '');
      }
      if (body.context_fields !== undefined) {
        patch.context_fields = Array.isArray(body.context_fields)
          ? (body.context_fields as InsightContextField[])
          : ['title'];
      }
      if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
      if (body.sort_order !== undefined) patch.sort_order = Number(body.sort_order);

      const recipe = await updateInsightRecipe(userId, recipeId, patch);
      return { recipe };
    } catch (error) {
      return handleAiError(error, req, res);
    }
  });

  /** 删除自定义配方 */
  fastify.delete('/recipes/:id', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;
    const recipeId = parseRecipeId((req.params as { id?: string })?.id);
    if (!recipeId) return res.status(400).send({ error: '无效配方 ID' });
    try {
      await deleteInsightRecipe(userId, recipeId);
      return { ok: true };
    } catch (error) {
      return handleAiError(error, req, res);
    }
  });

  /** 内置配方恢复默认 */
  fastify.post('/recipes/:id/reset', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;
    const recipeId = parseRecipeId((req.params as { id?: string })?.id);
    if (!recipeId) return res.status(400).send({ error: '无效配方 ID' });
    try {
      const recipe = await resetInsightRecipe(userId, recipeId);
      return { recipe };
    } catch (error) {
      return handleAiError(error, req, res);
    }
  });

  /** 报告台：当前范围+自然日各配方最新结果一览 */
  fastify.get('/runs/digest', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;
    try {
      const q = (req.query || {}) as {
        scope_key?: string;
        run_day?: string;
        include_disabled?: string;
      };
      const digest = await getInsightRunsDigest(userId, q.scope_key, q.run_day, {
        include_disabled: q.include_disabled === '1' || q.include_disabled === 'true',
      });
      return { digest };
    } catch (error) {
      return handleAiError(error, req, res);
    }
  });

  /** 当前范围+自然日下最新一条结果（秒开） */
  fastify.get('/recipes/:id/runs/latest', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;
    const recipeId = parseRecipeId((req.params as { id?: string })?.id);
    if (!recipeId) return res.status(400).send({ error: '无效配方 ID' });
    try {
      const q = (req.query || {}) as { scope_key?: string; run_day?: string };
      const run = await getLatestInsightRecipeRun(userId, recipeId, q.scope_key, q.run_day);
      return { run };
    } catch (error) {
      return handleAiError(error, req, res);
    }
  });

  /** 当前范围+自然日版本列表 */
  fastify.get('/recipes/:id/runs', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;
    const recipeId = parseRecipeId((req.params as { id?: string })?.id);
    if (!recipeId) return res.status(400).send({ error: '无效配方 ID' });
    try {
      const q = (req.query || {}) as { scope_key?: string; run_day?: string; limit?: string };
      const runs = await listInsightRecipeRuns(
        userId,
        recipeId,
        q.scope_key,
        q.run_day,
        q.limit
      );
      return { runs };
    } catch (error) {
      return handleAiError(error, req, res);
    }
  });

  /** 单条 run 全文 */
  fastify.get('/recipes/runs/:runId', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;
    const runId = parseRecipeId((req.params as { runId?: string })?.runId);
    if (!runId) return res.status(400).send({ error: '无效运行 ID' });
    try {
      const run = await getInsightRecipeRun(userId, runId);
      if (!run) return res.status(404).send({ error: '结果不存在' });
      return { run };
    } catch (error) {
      return handleAiError(error, req, res);
    }
  });

  /** 运行配方（始终写入新版本；前端无缓存时调用，或 force_refresh 重新生成） */
  fastify.post('/recipes/:id/run', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;
    const recipeId = parseRecipeId((req.params as { id?: string })?.id);
    if (!recipeId) return res.status(400).send({ error: '无效配方 ID' });
    try {
      const body = (req.body || {}) as {
        titles?: unknown;
        items?: unknown;
        scope_label?: string;
        scope_key?: string;
        run_day?: string;
        force_refresh?: boolean;
      };
      const runInput: {
        titles?: unknown;
        items?: unknown;
        scope_label?: string;
        scope_key?: string;
        run_day?: string;
        force_refresh?: boolean;
      } = {};
      if (body.titles !== undefined) runInput.titles = body.titles;
      if (body.items !== undefined) runInput.items = body.items;
      if (body.scope_label?.trim()) runInput.scope_label = body.scope_label.trim();
      if (body.scope_key?.trim()) runInput.scope_key = body.scope_key.trim();
      if (body.run_day?.trim()) runInput.run_day = body.run_day.trim();
      if (body.force_refresh != null) runInput.force_refresh = Boolean(body.force_refresh);
      const result = await runInsightRecipe(userId, recipeId, runInput);
      return { insight: result };
    } catch (error) {
      return handleAiError(error, req, res);
    }
  });

  /** 为主题补充关联关键词（仅用户主动触发，不用于文章打标） */
  fastify.post('/theme-keywords', async (req: any, res: any) => {
    const userId = await requireUserId(req, res);
    if (!userId) return;

    try {
      const body = req.body as { name?: string; existing_keywords?: string[] };
      const result = await suggestThemeKeywords({
        name: String(body?.name || ''),
        existing_keywords: Array.isArray(body?.existing_keywords)
          ? body.existing_keywords
          : [],
      });
      return result;
    } catch (error) {
      return handleAiError(error, req, res);
    }
  });
};

export { aiInsightRoutes };

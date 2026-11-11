import { FastifyPluginAsync } from 'fastify';

import { runTitleInsight } from '../services/ai/titleInsightService';
import type { TitleInsightMode } from '../services/ai/titleInsightPrompts';
import { suggestThemeKeywords } from '../services/ai/themeKeywordSuggestService';

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
    if (code === 'AI_HTTP_ERROR' || code === 'AI_REQUEST_FAILED' || code === 'AI_EMPTY_RESPONSE') {
      req.log.error(error);
      return res.status(502).send({ error: error.message });
    }
  }
  req.log.error(error);
  return res.status(500).send({ error: 'AI 分析失败' });
}

const aiInsightRoutes: FastifyPluginAsync = async (fastify) => {
  /** 基于当前页面标题做 AI 总结 / AI 挖掘 */
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
      } = {
        mode,
        titles: Array.isArray(body?.titles) ? body.titles : [],
      };
      if (body?.scope_label?.trim()) insightInput.scope_label = body.scope_label.trim();

      const result = await runTitleInsight(insightInput);

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

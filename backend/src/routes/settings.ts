import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../server';
import {
  DEFAULT_GEMINI_MODEL,
} from '../services/translation/geminiClient';
import {
  DEFAULT_INDEX_TRANSLATE_BASE_URL,
  DEFAULT_INDEX_TRANSLATE_MODEL,
} from '../services/translation/indexTranslateClient';
import {
  DEFAULT_OPENAI_TRANSLATE_BASE_URL,
  DEFAULT_OPENAI_TRANSLATE_MODEL,
} from '../services/translation/openaiClient';
import {
  DEFAULT_MTRAN_BASE_URL,
  getUserTranslationConfig,
  maskSecret,
  normalizeProvider,
  saveUserTranslationConfig,
  type TranslationProvider,
} from '../services/translation/translationConfig';
import { invalidateTranslationClient, textTranslateEnToZh } from '../services/translation/translateClient';

async function verifyLoggedInUser(req: any, res: any) {
  const authHeader = req.headers.authorization as string | undefined;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).send({ error: '请先登录' });
  }

  try {
    const decoded: any = await req.jwtVerify();
    const userId = decoded.userId as number | undefined;
    if (userId == null) {
      return res.status(403).send({ error: '无效令牌' });
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) {
      return res.status(403).send({ error: '用户不存在' });
    }
    req.userId = user.id;
  } catch {
    return res.status(401).send({ error: '无效或已过期的登录令牌，请重新登录' });
  }
}

function serializeTranslationConfig(config: Awaited<ReturnType<typeof getUserTranslationConfig>>) {
  const envGeminiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const geminiKey = config?.provider === 'gemini'
    ? (config.secretKey || envGeminiKey)
    : envGeminiKey;

  const envOpenAiKey = String(process.env.OPENAI_TRANSLATE_API_KEY || '').trim();
  const openAiKey = config?.provider === 'openai'
    ? (config.secretKey || envOpenAiKey)
    : envOpenAiKey;
  const openAiBaseUrl =
    config?.provider === 'openai' && config.baseUrl
      ? config.baseUrl
      : String(process.env.OPENAI_TRANSLATE_BASE_URL || DEFAULT_OPENAI_TRANSLATE_BASE_URL)
          .trim()
          .replace(/\/+$/, '') || DEFAULT_OPENAI_TRANSLATE_BASE_URL;
  const openAiModel =
    config?.provider === 'openai' && config.secretId
      ? config.secretId
      : String(process.env.OPENAI_TRANSLATE_MODEL || DEFAULT_OPENAI_TRANSLATE_MODEL).trim() ||
        DEFAULT_OPENAI_TRANSLATE_MODEL;

  const indexBaseUrl =
    config?.provider === 'index' && config.baseUrl
      ? config.baseUrl
      : String(process.env.INDEX_TRANSLATE_BASE_URL || DEFAULT_INDEX_TRANSLATE_BASE_URL)
          .trim()
          .replace(/\/+$/, '') || DEFAULT_INDEX_TRANSLATE_BASE_URL;
  const indexModel =
    config?.provider === 'index' && config.secretId
      ? config.secretId
      : String(process.env.INDEX_TRANSLATE_MODEL || DEFAULT_INDEX_TRANSLATE_MODEL).trim() ||
        DEFAULT_INDEX_TRANSLATE_MODEL;

  let baseUrl = config?.baseUrl || DEFAULT_MTRAN_BASE_URL;
  if (config?.provider === 'openai') baseUrl = openAiBaseUrl;
  if (config?.provider === 'index') baseUrl = indexBaseUrl;

  return {
    configured: !!config,
    source: config ? 'user' : null,
    provider: config?.provider || 'tencent',
    secretId: config?.secretId || '',
    secretKeyMasked: config?.secretKey ? maskSecret(config.secretKey) : '',
    region: config?.region || 'ap-guangzhou',
    baseUrl,
    apiTokenMasked: config?.apiToken ? maskSecret(config.apiToken) : '',
    geminiApiKeyMasked: geminiKey ? maskSecret(geminiKey) : '',
    geminiModel: DEFAULT_GEMINI_MODEL,
    geminiHasEnvKey: !!envGeminiKey,
    openaiApiKeyMasked: openAiKey ? maskSecret(openAiKey) : '',
    openaiBaseUrl: openAiBaseUrl,
    openaiModel: openAiModel,
    openaiHasEnvKey: !!envOpenAiKey,
    indexBaseUrl,
    indexModel,
    enabled: config?.enabled !== false,
    canEdit: true,
  };
}

function providerSaveMessage(provider: TranslationProvider): string {
  if (provider === 'mtran') return '本机 MTranServer 翻译配置已保存';
  if (provider === 'gemini') return 'Gemini 翻译配置已保存';
  if (provider === 'openai') return 'OpenAI 兼容翻译配置已保存';
  if (provider === 'index') return 'Index-Translate 翻译配置已保存';
  return '你的腾讯翻译配置已保存';
}

const settingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', verifyLoggedInUser);

  fastify.get('/translation', async (req: any) => {
    const userId = req.userId as number;
    const config = await getUserTranslationConfig(userId);
    return serializeTranslationConfig(config);
  });

  fastify.put('/translation', async (req: any, res: any) => {
    const userId = req.userId as number;
    const body = (req.body || {}) as {
      provider?: string;
      secretId?: string;
      secretKey?: string;
      region?: string;
      baseUrl?: string;
      apiToken?: string;
      enabled?: boolean;
    };

    const current = await getUserTranslationConfig(userId);
    const provider = normalizeProvider(body.provider || current?.provider || 'tencent');

    const secretKeyInput = String(body.secretKey ?? '').trim();
    let secretKey = '';
    if (secretKeyInput && !secretKeyInput.includes('*')) {
      secretKey = secretKeyInput;
    } else if (provider === 'gemini') {
      secretKey = current?.provider === 'gemini' ? current.secretKey || '' : '';
    } else if (provider === 'openai') {
      secretKey = current?.provider === 'openai' ? current.secretKey || '' : '';
    } else if (provider === 'index') {
      secretKey = current?.provider === 'index' ? current.secretKey || '' : '';
    } else if (provider === 'tencent' && current?.provider === 'tencent') {
      secretKey = current.secretKey || '';
    } else {
      secretKey = '';
    }

    const apiTokenInput = String(body.apiToken ?? '').trim();
    const apiToken =
      apiTokenInput && !apiTokenInput.includes('*')
        ? apiTokenInput
        : body.apiToken === ''
          ? ''
          : current?.apiToken || '';

    try {
      const payload: {
        provider: TranslationProvider;
        secretId?: string;
        secretKey?: string;
        region?: string;
        baseUrl?: string;
        apiToken?: string;
        enabled?: boolean;
      } = {
        provider,
        secretKey,
        apiToken,
      };

      if (provider === 'tencent') {
        if (body.secretId !== undefined) payload.secretId = body.secretId;
        else if (current?.provider === 'tencent') payload.secretId = current.secretId;
        else payload.secretId = String(body.secretId || '').trim();
      } else if (provider === 'openai') {
        if (body.secretId !== undefined && String(body.secretId).trim()) {
          payload.secretId = String(body.secretId).trim();
        } else if (current?.provider === 'openai' && current.secretId) {
          payload.secretId = current.secretId;
        } else {
          payload.secretId = DEFAULT_OPENAI_TRANSLATE_MODEL;
        }
      } else if (provider === 'index') {
        if (body.secretId !== undefined && String(body.secretId).trim()) {
          payload.secretId = String(body.secretId).trim();
        } else if (current?.provider === 'index' && current.secretId) {
          payload.secretId = current.secretId;
        } else {
          payload.secretId = DEFAULT_INDEX_TRANSLATE_MODEL;
        }
      } else {
        payload.secretId = '';
      }

      if (body.region !== undefined) payload.region = body.region;
      if (body.baseUrl !== undefined) payload.baseUrl = body.baseUrl;
      if (body.enabled !== undefined) payload.enabled = body.enabled;

      const saved = await saveUserTranslationConfig(userId, payload);
      invalidateTranslationClient(userId);

      return {
        message: providerSaveMessage(saved.provider),
        ...serializeTranslationConfig(saved),
      };
    } catch (err: any) {
      return res.status(400).send({ error: err?.message || '保存失败' });
    }
  });

  fastify.post('/translation/test', async (req: any, res: any) => {
    const userId = req.userId as number;

    try {
      const translated = await textTranslateEnToZh(userId, 'Hello');
      return {
        ok: true,
        sample: translated,
        message: '翻译接口连通正常',
      };
    } catch (err: any) {
      return res.status(400).send({
        ok: false,
        error: err?.message || '翻译测试失败',
      });
    }
  });
};

export { settingsRoutes };

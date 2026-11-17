import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../server';
import {
  DEFAULT_GEMINI_MODEL,
} from '../services/translation/geminiClient';
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
  return {
    configured: !!config,
    source: config ? 'user' : null,
    provider: config?.provider || 'tencent',
    secretId: config?.secretId || '',
    secretKeyMasked: config?.secretKey ? maskSecret(config.secretKey) : '',
    region: config?.region || 'ap-guangzhou',
    baseUrl: config?.baseUrl || DEFAULT_MTRAN_BASE_URL,
    apiTokenMasked: config?.apiToken ? maskSecret(config.apiToken) : '',
    geminiApiKeyMasked: geminiKey ? maskSecret(geminiKey) : '',
    geminiModel: DEFAULT_GEMINI_MODEL,
    geminiHasEnvKey: !!envGeminiKey,
    enabled: config?.enabled !== false,
    canEdit: true,
  };
}

function providerSaveMessage(provider: TranslationProvider): string {
  if (provider === 'mtran') return '本机 MTranServer 翻译配置已保存';
  if (provider === 'gemini') return 'Gemini 翻译配置已保存';
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
      // 切换到 Gemini 时不要沿用腾讯 SecretKey；优先保留已有 Gemini Key，否则走环境变量
      secretKey = current?.provider === 'gemini' ? current.secretKey || '' : '';
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
      if (provider === 'tencent' && body.secretId !== undefined) {
        payload.secretId = body.secretId;
      } else if (provider === 'tencent' && current?.provider === 'tencent') {
        payload.secretId = current.secretId;
      } else if (provider === 'tencent') {
        payload.secretId = String(body.secretId || '').trim();
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

import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../server';
import {
  DEFAULT_MTRAN_BASE_URL,
  getUserTranslationConfig,
  maskSecret,
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
  return {
    configured: !!config,
    source: config ? 'user' : null,
    provider: config?.provider || 'tencent',
    secretId: config?.secretId || '',
    secretKeyMasked: config?.secretKey ? maskSecret(config.secretKey) : '',
    region: config?.region || 'ap-guangzhou',
    baseUrl: config?.baseUrl || DEFAULT_MTRAN_BASE_URL,
    apiTokenMasked: config?.apiToken ? maskSecret(config.apiToken) : '',
    enabled: config?.enabled !== false,
    canEdit: true,
  };
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
    const provider = (String(body.provider || current?.provider || 'tencent').trim().toLowerCase() ===
    'mtran'
      ? 'mtran'
      : 'tencent') as TranslationProvider;

    const secretKeyInput = String(body.secretKey ?? '').trim();
    const secretKey =
      secretKeyInput && !secretKeyInput.includes('*')
        ? secretKeyInput
        : current?.secretKey || '';

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
      if (body.secretId !== undefined) payload.secretId = body.secretId;
      if (body.region !== undefined) payload.region = body.region;
      if (body.baseUrl !== undefined) payload.baseUrl = body.baseUrl;
      if (body.enabled !== undefined) payload.enabled = body.enabled;

      const saved = await saveUserTranslationConfig(userId, payload);
      invalidateTranslationClient(userId);

      return {
        message:
          saved.provider === 'mtran'
            ? '本机 MTranServer 翻译配置已保存'
            : '你的腾讯翻译配置已保存',
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

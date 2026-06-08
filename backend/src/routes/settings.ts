import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../server';
import {
  getUserTranslationConfig,
  maskSecret,
  saveUserTranslationConfig,
} from '../services/translation/translationConfig';
import { invalidateTencentClient, textTranslateEnToZh } from '../services/translation/tencentClient';

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

const settingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', verifyLoggedInUser);

  fastify.get('/translation', async (req: any) => {
    const userId = req.userId as number;
    const config = await getUserTranslationConfig(userId);
    return {
      configured: !!config,
      source: config ? 'user' : null,
      secretId: config?.secretId || '',
      secretKeyMasked: config ? maskSecret(config.secretKey) : '',
      region: config?.region || 'ap-guangzhou',
      enabled: config?.enabled !== false,
      canEdit: true,
    };
  });

  fastify.put('/translation', async (req: any, res: any) => {
    const userId = req.userId as number;
    const body = (req.body || {}) as {
      secretId?: string;
      secretKey?: string;
      region?: string;
      enabled?: boolean;
    };

    const current = await getUserTranslationConfig(userId);
    const secretKeyInput = String(body.secretKey ?? '').trim();
    const secretKey =
      secretKeyInput && !secretKeyInput.includes('*')
        ? secretKeyInput
        : current?.secretKey || '';

    try {
      const payload: {
        secretId?: string;
        secretKey?: string;
        region?: string;
        enabled?: boolean;
      } = { secretKey };
      if (body.secretId !== undefined) payload.secretId = body.secretId;
      if (body.region !== undefined) payload.region = body.region;
      if (body.enabled !== undefined) payload.enabled = body.enabled;

      const saved = await saveUserTranslationConfig(userId, payload);
      invalidateTencentClient(userId);

      return {
        message: '你的腾讯翻译配置已保存',
        configured: true,
        source: 'user',
        secretId: saved.secretId,
        secretKeyMasked: maskSecret(saved.secretKey),
        region: saved.region,
        enabled: saved.enabled,
        canEdit: true,
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

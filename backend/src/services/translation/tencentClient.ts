import {
  getEffectiveTranslationConfig,
  invalidateUserTranslationConfigCache,
} from './translationConfig';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const tencentcloud = require('tencentcloud-sdk-nodejs-tmt');
const TmtClient = tencentcloud.tmt.v20180321.Client;

const MAX_TEXT_LENGTH = 5800;

const clientCache = new Map<string, InstanceType<typeof TmtClient>>();

export function invalidateTencentClient(userId?: number): void {
  if (userId == null) {
    clientCache.clear();
    invalidateUserTranslationConfigCache();
    return;
  }

  const prefix = `${userId}:`;
  for (const key of clientCache.keys()) {
    if (key.startsWith(prefix)) clientCache.delete(key);
  }
  invalidateUserTranslationConfigCache(userId);
}

async function getClient(userId: number): Promise<InstanceType<typeof TmtClient>> {
  const config = await getEffectiveTranslationConfig(userId);
  if (!config) {
    throw new Error('请先在设置页配置腾讯翻译 SecretId / SecretKey');
  }
  if (!config.enabled) {
    throw new Error('翻译功能已关闭');
  }

  const clientKey = `${userId}:${config.secretId}:${config.secretKey}:${config.region}`;
  const cached = clientCache.get(clientKey);
  if (cached) return cached;

  const client = new TmtClient({
    credential: { secretId: config.secretId, secretKey: config.secretKey },
    region: config.region,
    profile: {
      httpProfile: { endpoint: 'tmt.tencentcloudapi.com' },
    },
  });
  clientCache.set(clientKey, client);
  return client;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export async function isTranslationEnabled(userId: number): Promise<boolean> {
  const config = await getEffectiveTranslationConfig(userId);
  return !!config && config.enabled;
}

export async function textTranslateEnToZh(userId: number, text: string): Promise<string> {
  const normalized = normalizeText(text);
  if (!normalized) return '';

  const client = await getClient(userId);
  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > 0) {
    const chunk = remaining.slice(0, MAX_TEXT_LENGTH);
    remaining = remaining.slice(MAX_TEXT_LENGTH);

    const response = await client.TextTranslate({
      SourceText: chunk,
      Source: 'en',
      Target: 'zh',
      ProjectId: 0,
    });

    const translated = String(response?.TargetText || '').trim();
    if (!translated) {
      throw new Error('腾讯翻译返回空结果');
    }
    chunks.push(translated);
  }

  return chunks.join('');
}

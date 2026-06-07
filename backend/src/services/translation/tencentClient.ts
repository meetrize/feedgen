// eslint-disable-next-line @typescript-eslint/no-var-requires
const tencentcloud = require('tencentcloud-sdk-nodejs-tmt');
const TmtClient = tencentcloud.tmt.v20180321.Client;

const MAX_TEXT_LENGTH = 5800;

let cachedClient: InstanceType<typeof TmtClient> | null = null;

function getClient(): InstanceType<typeof TmtClient> {
  if (cachedClient) return cachedClient;

  const secretId = process.env.TENCENT_TMT_SECRET_ID?.trim();
  const secretKey = process.env.TENCENT_TMT_SECRET_KEY?.trim();
  if (!secretId || !secretKey) {
    throw new Error('TENCENT_TMT_SECRET_ID / TENCENT_TMT_SECRET_KEY 未配置');
  }

  const region = (process.env.TENCENT_TMT_REGION || 'ap-guangzhou').trim();

  cachedClient = new TmtClient({
    credential: { secretId, secretKey },
    region,
    profile: {
      httpProfile: { endpoint: 'tmt.tencentcloudapi.com' },
    },
  });

  return cachedClient;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function isTranslationEnabled(): boolean {
  return process.env.TRANSLATION_ENABLED !== '0';
}

export async function textTranslateEnToZh(text: string): Promise<string> {
  const normalized = normalizeText(text);
  if (!normalized) return '';

  const client = getClient();
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

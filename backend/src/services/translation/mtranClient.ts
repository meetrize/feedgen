import {
  getEffectiveTranslationConfig,
  type TranslationConfig,
} from './translationConfig';

const MAX_TEXT_LENGTH = 4000;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildHeaders(config: TranslationConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.apiToken) {
    headers.Authorization = `Bearer ${config.apiToken}`;
  }
  return headers;
}

function extractTranslatedText(payload: any): string {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload.trim();
  if (typeof payload.result === 'string') return payload.result.trim();
  if (typeof payload.text === 'string') return payload.text.trim();
  if (typeof payload.translatedText === 'string') return payload.translatedText.trim();
  if (typeof payload.translation === 'string') return payload.translation.trim();
  if (Array.isArray(payload.translations) && payload.translations[0]) {
    const first = payload.translations[0];
    if (typeof first === 'string') return first.trim();
    if (typeof first?.text === 'string') return first.text.trim();
  }
  return '';
}

async function translateChunk(config: TranslationConfig, text: string): Promise<string> {
  const url = `${config.baseUrl}/translate`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify({
        from: 'en',
        to: 'zh-Hans',
        text,
        html: false,
      }),
    });
  } catch (err: any) {
    throw new Error(`无法连接本机翻译服务（${config.baseUrl}）：${err?.message || err}`);
  }

  const raw = await response.text();
  let payload: any = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = raw;
  }

  if (!response.ok) {
    const message =
      (payload && (payload.error || payload.message)) ||
      raw ||
      `HTTP ${response.status}`;
    throw new Error(`本机翻译服务返回错误：${message}`);
  }

  const translated = extractTranslatedText(payload);
  if (!translated) {
    throw new Error('本机翻译服务返回空结果');
  }
  return translated;
}

export async function mtranTranslateEnToZh(config: TranslationConfig, text: string): Promise<string> {
  const normalized = normalizeText(text);
  if (!normalized) return '';

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > 0) {
    const chunk = remaining.slice(0, MAX_TEXT_LENGTH);
    remaining = remaining.slice(MAX_TEXT_LENGTH);
    chunks.push(await translateChunk(config, chunk));
  }

  return chunks.join('');
}

export async function pingMtranService(config: TranslationConfig): Promise<void> {
  const url = `${config.baseUrl}/health`;
  let response: Response;
  try {
    response = await fetch(url, { method: 'GET' });
  } catch (err: any) {
    throw new Error(`无法连接本机翻译服务（${config.baseUrl}）：${err?.message || err}`);
  }
  if (!response.ok) {
    throw new Error(`本机翻译服务健康检查失败：HTTP ${response.status}`);
  }
}

export async function getMtranConfigOrThrow(userId: number): Promise<TranslationConfig> {
  const config = await getEffectiveTranslationConfig(userId);
  if (!config) {
    throw new Error('请先在设置页配置翻译服务');
  }
  if (!config.enabled) {
    throw new Error('翻译功能已关闭');
  }
  if (config.provider !== 'mtran') {
    throw new Error('当前未选择本机 MTranServer');
  }
  if (!config.baseUrl) {
    throw new Error('本机翻译服务地址未配置');
  }
  return config;
}

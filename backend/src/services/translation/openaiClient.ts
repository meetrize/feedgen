import axios from 'axios';
import {
  getEffectiveTranslationConfig,
  type TranslationConfig,
} from './translationConfig';

const DEFAULT_BASE_URL = 'http://192.168.31.60:3921/v1';
const DEFAULT_MODEL = 'bridge__deepseek';
const MAX_TEXT_LENGTH = 8000;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function resolveOpenAiBaseUrl(config: TranslationConfig): string {
  return (
    String(config.baseUrl || process.env.OPENAI_TRANSLATE_BASE_URL || DEFAULT_BASE_URL)
      .trim()
      .replace(/\/+$/, '') || DEFAULT_BASE_URL
  );
}

export function resolveOpenAiApiKey(config: TranslationConfig): string {
  return String(config.secretKey || process.env.OPENAI_TRANSLATE_API_KEY || '').trim();
}

export function resolveOpenAiModel(config: TranslationConfig): string {
  return (
    String(config.secretId || process.env.OPENAI_TRANSLATE_MODEL || DEFAULT_MODEL).trim() ||
    DEFAULT_MODEL
  );
}

function buildPrompt(text: string): string {
  return [
    'You are a professional translator.',
    'Translate the following English text into Simplified Chinese.',
    'Rules:',
    '- Output ONLY the Chinese translation',
    '- Do not add explanations, notes, labels, or quotation marks',
    '- Keep the original meaning and tone',
    '',
    'Text:',
    text,
  ].join('\n');
}

function extractTranslatedText(payload: any): string {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

async function translateChunk(config: TranslationConfig, text: string): Promise<string> {
  const baseUrl = resolveOpenAiBaseUrl(config);
  const apiKey = resolveOpenAiApiKey(config);
  const model = resolveOpenAiModel(config);
  if (!apiKey) {
    throw new Error('请先在设置页配置 OpenAI 兼容 API Key，或设置环境变量 OPENAI_TRANSLATE_API_KEY');
  }
  if (!baseUrl) {
    throw new Error('OpenAI 兼容接口地址不能为空');
  }

  const url = `${baseUrl}/chat/completions`;
  let response;
  try {
    response = await axios.post(
      url,
      {
        model,
        messages: [{ role: 'user', content: buildPrompt(text) }],
        temperature: 0.1,
        max_tokens: 2048,
      },
      {
        timeout: 60000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        validateStatus: () => true,
      },
    );
  } catch (err: any) {
    throw new Error(`无法连接 OpenAI 兼容翻译服务（${baseUrl}）：${err?.message || err}`);
  }

  const status = response.status;
  const payload = response.data;
  if (status < 200 || status >= 300) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      (typeof payload === 'string' ? payload : '') ||
      `HTTP ${status}`;
    throw new Error(`OpenAI 兼容翻译失败：${message}`);
  }

  const translated = extractTranslatedText(payload);
  if (!translated) {
    throw new Error('OpenAI 兼容翻译返回空结果');
  }
  return translated;
}

export async function openaiTranslateEnToZh(config: TranslationConfig, text: string): Promise<string> {
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

export async function getOpenAiConfigOrThrow(userId: number): Promise<TranslationConfig> {
  const config = await getEffectiveTranslationConfig(userId);
  if (!config) {
    throw new Error('请先在设置页配置翻译服务');
  }
  if (!config.enabled) {
    throw new Error('翻译功能已关闭');
  }
  if (config.provider !== 'openai') {
    throw new Error('当前未选择 OpenAI 兼容翻译');
  }
  if (!resolveOpenAiApiKey(config) || !resolveOpenAiBaseUrl(config)) {
    throw new Error('OpenAI 兼容翻译未配置完整（需要地址与 API Key）');
  }
  return config;
}

export {
  DEFAULT_BASE_URL as DEFAULT_OPENAI_TRANSLATE_BASE_URL,
  DEFAULT_MODEL as DEFAULT_OPENAI_TRANSLATE_MODEL,
};

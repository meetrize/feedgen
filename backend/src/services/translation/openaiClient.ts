import axios from 'axios';
import {
  getEffectiveTranslationConfig,
  type TranslationConfig,
} from './translationConfig';

const DEFAULT_BASE_URL = 'http://192.168.31.60:3921/v1';
const DEFAULT_MODEL = 'bridge__deepseek';
const MAX_TEXT_LENGTH = 8000;
const DEFAULT_CONCURRENCY = 1;
/** DeepSeek 网页桥限速较严，批量翻译默认间隔 8 秒 */
const DEFAULT_MIN_INTERVAL_MS = 8000;
const MAX_RETRIES_ON_RATE_LIMIT = 4;

type QueueItem = {
  run: () => Promise<void>;
};

class OpenAiRateLimiter {
  private active = 0;
  private queue: QueueItem[] = [];
  private lastStartedAt = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly concurrency: number,
    private readonly minIntervalMs: number,
  ) {}

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = {
        run: async () => {
          this.active += 1;
          this.lastStartedAt = Date.now();
          try {
            resolve(await fn());
          } catch (err) {
            reject(err);
          } finally {
            this.active -= 1;
            this.pump();
          }
        },
      };
      this.queue.push(item);
      this.pump();
    });
  }

  private pump(): void {
    if (this.active >= this.concurrency) return;
    const next = this.queue[0];
    if (!next) return;

    const wait = Math.max(0, this.minIntervalMs - (Date.now() - this.lastStartedAt));
    if (wait > 0) {
      if (this.wakeTimer) return;
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = null;
        this.pump();
      }, wait);
      return;
    }

    this.queue.shift();
    void next.run();
  }
}

const rateLimiter = new OpenAiRateLimiter(
  Math.max(
    1,
    Math.min(
      1,
      Number(process.env.OPENAI_TRANSLATE_CONCURRENCY || DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY,
    ),
  ),
  Math.max(
    2000,
    Number(process.env.OPENAI_TRANSLATE_MIN_INTERVAL_MS || DEFAULT_MIN_INTERVAL_MS) ||
      DEFAULT_MIN_INTERVAL_MS,
  ),
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function isRateLimitError(status: number, message: string): boolean {
  if (status === 429) return true;
  return /queue full|rate.?limit|too many requests|限流|频率/i.test(message);
}

async function translateOnce(config: TranslationConfig, text: string): Promise<string> {
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
    const err = new Error(`OpenAI 兼容翻译失败：${message}`);
    (err as any).statusCode = status;
    (err as any).rateLimited = isRateLimitError(status, String(message));
    throw err;
  }

  const translated = extractTranslatedText(payload);
  if (!translated) {
    throw new Error('OpenAI 兼容翻译返回空结果');
  }
  return translated;
}

async function translateChunk(config: TranslationConfig, text: string): Promise<string> {
  return rateLimiter.schedule(async () => {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES_ON_RATE_LIMIT; attempt += 1) {
      try {
        return await translateOnce(config, text);
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (err?.rateLimited && attempt < MAX_RETRIES_ON_RATE_LIMIT - 1) {
          const backoff = 4000 * (attempt + 1);
          console.warn(
            `[OpenAiTranslate] 限流/队列满，${backoff}ms 后重试 (${attempt + 1}/${MAX_RETRIES_ON_RATE_LIMIT - 1})`,
          );
          await sleep(backoff);
          continue;
        }
        throw lastError;
      }
    }
    throw lastError || new Error('OpenAI 兼容翻译失败');
  });
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

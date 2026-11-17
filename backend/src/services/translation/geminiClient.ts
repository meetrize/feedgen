import axios from 'axios';
import {
  isLocalProxyAvailable,
  withAxiosProxy,
} from '../proxyConfig';
import {
  getEffectiveTranslationConfig,
  type TranslationConfig,
} from './translationConfig';

// 新 Key 已无法使用 gemini-2.5-flash；默认改用官方推荐的 gemini-3.8-flash
const DEFAULT_MODEL = 'gemini-3.8-flash';
const DEFAULT_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_TEXT_LENGTH = 8000;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_MIN_INTERVAL_MS = 1000;
const MAX_RETRIES_ON_429 = 3;

type QueueItem = {
  run: () => Promise<void>;
};

class GeminiRateLimiter {
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

const rateLimiter = new GeminiRateLimiter(
  Math.max(1, Math.min(2, Number(process.env.GEMINI_TRANSLATE_CONCURRENCY || DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY)),
  Math.max(
    1000,
    Number(process.env.GEMINI_TRANSLATE_MIN_INTERVAL_MS || DEFAULT_MIN_INTERVAL_MS) || DEFAULT_MIN_INTERVAL_MS,
  ),
);

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function getModel(): string {
  return String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

function getApiBase(): string {
  return String(process.env.GEMINI_API_BASE_URL || DEFAULT_API_BASE).trim().replace(/\/+$/, '') || DEFAULT_API_BASE;
}

export function resolveGeminiApiKey(config: TranslationConfig): string {
  return String(config.secretKey || process.env.GEMINI_API_KEY || '').trim();
}

function extractTranslatedText(payload: any): string {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  const texts = parts
    .filter((p: any) => p && typeof p.text === 'string' && !p.thought)
    .map((p: any) => String(p.text || '').trim())
    .filter(Boolean);
  return texts.join('\n').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function translateOnce(apiKey: string, text: string): Promise<string> {
  const model = getModel();
  const url = `${getApiBase()}/models/${encodeURIComponent(model)}:generateContent`;
  const useProxy = await isLocalProxyAvailable();
  if (!useProxy) {
    console.warn('[GeminiTranslate] 本机 7890 代理不可用，将尝试直连 Gemini API');
  }

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: buildPrompt(text) }],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      // 关闭思考模式，降低延迟与 token 消耗
      thinkingConfig: {
        thinkingBudget: 0,
      },
    },
  };

  const requestConfig = withAxiosProxy(
    {
      timeout: 60000,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      validateStatus: () => true,
    },
    useProxy,
  );

  const response = await axios.post(url, body, requestConfig);
  const status = response.status;
  const payload = response.data;

  if (status === 429) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      `HTTP ${status}`;
    const err = new Error(`Gemini 触发限流（429）：${message}`);
    (err as any).statusCode = 429;
    throw err;
  }

  if (status < 200 || status >= 300) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      (typeof payload === 'string' ? payload : '') ||
      `HTTP ${status}`;
    throw new Error(`Gemini 翻译失败：${message}`);
  }

  const translated = extractTranslatedText(payload);
  if (!translated) {
    throw new Error('Gemini 返回空翻译结果');
  }
  return translated;
}

async function translateChunk(apiKey: string, text: string): Promise<string> {
  return rateLimiter.schedule(async () => {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES_ON_429; attempt += 1) {
      try {
        return await translateOnce(apiKey, text);
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (err?.statusCode === 429 && attempt < MAX_RETRIES_ON_429 - 1) {
          const backoff = 1500 * (attempt + 1);
          console.warn(`[GeminiTranslate] 429，${backoff}ms 后重试 (${attempt + 1}/${MAX_RETRIES_ON_429 - 1})`);
          await sleep(backoff);
          continue;
        }
        throw lastError;
      }
    }
    throw lastError || new Error('Gemini 翻译失败');
  });
}

export async function geminiTranslateEnToZh(config: TranslationConfig, text: string): Promise<string> {
  const apiKey = resolveGeminiApiKey(config);
  if (!apiKey) {
    throw new Error('请先在设置页配置 Gemini API Key，或设置环境变量 GEMINI_API_KEY');
  }

  const normalized = normalizeText(text);
  if (!normalized) return '';

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, MAX_TEXT_LENGTH);
    remaining = remaining.slice(MAX_TEXT_LENGTH);
    chunks.push(await translateChunk(apiKey, chunk));
  }
  return chunks.join('');
}

export async function getGeminiConfigOrThrow(userId: number): Promise<TranslationConfig> {
  const config = await getEffectiveTranslationConfig(userId);
  if (!config) {
    throw new Error('请先在设置页配置翻译服务');
  }
  if (!config.enabled) {
    throw new Error('翻译功能已关闭');
  }
  if (config.provider !== 'gemini') {
    throw new Error('当前未选择 Gemini 翻译');
  }
  if (!resolveGeminiApiKey(config)) {
    throw new Error('Gemini API Key 未配置');
  }
  return config;
}

export { DEFAULT_MODEL as DEFAULT_GEMINI_MODEL };

import axios from 'axios';
import {
  getEffectiveTranslationConfig,
  type TranslationConfig,
} from './translationConfig';

/** bilibili Index-Translate 免费公开 API（OpenAI 兼容） */
const DEFAULT_BASE_URL = 'https://index-translate.bilibili.com/v1';
const DEFAULT_MODEL = 'Index-Translate-35B-A3B';
const MAX_TEXT_LENGTH = 6000;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_MIN_INTERVAL_MS = 1500;
const MAX_RETRIES_ON_RATE_LIMIT = 3;

type QueueItem = {
  run: () => Promise<void>;
};

class IndexTranslateRateLimiter {
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

const rateLimiter = new IndexTranslateRateLimiter(
  Math.max(
    1,
    Math.min(
      2,
      Number(process.env.INDEX_TRANSLATE_CONCURRENCY || DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY,
    ),
  ),
  Math.max(
    500,
    Number(process.env.INDEX_TRANSLATE_MIN_INTERVAL_MS || DEFAULT_MIN_INTERVAL_MS) ||
      DEFAULT_MIN_INTERVAL_MS,
  ),
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function resolveIndexTranslateBaseUrl(config: TranslationConfig): string {
  return (
    String(config.baseUrl || process.env.INDEX_TRANSLATE_BASE_URL || DEFAULT_BASE_URL)
      .trim()
      .replace(/\/+$/, '') || DEFAULT_BASE_URL
  );
}

export function resolveIndexTranslateModel(config: TranslationConfig): string {
  return (
    String(config.secretId || process.env.INDEX_TRANSLATE_MODEL || DEFAULT_MODEL).trim() ||
    DEFAULT_MODEL
  );
}

/** 与官方 call_api.py / translate.py 对齐的提示词 */
function buildPrompt(text: string): string {
  return `请将以下英语文本翻译为中文，直接输出翻译结果，不要进行任何解释。\n\n${text}`;
}

/** 去掉可能残留的思考块 */
function stripThink(text: string): string {
  let out = String(text || '');
  // </think> 或类似结束标记后的正文
  const endThink = out.match(/<\/think>\s*([\s\S]*)$/i);
  if (endThink) out = endThink[1] || '';
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, '');
  return out.trim();
}

function extractTranslatedText(payload: any): string {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return stripThink(content);
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
    return stripThink(joined);
  }
  return '';
}

function isRateLimitError(status: number, message: string): boolean {
  if (status === 429) return true;
  return /rate.?limit|too many requests|限流|繁忙|quota/i.test(message);
}

async function translateOnce(config: TranslationConfig, text: string): Promise<string> {
  const baseUrl = resolveIndexTranslateBaseUrl(config);
  const model = resolveIndexTranslateModel(config);
  const url = `${baseUrl}/chat/completions`;

  let response;
  try {
    response = await axios.post(
      url,
      {
        model,
        messages: [{ role: 'user', content: buildPrompt(text) }],
        temperature: 0.0,
        max_tokens: 2048,
        // 与官方脚本一致：关闭思考，避免 CoT 挤占译文
        chat_template_kwargs: { enable_thinking: false },
      },
      {
        timeout: 120000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Index-Translate-Client/1.0',
        },
        validateStatus: () => true,
      },
    );
  } catch (err: any) {
    throw new Error(`无法连接 Index-Translate（${baseUrl}）：${err?.message || err}`);
  }

  const status = response.status;
  const payload = response.data;
  if (status < 200 || status >= 300) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      (typeof payload === 'string' ? payload : '') ||
      `HTTP ${status}`;
    const err = new Error(`Index-Translate 翻译失败：${message}`);
    (err as any).statusCode = status;
    (err as any).rateLimited = isRateLimitError(status, String(message));
    throw err;
  }

  const translated = extractTranslatedText(payload);
  if (!translated) {
    throw new Error('Index-Translate 返回空翻译结果');
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
          const backoff = 2000 * (attempt + 1);
          console.warn(
            `[IndexTranslate] 限流，${backoff}ms 后重试 (${attempt + 1}/${MAX_RETRIES_ON_RATE_LIMIT - 1})`,
          );
          await sleep(backoff);
          continue;
        }
        throw lastError;
      }
    }
    throw lastError || new Error('Index-Translate 翻译失败');
  });
}

export async function indexTranslateEnToZh(
  config: TranslationConfig,
  text: string,
): Promise<string> {
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

export async function getIndexTranslateConfigOrThrow(userId: number): Promise<TranslationConfig> {
  const config = await getEffectiveTranslationConfig(userId);
  if (!config) {
    throw new Error('请先在设置页配置翻译服务');
  }
  if (!config.enabled) {
    throw new Error('翻译功能已关闭');
  }
  if (config.provider !== 'index') {
    throw new Error('当前未选择 Index-Translate');
  }
  if (!resolveIndexTranslateBaseUrl(config)) {
    throw new Error('Index-Translate 接口地址未配置');
  }
  return config;
}

export {
  DEFAULT_BASE_URL as DEFAULT_INDEX_TRANSLATE_BASE_URL,
  DEFAULT_MODEL as DEFAULT_INDEX_TRANSLATE_MODEL,
};

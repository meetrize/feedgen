import axios from 'axios';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-flash';

export type DeepSeekChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type DeepSeekChatResult = {
  content: string;
  model: string;
};

export function getDeepSeekConfig() {
  const apiKey = String(process.env.DEEPSEEK_API_KEY || '').trim();
  const baseUrl = String(process.env.DEEPSEEK_API_BASE_URL || DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, '');
  const model = String(process.env.DEEPSEEK_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  return { apiKey, baseUrl, model };
}

export async function chatWithDeepSeek(input: {
  messages: DeepSeekChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<DeepSeekChatResult> {
  const { apiKey, baseUrl, model } = getDeepSeekConfig();
  if (!apiKey) {
    throw Object.assign(new Error('未配置 DEEPSEEK_API_KEY，无法调用 AI'), {
      code: 'AI_NOT_CONFIGURED',
    });
  }
  if (!input.messages?.length) {
    throw Object.assign(new Error('messages 不能为空'), { code: 'AI_BAD_REQUEST' });
  }

  const endpoint = `${baseUrl}/chat/completions`;
  let response;
  try {
    response = await axios.post(
      endpoint,
      {
        model,
        messages: input.messages,
        temperature: input.temperature ?? 0.4,
        max_tokens: input.maxTokens ?? 4096,
        thinking: { type: 'disabled' },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: input.timeoutMs ?? 120_000,
        validateStatus: () => true,
      },
    );
  } catch (error: unknown) {
    throw Object.assign(
      new Error(`调用 DeepSeek 失败：${error instanceof Error ? error.message : String(error)}`),
      { code: 'AI_REQUEST_FAILED' },
    );
  }

  if (response.status < 200 || response.status >= 300) {
    const detail =
      typeof response.data === 'string'
        ? response.data
        : response.data?.error?.message ||
          response.data?.message ||
          `DeepSeek HTTP ${response.status}`;
    throw Object.assign(new Error(String(detail)), { code: 'AI_HTTP_ERROR', status: response.status });
  }

  const content = String(response.data?.choices?.[0]?.message?.content || '').trim();
  if (!content) {
    throw Object.assign(new Error('DeepSeek 未返回有效内容'), { code: 'AI_EMPTY_RESPONSE' });
  }

  return {
    content,
    model: String(response.data?.model || model),
  };
}

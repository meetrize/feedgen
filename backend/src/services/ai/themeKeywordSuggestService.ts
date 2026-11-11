import { chatWithDeepSeek } from './deepseekChat';
import { normalizeThemeKeywordList } from '../theme/themeKeywordNorm';

const PROMPT_VERSION = 'theme-kw-v1';

export type ThemeKeywordSuggestInput = {
  name: string;
  existing_keywords?: string[];
};

export type ThemeKeywordSuggestResult = {
  keywords: string[];
  model: string;
  prompt_version: string;
};

function extractJsonArray(text: string): unknown {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function suggestThemeKeywords(
  input: ThemeKeywordSuggestInput,
): Promise<ThemeKeywordSuggestResult> {
  const name = String(input.name || '').trim();
  if (!name) {
    throw Object.assign(new Error('主题名称不能为空'), { code: 'AI_BAD_REQUEST' });
  }

  const existing = normalizeThemeKeywordList(input.existing_keywords || []);
  const existingLine = existing.length
    ? `已有关键词（请补充相关但未列出的词，避免重复）：${existing.join('、')}`
    : '尚无关键词，请给出一组常用关联词。';

  const result = await chatWithDeepSeek({
    messages: [
      {
        role: 'system',
        content: [
          '你是资讯订阅助手，帮助用户为「订阅主题」补充关联关键词。',
          '只输出 JSON 数组（字符串列表），不要 Markdown，不要解释。',
          '关键词要短、具体、可在新闻标题/摘要中直接匹配；中英文均可。',
          '数量控制在 8–20 个；不要输出主题名本身的无意义重复。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `主题名称：${name}`,
          existingLine,
          '请返回 JSON 数组，例如：["关键词1","关键词2"]',
        ].join('\n'),
      },
    ],
    temperature: 0.3,
    maxTokens: 800,
    timeoutMs: 60_000,
  });

  const parsed = extractJsonArray(result.content);
  const keywords = normalizeThemeKeywordList(parsed);
  if (!keywords.length) {
    throw Object.assign(new Error('AI 未返回有效关键词'), { code: 'AI_EMPTY_RESPONSE' });
  }

  // 过滤已有关键词（规范化后）
  const existingNorm = new Set(
    existing.map((k) => k.replace(/\s+/g, '').toLowerCase()),
  );
  const merged = keywords.filter((k) => !existingNorm.has(k.replace(/\s+/g, '').toLowerCase()));

  return {
    keywords: merged.length ? merged : keywords,
    model: result.model,
    prompt_version: PROMPT_VERSION,
  };
}

import axios from 'axios';

export type AiParseSelectors = {
  list: string;
  title: string;
  link: string;
  description?: string;
  date?: string;
  author?: string;
  thumbnail?: string;
};

export type AiParseResult = {
  selectors: AiParseSelectors;
  confidence: number | null;
  reason: string;
  model: string;
  truncated: boolean;
  htmlCharsSent: number;
};

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-flash';
const DEFAULT_MAX_HTML_CHARS = 180_000;

function getConfig() {
  const apiKey = String(process.env.DEEPSEEK_API_KEY || '').trim();
  const baseUrl = String(process.env.DEEPSEEK_API_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const model = String(process.env.DEEPSEEK_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const maxHtmlCharsRaw = Number(process.env.DEEPSEEK_MAX_HTML_CHARS || DEFAULT_MAX_HTML_CHARS);
  const maxHtmlChars =
    Number.isFinite(maxHtmlCharsRaw) && maxHtmlCharsRaw >= 20_000
      ? Math.floor(maxHtmlCharsRaw)
      : DEFAULT_MAX_HTML_CHARS;
  return { apiKey, baseUrl, model, maxHtmlChars };
}

/** 压缩 HTML：去掉脚本/样式/SVG/注释与多余空白，控制发给模型的体积 */
export function compactHtmlForAi(html: string, maxChars = DEFAULT_MAX_HTML_CHARS): {
  html: string;
  truncated: boolean;
  originalLength: number;
} {
  const originalLength = String(html || '').length;
  let s = String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  let truncated = false;
  if (s.length > maxChars) {
    s = `${s.slice(0, maxChars)}\n<!-- truncated for AI -->`;
    truncated = true;
  }
  return { html: s, truncated, originalLength };
}

function stripCodeFence(text: string): string {
  const raw = String(text || '').trim();
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const inner = fenced && typeof fenced[1] === 'string' ? fenced[1] : raw;
  return inner.trim();
}

function asSelector(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeAiSelectors(payload: any): AiParseSelectors {
  const src = payload?.selectors && typeof payload.selectors === 'object' ? payload.selectors : payload;
  const list = asSelector(src?.list || src?.listSelector || src?.循环列表);
  const title = asSelector(src?.title || src?.titleSelector || src?.标题);
  const link = asSelector(src?.link || src?.linkSelector || src?.链接 || src?.url);
  if (!list || !title || !link) {
    throw Object.assign(new Error('AI 返回缺少必须字段 list / title / link'), { code: 'AI_PARSE_INCOMPLETE' });
  }

  const out: AiParseSelectors = { list, title, link };
  const description = asSelector(src?.description || src?.desc || src?.描述);
  const date = asSelector(src?.date || src?.time || src?.日期 || src?.发布时间);
  const author = asSelector(src?.author || src?.作者);
  const thumbnail = asSelector(src?.thumbnail || src?.image || src?.缩略图 || src?.封面);
  if (description) out.description = description;
  if (date) out.date = date;
  if (author) out.author = author;
  if (thumbnail) out.thumbnail = thumbnail;
  return out;
}

function buildPrompt(pageUrl: string, compactHtml: string): { system: string; user: string } {
  const system = [
    '你是资深网页结构分析与 CSS 选择器专家。',
    '任务：从给定 HTML 中找出最像「新闻/文章列表」的主体区域，并给出可用于爬虫的 CSS 选择器。',
    '必须返回 JSON 对象，不要输出其它说明文字。',
    '字段要求：',
    '1) list：循环列表项的选择器（匹配多条同质条目；不要用会随条目变化的唯一 id；尽量去掉不稳定的 :nth-of-type）',
    '2) title：某一条目中标题节点的「绝对 CSS 路径」（从 body/main 往下写完整层级，包含足够祖先，便于 querySelector 唯一定位）',
    '3) link：某一条目中文章链接（优先 a[href]）的绝对 CSS 路径',
    '4) description/date/author/thumbnail：若能稳定定位则返回绝对路径，否则省略该字段',
    '5) confidence：0~1 置信度；reason：一句话说明依据',
    '选择器必须是标准 CSS，能被 document.querySelector / querySelectorAll 使用。',
    '禁止只返回过于简短的相对片段（如单独的 h2、a、.title）；title/link 等字段请给出可唯一定位到「某一个列表项内节点」的完整路径。',
    '优先选择语义清晰、重复结构稳定的新闻列表，忽略导航、侧栏、页脚、广告。',
  ].join('\n');

  const user = [
    `页面 URL: ${pageUrl || '(unknown)'}`,
    '请分析下面 HTML，并严格按如下 JSON schema 返回：',
    '{',
    '  "list": "string",',
    '  "title": "string",',
    '  "link": "string",',
    '  "description": "string?",',
    '  "date": "string?",',
    '  "author": "string?",',
    '  "thumbnail": "string?",',
    '  "confidence": 0.0,',
    '  "reason": "string"',
    '}',
    '',
    'HTML:',
    compactHtml,
  ].join('\n');

  return { system, user };
}

export async function parseHtmlSelectorsWithDeepSeek(input: {
  html: string;
  pageUrl?: string;
}): Promise<AiParseResult> {
  const { apiKey, baseUrl, model, maxHtmlChars } = getConfig();
  if (!apiKey) {
    throw Object.assign(new Error('未配置 DEEPSEEK_API_KEY，无法调用 AI 解析'), { code: 'AI_NOT_CONFIGURED' });
  }

  const compact = compactHtmlForAi(input.html, maxHtmlChars);
  if (!compact.html) {
    throw Object.assign(new Error('HTML 为空，无法解析'), { code: 'EMPTY_HTML' });
  }

  const { system, user } = buildPrompt(String(input.pageUrl || ''), compact.html);
  const endpoint = `${baseUrl}/chat/completions`;

  let response;
  try {
    response = await axios.post(
      endpoint,
      {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
        // Flash 支持 thinking；结构化抽取场景关闭以降低延迟与费用
        thinking: { type: 'disabled' },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 120_000,
        validateStatus: () => true,
      }
    );
  } catch (error: any) {
    throw Object.assign(new Error(`调用 DeepSeek 失败：${error?.message || error}`), {
      code: 'AI_REQUEST_FAILED',
    });
  }

  if (response.status < 200 || response.status >= 300) {
    const msg =
      response.data?.error?.message ||
      response.data?.message ||
      `DeepSeek HTTP ${response.status}`;
    throw Object.assign(new Error(String(msg)), { code: 'AI_HTTP_ERROR', status: response.status });
  }

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw Object.assign(new Error('DeepSeek 未返回有效内容'), { code: 'AI_EMPTY_RESPONSE' });
  }

  let parsed: any;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch {
    throw Object.assign(new Error('DeepSeek 返回的不是合法 JSON'), {
      code: 'AI_BAD_JSON',
      raw: String(content).slice(0, 500),
    });
  }

  const selectors = normalizeAiSelectors(parsed);
  const confidenceRaw = Number(parsed?.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : null;
  const reason = String(parsed?.reason || '').trim() || 'AI 已给出候选选择器';

  return {
    selectors,
    confidence,
    reason,
    model,
    truncated: compact.truncated,
    htmlCharsSent: compact.html.length,
  };
}

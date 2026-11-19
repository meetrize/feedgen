import { chatWithDeepSeek } from '../ai/deepseekChat';
import type { FutureScanConfig } from './futureScanConfig';

export type ExtractedCalendarEvent = {
  name: string;
  start_at: string;
  end_at: string | null;
  std_type_code: string;
  fe_type: string;
  sponsor: string;
  city: string;
  summary: string;
};

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? '');
}

function stripJsonFence(raw: string): string {
  let s = String(raw || '').trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  return s.trim();
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const text = stripJsonFence(raw);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    }
  }
  throw Object.assign(new Error('AI 返回非 JSON 对象'), { code: 'AI_BAD_JSON' });
}

export async function screenTitleForFuture(
  cfg: FutureScanConfig,
  input: { title: string; today: string },
): Promise<{ hit: boolean; reason: string }> {
  const user = fillTemplate(cfg.titleUserPromptTemplate, {
    title: input.title,
    today: input.today,
  });
  const result = await chatWithDeepSeek({
    messages: [
      { role: 'system', content: cfg.titleSystemPrompt },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    maxTokens: 256,
  });
  const obj = parseJsonObject(result.content);
  return {
    hit: Boolean(obj.hit),
    reason: String(obj.reason || '').slice(0, 500),
  };
}

export async function extractFutureEvents(
  cfg: FutureScanConfig,
  input: {
    title: string;
    body: string;
    today: string;
    articleUrl: string;
    articleId: number;
  },
): Promise<ExtractedCalendarEvent[]> {
  const user = fillTemplate(cfg.extractUserPromptTemplate, {
    title: input.title,
    body: input.body || '（无正文）',
    today: input.today,
    article_url: input.articleUrl || '',
    article_id: String(input.articleId),
  });
  const result = await chatWithDeepSeek({
    messages: [
      { role: 'system', content: cfg.extractSystemPrompt },
      { role: 'user', content: user },
    ],
    temperature: 0.25,
    maxTokens: 2048,
  });
  const obj = parseJsonObject(result.content);
  const rawEvents = Array.isArray(obj.events) ? obj.events : [];
  const out: ExtractedCalendarEvent[] = [];
  for (const item of rawEvents) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const name = String(e.name || '').trim();
    const startAt = String(e.start_at || '').trim();
    if (!name || !startAt) continue;
    let std = String(e.std_type_code || '3').trim();
    if (std !== '1' && std !== '2' && std !== '3') std = '3';
    const endRaw = e.end_at == null || e.end_at === '' ? null : String(e.end_at).trim();
    out.push({
      name: name.slice(0, 200),
      start_at: startAt,
      end_at: endRaw || null,
      std_type_code: std,
      fe_type: String(e.fe_type || '').trim().slice(0, 80),
      sponsor: String(e.sponsor || '').trim().slice(0, 120),
      city: String(e.city || '').trim().slice(0, 80),
      summary: String(e.summary || '').trim().slice(0, 1000),
    });
  }
  return out;
}

export type DedupeJudgeResult = {
  same_as_fe_code: string | null;
  confidence: number;
  reason: string;
};

export async function judgeSameCalendarEvent(
  cfg: FutureScanConfig,
  input: {
    today: string;
    newEvent: Record<string, unknown>;
    candidates: Array<Record<string, unknown>>;
  },
): Promise<DedupeJudgeResult> {
  const user = fillTemplate(cfg.dedupeUserPromptTemplate, {
    today: input.today,
    new_event: JSON.stringify(input.newEvent, null, 0),
    candidates: JSON.stringify(input.candidates, null, 0),
  });
  const result = await chatWithDeepSeek({
    messages: [
      { role: 'system', content: cfg.dedupeSystemPrompt },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
    maxTokens: 384,
  });
  const obj = parseJsonObject(result.content);
  const codeRaw = obj.same_as_fe_code;
  const code =
    codeRaw == null || codeRaw === '' || codeRaw === 'null'
      ? null
      : String(codeRaw).trim();
  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  return {
    same_as_fe_code: code || null,
    confidence,
    reason: String(obj.reason || '').slice(0, 200),
  };
}

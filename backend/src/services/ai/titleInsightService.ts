/**
 * 兼容旧 POST /api/ai/titles：内部转调对应用户的内置配方。
 * 无 userId 时回退到默认提示词（极少路径）。
 */
import { chatWithDeepSeek } from './deepseekChat';
import {
  TITLE_INSIGHT_PROMPT_VERSION,
  buildTitleInsightPrompt,
  type TitleInsightMode,
} from './titleInsightPrompts';
import { findBuiltinRecipe, runInsightRecipe } from './insightRecipeService';

const MAX_TITLES = 120;
const MAX_TITLE_CHARS = 240;

export type TitleInsightInput = {
  mode: TitleInsightMode;
  titles: string[];
  scope_label?: string;
  userId?: number;
};

export type TitleInsightResult = {
  mode: TitleInsightMode;
  mode_label: string;
  content: string;
  model: string;
  prompt_version: string;
  title_count: number;
  recipe_id?: number;
};

function normalizeTitles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    let t = String(item || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (t.length > MAX_TITLE_CHARS) t = `${t.slice(0, MAX_TITLE_CHARS)}…`;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_TITLES) break;
  }
  return out;
}

export async function runTitleInsight(input: TitleInsightInput): Promise<TitleInsightResult> {
  const mode = input.mode === 'mining' ? 'mining' : 'summary';
  const titles = normalizeTitles(input.titles);
  if (!titles.length) {
    throw Object.assign(new Error('标题列表为空'), { code: 'EMPTY_TITLES' });
  }

  if (input.userId && Number.isFinite(input.userId) && input.userId > 0) {
    const recipe = await findBuiltinRecipe(input.userId, mode);
    if (recipe) {
      const runInput: { titles: string[]; scope_label?: string } = { titles };
      if (input.scope_label?.trim()) runInput.scope_label = input.scope_label.trim();
      const result = await runInsightRecipe(input.userId, recipe.id, runInput);
      return {
        mode,
        mode_label: result.mode_label,
        content: result.content,
        model: result.model,
        prompt_version: result.prompt_version,
        title_count: result.title_count,
        recipe_id: result.recipe_id,
      };
    }
  }

  const promptInput: {
    mode: TitleInsightMode;
    titles: string[];
    scopeLabel?: string;
  } = { mode, titles };
  if (input.scope_label?.trim()) promptInput.scopeLabel = input.scope_label.trim();
  const prompt = buildTitleInsightPrompt(promptInput);

  const result = await chatWithDeepSeek({
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    temperature: mode === 'mining' ? 0.35 : 0.4,
    maxTokens: 4096,
    timeoutMs: 120_000,
  });

  return {
    mode,
    mode_label: prompt.modeLabel,
    content: result.content,
    model: result.model,
    prompt_version: TITLE_INSIGHT_PROMPT_VERSION,
    title_count: titles.length,
  };
}

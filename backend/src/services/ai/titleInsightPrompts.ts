/** @deprecated 兼容旧调用；新逻辑见 insightRecipeDefaults / insightRecipeService */
export type TitleInsightMode = 'summary' | 'mining';

export {
  INSIGHT_RECIPE_PROMPT_VERSION as TITLE_INSIGHT_PROMPT_VERSION,
} from './insightRecipeDefaults';

import { getBuiltinRecipeDefaults } from './insightRecipeDefaults';

export function buildTitleInsightPrompt(input: {
  mode: TitleInsightMode;
  titles: string[];
  scopeLabel?: string;
}): { system: string; user: string; modeLabel: string } {
  const titles = input.titles.map((t) => String(t || '').trim()).filter(Boolean);
  const titlesBlock = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const scopeLabel = String(input.scopeLabel || '当前阅读列表').trim() || '当前阅读列表';
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const vars: Record<string, string> = {
    scope_label: scopeLabel,
    title_count: String(titles.length),
    titles_block: titlesBlock || '(无标题)',
    today: todayStr,
  };

  const fill = (template: string) =>
    template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? '');

  const defaults = getBuiltinRecipeDefaults(input.mode === 'mining' ? 'mining' : 'summary');
  return {
    system: fill(defaults.system_prompt),
    user: fill(defaults.user_prompt_template),
    modeLabel: defaults.name,
  };
}

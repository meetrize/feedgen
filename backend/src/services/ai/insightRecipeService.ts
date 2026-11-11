import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../server';
import { chatWithDeepSeek } from './deepseekChat';
import {
  BUILTIN_INSIGHT_RECIPES,
  INSIGHT_RECIPE_PROMPT_VERSION,
  getBuiltinRecipeDefaults,
  isBuiltinRecipeKey,
  type BuiltinRecipeKey,
  type InsightContextField,
} from './insightRecipeDefaults';

export type { InsightContextField, BuiltinRecipeKey };

const MAX_ITEMS = 120;
const MAX_TITLE_CHARS = 240;
const MAX_SUMMARY_CHARS = 280;
const MAX_SOURCE_CHARS = 80;
const MAX_RUNS_PER_SCOPE_DAY = 20;
const RUN_RETENTION_DAYS = 30;

export type InsightListItem = {
  title?: string;
  summary?: string;
  source?: string;
};

export type InsightRecipeDto = {
  id: number;
  builtin_key: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  system_prompt: string;
  user_prompt_template: string;
  context_fields: InsightContextField[];
  enabled: boolean;
  is_builtin: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type InsightRecipeRunResult = {
  recipe_id: number;
  mode: string;
  mode_label: string;
  content: string;
  model: string;
  prompt_version: string;
  title_count: number;
  run_id?: number;
  created_at?: string;
  cached?: boolean;
  scope_key?: string;
  scope_label?: string;
  run_day?: string;
  input_fingerprint?: string | null;
};

export type InsightRecipeRunDto = {
  id: number;
  recipe_id: number;
  scope_key: string;
  scope_label: string;
  run_day: string;
  title_count: number;
  content: string;
  model: string | null;
  prompt_version: string | null;
  recipe_name_snapshot: string;
  input_fingerprint: string | null;
  created_at: string;
  mode_label: string;
  cached?: boolean | undefined;
};

function parseContextFields(raw: unknown): InsightContextField[] {
  const allowed = new Set<InsightContextField>(['title', 'summary', 'source']);
  let arr: unknown[] = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      arr = [];
    }
  }
  const out: InsightContextField[] = [];
  for (const item of arr) {
    const key = String(item || '').trim() as InsightContextField;
    if (!allowed.has(key) || out.includes(key)) continue;
    out.push(key);
  }
  if (!out.includes('title')) out.unshift('title');
  return out.length ? out : ['title'];
}

function toDto(row: {
  id: number;
  builtin_key: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  system_prompt: string;
  user_prompt_template: string;
  context_fields: unknown;
  enabled: boolean;
  is_builtin: boolean;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}): InsightRecipeDto {
  return {
    id: row.id,
    builtin_key: row.builtin_key,
    name: row.name,
    description: row.description,
    icon: row.icon,
    system_prompt: row.system_prompt,
    user_prompt_template: row.user_prompt_template,
    context_fields: parseContextFields(row.context_fields),
    enabled: row.enabled,
    is_builtin: row.is_builtin,
    sort_order: row.sort_order,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** 首次访问时为用户 seed 内置总结/挖掘配方 */
export async function ensureBuiltinRecipes(userId: number): Promise<void> {
  const existing = await prisma.userInsightRecipe.findMany({
    where: { user_id: userId, is_builtin: true },
    select: { builtin_key: true },
  });
  const have = new Set(
    existing
      .map((r: { builtin_key: string | null }) => r.builtin_key)
      .filter((k: string | null): k is string => Boolean(k))
  );
  const missing = BUILTIN_INSIGHT_RECIPES.filter((d) => !have.has(d.builtin_key));
  if (!missing.length) return;

  await prisma.userInsightRecipe.createMany({
    data: missing.map((d) => ({
      user_id: userId,
      builtin_key: d.builtin_key,
      name: d.name,
      description: d.description,
      icon: d.icon,
      system_prompt: d.system_prompt,
      user_prompt_template: d.user_prompt_template,
      context_fields: d.context_fields as unknown as Prisma.InputJsonValue,
      enabled: true,
      is_builtin: true,
      sort_order: d.sort_order,
    })),
    skipDuplicates: true,
  });
}

export async function listInsightRecipes(userId: number): Promise<InsightRecipeDto[]> {
  await ensureBuiltinRecipes(userId);
  const rows = await prisma.userInsightRecipe.findMany({
    where: { user_id: userId },
    orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toDto);
}

export async function getInsightRecipe(
  userId: number,
  recipeId: number
): Promise<InsightRecipeDto | null> {
  await ensureBuiltinRecipes(userId);
  const row = await prisma.userInsightRecipe.findFirst({
    where: { id: recipeId, user_id: userId },
  });
  return row ? toDto(row) : null;
}

export async function findBuiltinRecipe(
  userId: number,
  key: BuiltinRecipeKey
): Promise<InsightRecipeDto | null> {
  await ensureBuiltinRecipes(userId);
  const row = await prisma.userInsightRecipe.findFirst({
    where: { user_id: userId, builtin_key: key },
  });
  return row ? toDto(row) : null;
}

type CreateRecipeInput = {
  name: string;
  description?: string | null;
  icon?: string | null;
  system_prompt: string;
  user_prompt_template: string;
  context_fields?: InsightContextField[];
  enabled?: boolean;
  sort_order?: number;
};

export async function createInsightRecipe(
  userId: number,
  input: CreateRecipeInput
): Promise<InsightRecipeDto> {
  await ensureBuiltinRecipes(userId);
  const name = String(input.name || '').trim();
  if (!name) {
    throw Object.assign(new Error('配方名称不能为空'), { code: 'AI_BAD_REQUEST' });
  }
  const systemPrompt = String(input.system_prompt || '').trim();
  const userTemplate = String(input.user_prompt_template || '').trim();
  if (!systemPrompt || !userTemplate) {
    throw Object.assign(new Error('system_prompt 与 user_prompt_template 不能为空'), {
      code: 'AI_BAD_REQUEST',
    });
  }

  let sortOrder = input.sort_order;
  if (sortOrder == null || !Number.isFinite(sortOrder)) {
    const agg = await prisma.userInsightRecipe.aggregate({
      where: { user_id: userId },
      _max: { sort_order: true },
    });
    sortOrder = (agg._max.sort_order ?? -1) + 1;
  }

  const row = await prisma.userInsightRecipe.create({
    data: {
      user_id: userId,
      builtin_key: null,
      name: name.slice(0, 80),
      description: input.description?.trim()?.slice(0, 255) || null,
      icon: input.icon?.trim()?.slice(0, 50) || null,
      system_prompt: systemPrompt,
      user_prompt_template: userTemplate,
      context_fields: parseContextFields(input.context_fields) as unknown as Prisma.InputJsonValue,
      enabled: input.enabled !== false,
      is_builtin: false,
      sort_order: sortOrder,
    },
  });
  return toDto(row);
}

type UpdateRecipeInput = {
  name?: string;
  description?: string | null;
  icon?: string | null;
  system_prompt?: string;
  user_prompt_template?: string;
  context_fields?: InsightContextField[];
  enabled?: boolean;
  sort_order?: number;
};

export async function updateInsightRecipe(
  userId: number,
  recipeId: number,
  input: UpdateRecipeInput
): Promise<InsightRecipeDto> {
  const existing = await prisma.userInsightRecipe.findFirst({
    where: { id: recipeId, user_id: userId },
  });
  if (!existing) {
    throw Object.assign(new Error('配方不存在'), { code: 'NOT_FOUND' });
  }

  const data: Prisma.UserInsightRecipeUpdateInput = {
    updated_at: new Date(),
  };

  if (input.name !== undefined) {
    const name = String(input.name || '').trim();
    if (!name) {
      throw Object.assign(new Error('配方名称不能为空'), { code: 'AI_BAD_REQUEST' });
    }
    data.name = name.slice(0, 80);
  }
  if (input.description !== undefined) {
    data.description = input.description?.trim()?.slice(0, 255) || null;
  }
  if (input.icon !== undefined) {
    data.icon = input.icon?.trim()?.slice(0, 50) || null;
  }
  if (input.system_prompt !== undefined) {
    const v = String(input.system_prompt || '').trim();
    if (!v) {
      throw Object.assign(new Error('system_prompt 不能为空'), { code: 'AI_BAD_REQUEST' });
    }
    data.system_prompt = v;
  }
  if (input.user_prompt_template !== undefined) {
    const v = String(input.user_prompt_template || '').trim();
    if (!v) {
      throw Object.assign(new Error('user_prompt_template 不能为空'), { code: 'AI_BAD_REQUEST' });
    }
    data.user_prompt_template = v;
  }
  if (input.context_fields !== undefined) {
    data.context_fields = parseContextFields(input.context_fields) as unknown as Prisma.InputJsonValue;
  }
  if (input.enabled !== undefined) data.enabled = Boolean(input.enabled);
  if (input.sort_order !== undefined && Number.isFinite(input.sort_order)) {
    data.sort_order = Number(input.sort_order);
  }

  const row = await prisma.userInsightRecipe.update({
    where: { id: recipeId },
    data,
  });
  return toDto(row);
}

export async function deleteInsightRecipe(userId: number, recipeId: number): Promise<void> {
  const existing = await prisma.userInsightRecipe.findFirst({
    where: { id: recipeId, user_id: userId },
  });
  if (!existing) {
    throw Object.assign(new Error('配方不存在'), { code: 'NOT_FOUND' });
  }
  if (existing.is_builtin) {
    throw Object.assign(new Error('内置配方不可删除，可禁用或恢复默认'), {
      code: 'AI_BAD_REQUEST',
    });
  }
  await prisma.userInsightRecipe.delete({ where: { id: recipeId } });
}

export async function resetInsightRecipe(
  userId: number,
  recipeId: number
): Promise<InsightRecipeDto> {
  const existing = await prisma.userInsightRecipe.findFirst({
    where: { id: recipeId, user_id: userId },
  });
  if (!existing) {
    throw Object.assign(new Error('配方不存在'), { code: 'NOT_FOUND' });
  }
  if (!existing.is_builtin || !existing.builtin_key) {
    throw Object.assign(new Error('仅内置配方可恢复默认'), { code: 'AI_BAD_REQUEST' });
  }
  if (!isBuiltinRecipeKey(existing.builtin_key)) {
    throw Object.assign(new Error('未知内置配方'), { code: 'AI_BAD_REQUEST' });
  }
  const defaults = getBuiltinRecipeDefaults(existing.builtin_key);
  const row = await prisma.userInsightRecipe.update({
    where: { id: recipeId },
    data: {
      name: defaults.name,
      description: defaults.description,
      icon: defaults.icon,
      system_prompt: defaults.system_prompt,
      user_prompt_template: defaults.user_prompt_template,
      context_fields: defaults.context_fields as unknown as Prisma.InputJsonValue,
      enabled: true,
      sort_order: defaults.sort_order,
      updated_at: new Date(),
    },
  });
  return toDto(row);
}

function normalizeItems(raw: unknown): InsightListItem[] {
  if (!Array.isArray(raw)) return [];
  const out: InsightListItem[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    let title = '';
    let summary = '';
    let source = '';

    if (typeof item === 'string') {
      title = item;
    } else if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      title = String(obj.title || '').trim();
      summary = String(obj.summary || '').trim();
      source = String(obj.source || '').trim();
    }

    title = title.replace(/\s+/g, ' ').trim();
    if (!title) continue;
    if (title.length > MAX_TITLE_CHARS) title = `${title.slice(0, MAX_TITLE_CHARS)}…`;
    if (summary.length > MAX_SUMMARY_CHARS) summary = `${summary.slice(0, MAX_SUMMARY_CHARS)}…`;
    if (source.length > MAX_SOURCE_CHARS) source = `${source.slice(0, MAX_SOURCE_CHARS)}…`;

    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const entry: InsightListItem = { title };
    if (summary) entry.summary = summary;
    if (source) entry.source = source;
    out.push(entry);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

function buildTitlesBlock(items: InsightListItem[], fields: InsightContextField[]): string {
  if (!items.length) return '(无标题)';
  return items
    .map((item, i) => {
      const parts: string[] = [`${i + 1}. ${item.title || ''}`];
      if (fields.includes('source') && item.source) {
        parts.push(`   来源：${item.source}`);
      }
      if (fields.includes('summary') && item.summary) {
        parts.push(`   摘要：${item.summary}`);
      }
      return parts.join('\n');
    })
    .join('\n');
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? '');
}

function todayLabel(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normalizeScopeKey(raw: unknown): string {
  const key = String(raw || '')
    .trim()
    .slice(0, 191);
  return key || 'all';
}

function normalizeRunDay(raw: unknown): { date: Date; label: string } {
  const label = String(raw || '')
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (label) {
    const y = Number(label[1]);
    const m = Number(label[2]);
    const d = Number(label[3]);
    if (y >= 2000 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return { date: new Date(Date.UTC(y, m - 1, d)), label: `${label[1]}-${label[2]}-${label[3]}` };
    }
  }
  const fallback = todayLabel();
  const [fy, fm, fd] = fallback.split('-').map((x) => Number(x));
  return {
    date: new Date(Date.UTC(fy as number, (fm as number) - 1, fd as number)),
    label: fallback,
  };
}

function formatRunDay(value: Date): string {
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, '0');
  const d = String(value.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fingerprintItems(items: InsightListItem[]): string {
  const payload = items
    .map((it) => String(it.title || '').trim().toLowerCase())
    .filter(Boolean)
    .join('\n');
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

function toRunDto(
  row: {
    id: number;
    recipe_id: number;
    scope_key: string;
    scope_label: string;
    run_day: Date;
    title_count: number;
    content: string;
    model: string | null;
    prompt_version: string | null;
    recipe_name_snapshot: string;
    input_fingerprint: string | null;
    created_at: Date;
  },
  opts?: { cached?: boolean; includeContent?: boolean }
): InsightRecipeRunDto {
  const includeContent = opts?.includeContent !== false;
  return {
    id: row.id,
    recipe_id: row.recipe_id,
    scope_key: row.scope_key,
    scope_label: row.scope_label,
    run_day: formatRunDay(row.run_day),
    title_count: row.title_count,
    content: includeContent ? row.content : '',
    model: row.model,
    prompt_version: row.prompt_version,
    recipe_name_snapshot: row.recipe_name_snapshot,
    input_fingerprint: row.input_fingerprint,
    created_at: row.created_at.toISOString(),
    mode_label: row.recipe_name_snapshot,
    cached: opts?.cached,
  };
}

async function pruneInsightRecipeRuns(
  userId: number,
  recipeId: number,
  scopeKey: string,
  runDay: Date
): Promise<void> {
  const keep = await prisma.userInsightRecipeRun.findMany({
    where: {
      user_id: userId,
      recipe_id: recipeId,
      scope_key: scopeKey,
      run_day: runDay,
    },
    orderBy: { created_at: 'desc' },
    select: { id: true },
    skip: MAX_RUNS_PER_SCOPE_DAY,
  });
  if (keep.length) {
    await prisma.userInsightRecipeRun.deleteMany({
      where: { id: { in: keep.map((r: { id: number }) => r.id) } },
    });
  }

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - RUN_RETENTION_DAYS);
  await prisma.userInsightRecipeRun.deleteMany({
    where: {
      user_id: userId,
      created_at: { lt: cutoff },
    },
  });
}

export async function getLatestInsightRecipeRun(
  userId: number,
  recipeId: number,
  scopeKeyRaw: unknown,
  runDayRaw: unknown
): Promise<InsightRecipeRunDto | null> {
  const scopeKey = normalizeScopeKey(scopeKeyRaw);
  const runDay = normalizeRunDay(runDayRaw);
  const row = await prisma.userInsightRecipeRun.findFirst({
    where: {
      user_id: userId,
      recipe_id: recipeId,
      scope_key: scopeKey,
      run_day: runDay.date,
    },
    orderBy: { created_at: 'desc' },
  });
  return row ? toRunDto(row, { cached: true }) : null;
}

export async function listInsightRecipeRuns(
  userId: number,
  recipeId: number,
  scopeKeyRaw: unknown,
  runDayRaw: unknown,
  limitRaw?: unknown
): Promise<InsightRecipeRunDto[]> {
  const scopeKey = normalizeScopeKey(scopeKeyRaw);
  const runDay = normalizeRunDay(runDayRaw);
  let limit = Number(limitRaw);
  if (!Number.isFinite(limit) || limit <= 0) limit = 20;
  limit = Math.min(50, Math.floor(limit));

  const rows = await prisma.userInsightRecipeRun.findMany({
    where: {
      user_id: userId,
      recipe_id: recipeId,
      scope_key: scopeKey,
      run_day: runDay.date,
    },
    orderBy: { created_at: 'desc' },
    take: limit,
  });
  return rows.map((row: Parameters<typeof toRunDto>[0]) => toRunDto(row, { cached: true }));
}

export async function getInsightRecipeRun(
  userId: number,
  runId: number
): Promise<InsightRecipeRunDto | null> {
  const row = await prisma.userInsightRecipeRun.findFirst({
    where: { id: runId, user_id: userId },
  });
  return row ? toRunDto(row, { cached: true }) : null;
}

export type InsightRunsDigestItem = {
  recipe_id: number;
  recipe_name: string;
  description: string | null;
  enabled: boolean;
  sort_order: number;
  builtin_key: string | null;
  has_run: boolean;
  run: InsightRecipeRunDto | null;
};

export type InsightRunsDigest = {
  scope_key: string;
  run_day: string;
  generated_count: number;
  total_count: number;
  items: InsightRunsDigestItem[];
};

/** 当前范围+自然日：各启用配方的最新结果一览（报告台用） */
export async function getInsightRunsDigest(
  userId: number,
  scopeKeyRaw: unknown,
  runDayRaw: unknown,
  opts?: { include_disabled?: boolean }
): Promise<InsightRunsDigest> {
  await ensureBuiltinRecipes(userId);
  const scopeKey = normalizeScopeKey(scopeKeyRaw);
  const runDay = normalizeRunDay(runDayRaw);
  const includeDisabled = opts?.include_disabled === true;

  const recipes = await prisma.userInsightRecipe.findMany({
    where: {
      user_id: userId,
      ...(includeDisabled ? {} : { enabled: true }),
    },
    orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
  });

  const recipeIds = recipes.map((r: { id: number }) => r.id);
  const latestByRecipe = new Map<number, InsightRecipeRunDto>();

  if (recipeIds.length) {
    const runs = await prisma.userInsightRecipeRun.findMany({
      where: {
        user_id: userId,
        recipe_id: { in: recipeIds },
        scope_key: scopeKey,
        run_day: runDay.date,
      },
      orderBy: [{ recipe_id: 'asc' }, { created_at: 'desc' }],
    });
    for (const row of runs as Parameters<typeof toRunDto>[0][]) {
      if (latestByRecipe.has(row.recipe_id)) continue;
      latestByRecipe.set(row.recipe_id, toRunDto(row, { cached: true }));
    }
  }

  const items: InsightRunsDigestItem[] = recipes.map(
    (r: {
      id: number;
      name: string;
      description: string | null;
      enabled: boolean;
      sort_order: number;
      builtin_key: string | null;
    }) => {
      const run = latestByRecipe.get(r.id) || null;
      return {
        recipe_id: r.id,
        recipe_name: r.name,
        description: r.description,
        enabled: r.enabled,
        sort_order: r.sort_order,
        builtin_key: r.builtin_key,
        has_run: !!run,
        run,
      };
    }
  );

  // 有结果的置顶，其余保持 sort_order
  items.sort((a, b) => {
    if (a.has_run !== b.has_run) return a.has_run ? -1 : 1;
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.recipe_id - b.recipe_id;
  });

  const generated_count = items.filter((i) => i.has_run).length;
  return {
    scope_key: scopeKey,
    run_day: runDay.label,
    generated_count,
    total_count: items.length,
    items,
  };
}

export async function runInsightRecipe(
  userId: number,
  recipeId: number,
  input: {
    titles?: unknown;
    items?: unknown;
    scope_label?: string;
    scope_key?: string;
    run_day?: string;
    force_refresh?: boolean;
  }
): Promise<InsightRecipeRunResult> {
  const recipe = await getInsightRecipe(userId, recipeId);
  if (!recipe) {
    throw Object.assign(new Error('配方不存在'), { code: 'NOT_FOUND' });
  }
  if (!recipe.enabled) {
    throw Object.assign(new Error('该配方已禁用'), { code: 'AI_BAD_REQUEST' });
  }

  const items = normalizeItems(input.items ?? input.titles);
  if (!items.length) {
    throw Object.assign(new Error('标题列表为空'), { code: 'EMPTY_TITLES' });
  }

  const scopeKey = normalizeScopeKey(input.scope_key);
  const runDay = normalizeRunDay(input.run_day);
  const scopeLabel =
    String(input.scope_label || '').trim().slice(0, 255) || '当前阅读列表';
  const fp = fingerprintItems(items);

  const titlesBlock = buildTitlesBlock(items, recipe.context_fields);
  const vars: Record<string, string> = {
    scope_label: scopeLabel,
    title_count: String(items.length),
    titles_block: titlesBlock,
    today: runDay.label,
  };

  const system = fillTemplate(recipe.system_prompt, vars);
  const user = fillTemplate(recipe.user_prompt_template, vars);
  const coolerKeys = new Set([
    'mining',
    'finance_risk',
    'geo_supply',
    'verify',
    'multi_source',
    'rates_liquidity',
    'earnings_guide',
    'consensus_gap',
    'commodity_inflation',
    'bull_bear',
    'allocation_frame',
    'invest_memo',
  ]);
  const temperature = coolerKeys.has(String(recipe.builtin_key || '')) ? 0.35 : 0.4;

  const result = await chatWithDeepSeek({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature,
    maxTokens: 4096,
    timeoutMs: 120_000,
  });

  const saved = await prisma.userInsightRecipeRun.create({
    data: {
      user_id: userId,
      recipe_id: recipe.id,
      scope_key: scopeKey,
      scope_label: scopeLabel,
      run_day: runDay.date,
      title_count: items.length,
      content: result.content,
      model: result.model,
      prompt_version: INSIGHT_RECIPE_PROMPT_VERSION,
      recipe_name_snapshot: recipe.name.slice(0, 80),
      input_fingerprint: fp,
    },
  });

  // 异步清理不影响主路径；失败忽略
  pruneInsightRecipeRuns(userId, recipe.id, scopeKey, runDay.date).catch(() => {});

  return {
    recipe_id: recipe.id,
    mode: recipe.builtin_key || `recipe:${recipe.id}`,
    mode_label: recipe.name,
    content: result.content,
    model: result.model,
    prompt_version: INSIGHT_RECIPE_PROMPT_VERSION,
    title_count: items.length,
    run_id: saved.id,
    created_at: saved.created_at.toISOString(),
    cached: false,
    scope_key: scopeKey,
    scope_label: scopeLabel,
    run_day: runDay.label,
    input_fingerprint: fp,
  };
}

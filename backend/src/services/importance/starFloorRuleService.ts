import { prisma } from '../../server';
import {
  evaluateStarFloorRules,
  getDefaultStarFloorRules,
  normalizeRuleKeywords,
  type StarFloorEvaluation,
  type StarFloorRuleInput,
} from './starFloorRules';

type CacheState = {
  loadedAt: number;
  rules: StarFloorRuleInput[];
};

let cache: CacheState | null = null;
const CACHE_TTL_MS = 30_000;

function rowToInput(row: {
  rule_key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  floor_stars: number;
  subject_keywords: unknown;
  signal_keywords: unknown;
  exclude_keywords: unknown;
  skip_local_agency: boolean;
  sort_order: number;
}): StarFloorRuleInput {
  const kws = normalizeRuleKeywords(row);
  return {
    rule_key: row.rule_key,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    floor_stars: row.floor_stars,
    subject_keywords: kws.subject_keywords,
    signal_keywords: kws.signal_keywords,
    exclude_keywords: kws.exclude_keywords,
    skip_local_agency: !!row.skip_local_agency,
    sort_order: row.sort_order,
  };
}

export function invalidateStarFloorRuleCache(): void {
  cache = null;
}

async function listRows() {
  return prisma.importanceStarFloorRule.findMany({
    orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
  });
}

/** 表为空时写入默认规则 */
export async function ensureStarFloorRulesSeeded(): Promise<number> {
  const count = await prisma.importanceStarFloorRule.count();
  if (count > 0) return 0;

  const defaults = getDefaultStarFloorRules();
  await prisma.importanceStarFloorRule.createMany({
    data: defaults.map((r) => ({
      rule_key: r.rule_key,
      name: r.name,
      description: r.description || null,
      enabled: r.enabled,
      floor_stars: r.floor_stars,
      subject_keywords: r.subject_keywords,
      signal_keywords: r.signal_keywords,
      exclude_keywords: r.exclude_keywords,
      skip_local_agency: r.skip_local_agency,
      sort_order: r.sort_order ?? 100,
    })),
  });
  invalidateStarFloorRuleCache();
  return defaults.length;
}

export async function listStarFloorRules(options?: { ensureSeed?: boolean }) {
  if (options?.ensureSeed !== false) {
    await ensureStarFloorRulesSeeded();
  }
  const rows = await listRows();
  return rows.map(rowToInput);
}

export async function getActiveStarFloorRules(): Promise<StarFloorRuleInput[]> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) {
    return cache.rules;
  }
  await ensureStarFloorRulesSeeded();
  const rows = await listRows();
  const rules = rows.map(rowToInput);
  cache = { loadedAt: now, rules };
  return rules;
}

export async function evaluateTitleStarFloor(title: string): Promise<StarFloorEvaluation> {
  const rules = await getActiveStarFloorRules();
  return evaluateStarFloorRules(title, rules);
}

function clampStars(n: unknown): number {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > 5) {
    throw new Error('floor_stars 必须是 1–5 的整数');
  }
  return v;
}

function normalizeKey(raw: unknown): string {
  const key = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!key || key.length > 64) throw new Error('rule_key 无效');
  return key;
}

export type UpsertStarFloorRuleBody = {
  rule_key?: string;
  name?: string;
  description?: string | null;
  enabled?: boolean;
  floor_stars?: number;
  subject_keywords?: unknown;
  signal_keywords?: unknown;
  exclude_keywords?: unknown;
  skip_local_agency?: boolean;
  sort_order?: number;
};

export async function createStarFloorRule(body: UpsertStarFloorRuleBody) {
  const rule_key = normalizeKey(body.rule_key);
  const name = String(body.name || '').trim();
  if (!name) throw new Error('name 不能为空');
  const kws = normalizeRuleKeywords(body);
  if (!kws.signal_keywords.length) throw new Error('signal_keywords 至少需要一个词');

  const row = await prisma.importanceStarFloorRule.create({
    data: {
      rule_key,
      name,
      description: body.description != null ? String(body.description).slice(0, 500) : null,
      enabled: body.enabled !== false,
      floor_stars: clampStars(body.floor_stars ?? 5),
      subject_keywords: kws.subject_keywords,
      signal_keywords: kws.signal_keywords,
      exclude_keywords: kws.exclude_keywords,
      skip_local_agency: !!body.skip_local_agency,
      sort_order: Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 100,
    },
  });
  invalidateStarFloorRuleCache();
  return rowToInput(row);
}

export async function updateStarFloorRule(ruleKey: string, body: UpsertStarFloorRuleBody) {
  const existing = await prisma.importanceStarFloorRule.findUnique({
    where: { rule_key: ruleKey },
  });
  if (!existing) throw new Error('规则不存在');

  const kws = normalizeRuleKeywords({
    subject_keywords:
      body.subject_keywords !== undefined ? body.subject_keywords : existing.subject_keywords,
    signal_keywords:
      body.signal_keywords !== undefined ? body.signal_keywords : existing.signal_keywords,
    exclude_keywords:
      body.exclude_keywords !== undefined ? body.exclude_keywords : existing.exclude_keywords,
  });
  if (!kws.signal_keywords.length) throw new Error('signal_keywords 至少需要一个词');

  const row = await prisma.importanceStarFloorRule.update({
    where: { rule_key: ruleKey },
    data: {
      name: body.name != null ? String(body.name).trim() || existing.name : undefined,
      description:
        body.description !== undefined
          ? body.description == null
            ? null
            : String(body.description).slice(0, 500)
          : undefined,
      enabled: body.enabled !== undefined ? !!body.enabled : undefined,
      floor_stars: body.floor_stars !== undefined ? clampStars(body.floor_stars) : undefined,
      subject_keywords: kws.subject_keywords,
      signal_keywords: kws.signal_keywords,
      exclude_keywords: kws.exclude_keywords,
      skip_local_agency:
        body.skip_local_agency !== undefined ? !!body.skip_local_agency : undefined,
      sort_order:
        body.sort_order !== undefined && Number.isFinite(Number(body.sort_order))
          ? Number(body.sort_order)
          : undefined,
      updated_at: new Date(),
    },
  });
  invalidateStarFloorRuleCache();
  return rowToInput(row);
}

export async function deleteStarFloorRule(ruleKey: string) {
  await prisma.importanceStarFloorRule.delete({ where: { rule_key: ruleKey } });
  invalidateStarFloorRuleCache();
}

/** 用内置默认覆盖同 key；缺失的默认规则补齐；不删除用户自定义 key */
export async function resetStarFloorRulesToDefaults(options?: { wipeCustom?: boolean }) {
  const defaults = getDefaultStarFloorRules();
  if (options?.wipeCustom) {
    await prisma.importanceStarFloorRule.deleteMany({});
  }

  for (const r of defaults) {
    await prisma.importanceStarFloorRule.upsert({
      where: { rule_key: r.rule_key },
      create: {
        rule_key: r.rule_key,
        name: r.name,
        description: r.description || null,
        enabled: r.enabled,
        floor_stars: r.floor_stars,
        subject_keywords: r.subject_keywords,
        signal_keywords: r.signal_keywords,
        exclude_keywords: r.exclude_keywords,
        skip_local_agency: r.skip_local_agency,
        sort_order: r.sort_order ?? 100,
      },
      update: {
        name: r.name,
        description: r.description || null,
        enabled: r.enabled,
        floor_stars: r.floor_stars,
        subject_keywords: r.subject_keywords,
        signal_keywords: r.signal_keywords,
        exclude_keywords: r.exclude_keywords,
        skip_local_agency: r.skip_local_agency,
        sort_order: r.sort_order ?? 100,
        updated_at: new Date(),
      },
    });
  }
  invalidateStarFloorRuleCache();
  return listStarFloorRules({ ensureSeed: false });
}

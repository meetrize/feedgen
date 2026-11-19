import { prisma } from '../../server';
import {
  isScheduledScopeKey,
  parseMinStarsFromScopeKey,
} from './reportScheduleService';

export type ReportHubSource = 'all' | 'scheduled' | 'manual';

export type ReportHubCard = {
  id: number;
  title: string;
  excerpt: string;
  content_preview: string;
  created_at: string;
  title_count: number;
  scope_key: string;
  scope_label: string;
  run_day: string;
  source: 'scheduled' | 'manual';
  min_stars: number | null;
  recipe_id: number;
  recipe_name: string;
  model: string | null;
};

export type ReportHubResult = {
  day: string | null;
  range: string | null;
  source: ReportHubSource;
  total: number;
  today_count: number;
  cards: ReportHubCard[];
};

function formatRunDay(value: Date): string {
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, '0');
  const d = String(value.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDayLabel(raw: unknown): string | null {
  const s = String(raw || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function dayToUtcDate(dayLabel: string): Date {
  const m = String(dayLabel || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const y = m ? Number(m[1]) : 1970;
  const mo = m ? Number(m[2]) : 1;
  const d = m ? Number(m[3]) : 1;
  return new Date(Date.UTC(y, mo - 1, d));
}

/** 去 Markdown / 空白，截取简介 */
export function makeReportExcerpt(content: string, maxChars = 140): string {
  let text = String(content || '');
  text = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).replace(/\s+\S*$/, '')}…`;
}

function todayLabelShanghai(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return `${map.year}-${map.month}-${map.day}`;
}

export async function listReportHub(
  userId: number,
  query: {
    day?: string;
    range?: string;
    source?: string;
    min_stars?: string | number;
    recipe_id?: string | number;
    limit?: string | number;
  }
): Promise<ReportHubResult> {
  const sourceRaw = String(query.source || 'all').trim().toLowerCase();
  const source: ReportHubSource =
    sourceRaw === 'scheduled' || sourceRaw === 'manual' ? sourceRaw : 'all';

  const day = parseDayLabel(query.day);
  const range = String(query.range || '').trim().toLowerCase() === '7d' ? '7d' : null;

  let minStars: number | null = null;
  if (query.min_stars != null && String(query.min_stars).trim() !== '') {
    const n = Number(query.min_stars);
    if (Number.isInteger(n) && n >= 1 && n <= 5) minStars = n;
  }

  let recipeId: number | null = null;
  if (query.recipe_id != null && String(query.recipe_id).trim() !== '') {
    const n = Number(query.recipe_id);
    if (Number.isFinite(n) && n > 0) recipeId = n;
  }

  let limit = Number(query.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = 60;
  limit = Math.min(120, Math.floor(limit));

  const andFilters: Record<string, unknown>[] = [
    { user_id: userId },
    { NOT: { scope_key: { startsWith: 'article:' } } },
  ];

  if (recipeId != null) andFilters.push({ recipe_id: recipeId });

  if (source === 'scheduled') {
    andFilters.push({ scope_key: { startsWith: 'sched|' } });
  } else if (source === 'manual') {
    andFilters.push({ NOT: { scope_key: { startsWith: 'sched|' } } });
  }

  if (day) {
    andFilters.push({ run_day: dayToUtcDate(day) });
  } else if (range === '7d') {
    const today = todayLabelShanghai();
    const end = dayToUtcDate(today);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 6);
    andFilters.push({ run_day: { gte: start, lte: end } });
  } else {
    andFilters.push({ run_day: dayToUtcDate(todayLabelShanghai()) });
  }

  const where = { AND: andFilters };

  const rows = await prisma.userInsightRecipeRun.findMany({
    where: where as any,
    orderBy: { created_at: 'desc' },
    take: limit * 3, // 多取一点再按星级过滤 / 去重
    select: {
      id: true,
      recipe_id: true,
      scope_key: true,
      scope_label: true,
      run_day: true,
      title_count: true,
      content: true,
      model: true,
      recipe_name_snapshot: true,
      created_at: true,
    },
  });

  const cards: ReportHubCard[] = [];
  const seenRecipeDay = new Set<string>();

  for (const row of rows) {
    const isSched = isScheduledScopeKey(row.scope_key);
    if (source === 'scheduled' && !isSched) continue;
    if (source === 'manual' && isSched) continue;

    const stars = parseMinStarsFromScopeKey(row.scope_key);
    if (minStars != null) {
      if (isSched) {
        if (stars == null || stars !== minStars) continue;
      } else {
        // 手动报告无星级字段时：跳过星级筛选（仅定时可精确匹配）
        continue;
      }
    }

    // 同一配方同一天只展示最新一条（卡片更干净）
    const runDay = formatRunDay(row.run_day);
    const dedupeKey = `${row.recipe_id}|${runDay}|${isSched ? 's' : 'm'}|${row.scope_key}`;
    if (seenRecipeDay.has(dedupeKey)) continue;
    seenRecipeDay.add(dedupeKey);

    const excerpt = makeReportExcerpt(row.content, 140);
    cards.push({
      id: row.id,
      title: row.recipe_name_snapshot || 'AI 报告',
      excerpt,
      content_preview: excerpt,
      created_at: row.created_at.toISOString(),
      title_count: row.title_count,
      scope_key: row.scope_key,
      scope_label: row.scope_label,
      run_day: runDay,
      source: isSched ? 'scheduled' : 'manual',
      min_stars: stars,
      recipe_id: row.recipe_id,
      recipe_name: row.recipe_name_snapshot || 'AI 报告',
      model: row.model,
    });

    if (cards.length >= limit) break;
  }

  const today = todayLabelShanghai();
  const todayCount = await prisma.userInsightRecipeRun.count({
    where: {
      user_id: userId,
      run_day: dayToUtcDate(today),
      NOT: { scope_key: { startsWith: 'article:' } },
    },
  });

  return {
    day: day || (range ? null : today),
    range,
    source,
    total: cards.length,
    today_count: todayCount,
    cards,
  };
}

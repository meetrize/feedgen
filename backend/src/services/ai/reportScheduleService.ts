import { prisma } from '../../server';
import {
  getInsightRecipe,
  runInsightRecipe,
  type InsightListItem,
  type InsightRecipeRunResult,
} from './insightRecipeService';

export const AI_REPORT_TICK_JOB_KEY = 'ai.report.tick';
export const DEFAULT_REPORT_TIMEZONE = 'Asia/Shanghai';
export const SCHEDULED_SCOPE_PREFIX = 'sched|';

const MAX_ITEMS = 120;
const MAX_CONCURRENT_TICK = 2;

export type ReportFrequency = 'daily' | 'weekdays' | 'weekly';
export type ReportScheduleStatus =
  | 'success'
  | 'failed'
  | 'skipped_empty'
  | 'skipped_dup';

export type ReportScheduleDto = {
  id: number;
  recipe_id: number;
  recipe_name: string;
  name: string | null;
  display_name: string;
  min_stars: number;
  frequency: ReportFrequency;
  weekday: number | null;
  time_local: string;
  timezone: string;
  enabled: boolean;
  last_run_at: string | null;
  last_status: ReportScheduleStatus | null;
  last_error: string | null;
  last_run_id: number | null;
  created_at: string;
  updated_at: string;
};

export type CreateReportScheduleInput = {
  recipe_id: number;
  name?: string | null;
  min_stars: number;
  frequency: ReportFrequency;
  weekday?: number | null;
  time_local: string;
  timezone?: string;
  enabled?: boolean;
};

export type UpdateReportScheduleInput = Partial<CreateReportScheduleInput>;

type LocalClock = {
  dayLabel: string;
  timeHm: string;
  weekday: number;
  date: Date;
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 在指定 IANA 时区取本地日/时分/星期（weekday 对齐 JS getDay） */
export function getLocalClock(timeZone = DEFAULT_REPORT_TIMEZONE, now = new Date()): LocalClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);

  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }

  const y = Number(map.year || now.getFullYear());
  const mo = Number(map.month || now.getMonth() + 1);
  const d = Number(map.day || now.getDate());
  let hour = Number(map.hour || 0);
  if (hour === 24) hour = 0;
  const minute = Number(map.minute || 0);
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = weekdayMap[map.weekday || ''] ?? now.getDay();

  return {
    dayLabel: `${y}-${pad2(mo)}-${pad2(d)}`,
    timeHm: `${pad2(hour)}:${pad2(minute)}`,
    weekday,
    date: new Date(Date.UTC(y, mo - 1, d)),
  };
}

/** 将 runDay(YYYY-MM-DD) 转为该时区当天的起止（用本地墙钟近似：Asia/Shanghai = UTC+8） */
export function dayRangeForLabel(dayLabel: string, timeZone = DEFAULT_REPORT_TIMEZONE): { start: Date; end: Date } {
  const m = String(dayLabel || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    const clock = getLocalClock(timeZone);
    return dayRangeForLabel(clock.dayLabel, timeZone);
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // v1：报告时区固定 Asia/Shanghai（UTC+8，无夏令时）
  const offsetMs = timeZone === 'Asia/Shanghai' || timeZone === 'Asia/Hong_Kong' ? 8 * 3600_000 : 8 * 3600_000;
  const start = new Date(Date.UTC(y, mo - 1, d) - offsetMs);
  const end = new Date(start.getTime() + 24 * 3600_000);
  return { start, end };
}

export function buildScheduledScopeKey(recipeId: number, minStars: number): string {
  return `${SCHEDULED_SCOPE_PREFIX}day:today|stars:gte:${minStars}|recipe:${recipeId}`.slice(0, 191);
}

export function parseMinStarsFromScopeKey(scopeKey: string): number | null {
  const m = String(scopeKey || '').match(/stars:gte:(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

export function isScheduledScopeKey(scopeKey: string): boolean {
  return String(scopeKey || '').startsWith(SCHEDULED_SCOPE_PREFIX);
}

function normalizeTimeLocal(raw: unknown): string {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    throw Object.assign(new Error('time_local 须为 HH:mm'), { code: 'AI_BAD_REQUEST' });
  }
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(min) || min < 0 || min > 59) {
    throw Object.assign(new Error('time_local 须为合法时刻'), { code: 'AI_BAD_REQUEST' });
  }
  return `${pad2(h)}:${pad2(min)}`;
}

function normalizeFrequency(raw: unknown): ReportFrequency {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'daily' || v === 'weekdays' || v === 'weekly') return v;
  throw Object.assign(new Error('frequency 须为 daily / weekdays / weekly'), { code: 'AI_BAD_REQUEST' });
}

function normalizeMinStars(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw Object.assign(new Error('min_stars 须为 1–5 的整数'), { code: 'AI_BAD_REQUEST' });
  }
  return n;
}

function normalizeWeekday(frequency: ReportFrequency, raw: unknown): number | null {
  if (frequency !== 'weekly') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 6) {
    throw Object.assign(new Error('weekly 须指定 weekday（0=周日 … 6=周六）'), { code: 'AI_BAD_REQUEST' });
  }
  return n;
}

function frequencyMatches(frequency: ReportFrequency, weekday: number | null, clockWeekday: number): boolean {
  if (frequency === 'daily') return true;
  if (frequency === 'weekdays') return clockWeekday >= 1 && clockWeekday <= 5;
  if (frequency === 'weekly') return weekday != null && weekday === clockWeekday;
  return false;
}

function toDto(row: {
  id: number;
  user_id: number;
  recipe_id: number;
  name: string | null;
  min_stars: number;
  frequency: string;
  weekday: number | null;
  time_local: string;
  timezone: string;
  enabled: boolean;
  last_run_at: Date | null;
  last_status: string | null;
  last_error: string | null;
  last_run_id: number | null;
  created_at: Date;
  updated_at: Date;
  recipe?: { name: string } | null;
}): ReportScheduleDto {
  const recipeName = row.recipe?.name || `配方 #${row.recipe_id}`;
  const custom = row.name ? String(row.name).trim() : '';
  return {
    id: row.id,
    recipe_id: row.recipe_id,
    recipe_name: recipeName,
    name: custom || null,
    display_name: custom || recipeName,
    min_stars: row.min_stars,
    frequency: row.frequency as ReportFrequency,
    weekday: row.weekday,
    time_local: row.time_local,
    timezone: row.timezone,
    enabled: row.enabled,
    last_run_at: row.last_run_at ? row.last_run_at.toISOString() : null,
    last_status: (row.last_status as ReportScheduleStatus) || null,
    last_error: row.last_error,
    last_run_id: row.last_run_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** 拉取用户全部订阅源中：指定自然日 + 星级 ≥ N 的文章，组装洞察 items */
export async function collectArticlesForScheduledReport(
  userId: number,
  opts: { runDay: string; minStars: number; timeZone?: string }
): Promise<InsightListItem[]> {
  const minStars = normalizeMinStars(opts.minStars);
  const timeZone = opts.timeZone || DEFAULT_REPORT_TIMEZONE;
  const { start, end } = dayRangeForLabel(opts.runDay, timeZone);

  const [privateFeeds, publicSubs] = await Promise.all([
    prisma.feed.findMany({
      where: { user_id: userId },
      select: { id: true },
    }),
    prisma.userFeedSubscription.findMany({
      where: { user_id: userId },
      select: { public_feed_id: true },
    }),
  ]);

  const privateFeedIds = privateFeeds
    .map((f: { id: number }) => Number(f.id))
    .filter((id: number) => Number.isFinite(id));
  const publicFeedIds = publicSubs
    .map((s: { public_feed_id: number }) => Number(s.public_feed_id))
    .filter((id: number) => Number.isFinite(id));

  if (!privateFeedIds.length && !publicFeedIds.length) return [];

  const feedOr: Array<Record<string, unknown>> = [];
  if (privateFeedIds.length) feedOr.push({ feed_id: { in: privateFeedIds } });
  if (publicFeedIds.length) feedOr.push({ public_feed_id: { in: publicFeedIds } });

  const rows = await prisma.article.findMany({
    where: {
      AND: [
        { OR: feedOr },
        {
          OR: [
            { pub_date: { gte: start, lt: end } },
            { created_at: { gte: start, lt: end } },
          ],
        },
        { importance: { stars: { gte: minStars } } },
        { OR: [{ dup_is_primary: true }, { dup_cluster_id: null }] },
      ],
    },
    orderBy: [{ pub_date: 'desc' }, { created_at: 'desc' }],
    take: MAX_ITEMS,
    select: {
      id: true,
      title: true,
      title_zh: true,
      description: true,
      description_zh: true,
      feeds: { select: { title: true } },
      public_feed: { select: { title: true } },
      fulltext: {
        select: {
          status: true,
          body_text: true,
          body_html: true,
        },
      },
    },
  });

  const items: InsightListItem[] = [];
  const seen = new Set<string>();
  for (const row of rows as Array<{
    title: string;
    title_zh: string | null;
    description: string | null;
    description_zh: string | null;
    feeds: { title: string } | null;
    public_feed: { title: string } | null;
    fulltext: { status: string; body_text: string | null; body_html: string | null } | null;
  }>) {
    const title = String(row.title_zh || row.title || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const summary = String(row.description_zh || row.description || '')
      .replace(/\s+/g, ' ')
      .trim();
    const source = String(row.feeds?.title || row.public_feed?.title || '').trim();
    const entry: InsightListItem = { title };
    if (summary) entry.summary = summary.slice(0, 280);
    if (source) entry.source = source.slice(0, 80);

    if (row.fulltext && row.fulltext.status === 'success') {
      const ft = String(row.fulltext.body_text || row.fulltext.body_html || '').trim();
      if (ft) entry.fulltext = ft;
    }

    items.push(entry);
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

export async function listReportSchedules(userId: number): Promise<ReportScheduleDto[]> {
  const rows = await prisma.userInsightReportSchedule.findMany({
    where: { user_id: userId },
    include: { recipe: { select: { name: true } } },
    orderBy: [{ enabled: 'desc' }, { time_local: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toDto);
}

export async function getReportSchedule(
  userId: number,
  id: number
): Promise<ReportScheduleDto | null> {
  const row = await prisma.userInsightReportSchedule.findFirst({
    where: { id, user_id: userId },
    include: { recipe: { select: { name: true } } },
  });
  return row ? toDto(row) : null;
}

export async function createReportSchedule(
  userId: number,
  input: CreateReportScheduleInput
): Promise<ReportScheduleDto> {
  const recipeId = Number(input.recipe_id);
  if (!Number.isFinite(recipeId) || recipeId <= 0) {
    throw Object.assign(new Error('无效配方 ID'), { code: 'AI_BAD_REQUEST' });
  }
  const recipe = await getInsightRecipe(userId, recipeId);
  if (!recipe) {
    throw Object.assign(new Error('配方不存在'), { code: 'NOT_FOUND' });
  }
  if (!recipe.enabled) {
    throw Object.assign(new Error('该配方已禁用'), { code: 'AI_BAD_REQUEST' });
  }

  const frequency = normalizeFrequency(input.frequency);
  const minStars = normalizeMinStars(input.min_stars);
  const timeLocal = normalizeTimeLocal(input.time_local);
  const weekday = normalizeWeekday(frequency, input.weekday);
  const name = input.name != null ? String(input.name).trim().slice(0, 80) || null : null;
  const timezone = String(input.timezone || DEFAULT_REPORT_TIMEZONE).trim().slice(0, 64) || DEFAULT_REPORT_TIMEZONE;
  const enabled = input.enabled !== false;

  const row = await prisma.userInsightReportSchedule.create({
    data: {
      user_id: userId,
      recipe_id: recipeId,
      name,
      min_stars: minStars,
      frequency,
      weekday,
      time_local: timeLocal,
      timezone,
      enabled,
    },
    include: { recipe: { select: { name: true } } },
  });
  return toDto(row);
}

export async function updateReportSchedule(
  userId: number,
  id: number,
  input: UpdateReportScheduleInput
): Promise<ReportScheduleDto> {
  const existing = await prisma.userInsightReportSchedule.findFirst({
    where: { id, user_id: userId },
  });
  if (!existing) {
    throw Object.assign(new Error('定时规则不存在'), { code: 'NOT_FOUND' });
  }

  const data: Record<string, unknown> = { updated_at: new Date() };

  if (input.recipe_id != null) {
    const recipeId = Number(input.recipe_id);
    if (!Number.isFinite(recipeId) || recipeId <= 0) {
      throw Object.assign(new Error('无效配方 ID'), { code: 'AI_BAD_REQUEST' });
    }
    const recipe = await getInsightRecipe(userId, recipeId);
    if (!recipe) {
      throw Object.assign(new Error('配方不存在'), { code: 'NOT_FOUND' });
    }
    data.recipe_id = recipeId;
  }

  if (input.frequency != null || input.weekday !== undefined) {
    const frequency = input.frequency != null ? normalizeFrequency(input.frequency) : (existing.frequency as ReportFrequency);
    data.frequency = frequency;
    data.weekday = normalizeWeekday(
      frequency,
      input.weekday !== undefined ? input.weekday : existing.weekday
    );
  }

  if (input.min_stars != null) data.min_stars = normalizeMinStars(input.min_stars);
  if (input.time_local != null) data.time_local = normalizeTimeLocal(input.time_local);
  if (input.timezone != null) {
    data.timezone = String(input.timezone).trim().slice(0, 64) || DEFAULT_REPORT_TIMEZONE;
  }
  if (input.name !== undefined) {
    data.name = input.name != null ? String(input.name).trim().slice(0, 80) || null : null;
  }
  if (input.enabled != null) data.enabled = Boolean(input.enabled);

  const row = await prisma.userInsightReportSchedule.update({
    where: { id },
    data,
    include: { recipe: { select: { name: true } } },
  });
  return toDto(row);
}

export async function deleteReportSchedule(userId: number, id: number): Promise<void> {
  const existing = await prisma.userInsightReportSchedule.findFirst({
    where: { id, user_id: userId },
    select: { id: true },
  });
  if (!existing) {
    throw Object.assign(new Error('定时规则不存在'), { code: 'NOT_FOUND' });
  }
  await prisma.userInsightReportSchedule.delete({ where: { id } });
}

async function markScheduleResult(
  scheduleId: number,
  status: ReportScheduleStatus,
  opts?: { error?: string | null; runId?: number | null }
): Promise<void> {
  await prisma.userInsightReportSchedule.update({
    where: { id: scheduleId },
    data: {
      last_run_at: new Date(),
      last_status: status,
      last_error: opts?.error != null ? String(opts.error).slice(0, 2000) : null,
      last_run_id: opts?.runId != null ? opts.runId : null,
      updated_at: new Date(),
    },
  });
}

export type ExecuteScheduleResult = {
  status: ReportScheduleStatus;
  insight?: InsightRecipeRunResult;
  error?: string;
  title_count?: number;
};

/** 执行一条定时规则（force=true 时忽略当日已成功跳过） */
export async function executeReportSchedule(
  scheduleId: number,
  opts?: { force?: boolean; userId?: number }
): Promise<ExecuteScheduleResult> {
  const force = opts?.force === true;
  const row = await prisma.userInsightReportSchedule.findFirst({
    where: {
      id: scheduleId,
      ...(opts?.userId != null ? { user_id: opts.userId } : {}),
    },
    include: { recipe: { select: { name: true, enabled: true } } },
  });
  if (!row) {
    throw Object.assign(new Error('定时规则不存在'), { code: 'NOT_FOUND' });
  }

  const timezone = row.timezone || DEFAULT_REPORT_TIMEZONE;
  const clock = getLocalClock(timezone);

  if (!force) {
    if (!row.enabled) {
      return { status: 'skipped_dup', error: '规则未启用' };
    }
    if (row.time_local !== clock.timeHm) {
      return { status: 'skipped_dup', error: '未到执行时刻' };
    }
    if (!frequencyMatches(row.frequency as ReportFrequency, row.weekday, clock.weekday)) {
      return { status: 'skipped_dup', error: '今日不在周期内' };
    }
    if (
      row.last_status === 'success' &&
      row.last_run_at &&
      getLocalClock(timezone, row.last_run_at).dayLabel === clock.dayLabel
    ) {
      await markScheduleResult(row.id, 'skipped_dup', {
        error: '今日已成功生成',
        runId: row.last_run_id,
      });
      return { status: 'skipped_dup', error: '今日已成功生成' };
    }
  }

  try {
    const items = await collectArticlesForScheduledReport(row.user_id, {
      runDay: clock.dayLabel,
      minStars: row.min_stars,
      timeZone: timezone,
    });

    if (!items.length) {
      await markScheduleResult(row.id, 'skipped_empty', { error: '当天无达标文章' });
      return { status: 'skipped_empty', title_count: 0, error: '当天无达标文章' };
    }

    const recipeName = row.recipe?.name || `配方 #${row.recipe_id}`;
    const displayName = (row.name && String(row.name).trim()) || recipeName;
    const scopeKey = buildScheduledScopeKey(row.recipe_id, row.min_stars);
    const scopeLabel = `定时报告 · ${displayName} · 当天 ★≥${row.min_stars}`;

    const insight = await runInsightRecipe(row.user_id, row.recipe_id, {
      items,
      scope_key: scopeKey,
      scope_label: scopeLabel,
      run_day: clock.dayLabel,
      force_refresh: true,
    });

    await markScheduleResult(row.id, 'success', {
      runId: insight.run_id ?? null,
      error: null,
    });
    return { status: 'success', insight, title_count: insight.title_count };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markScheduleResult(row.id, 'failed', { error: message });
    return { status: 'failed', error: message };
  }
}

/** 每分钟 tick：扫描到期规则并执行 */
export async function tickDueReportSchedules(): Promise<{
  scanned: number;
  ran: number;
  success: number;
  skipped: number;
  failed: number;
}> {
  const rows = await prisma.userInsightReportSchedule.findMany({
    where: { enabled: true },
    select: {
      id: true,
      time_local: true,
      timezone: true,
      frequency: true,
      weekday: true,
      last_status: true,
      last_run_at: true,
    },
  });

  const dueIds: number[] = [];
  for (const row of rows) {
    const tz = row.timezone || DEFAULT_REPORT_TIMEZONE;
    const clock = getLocalClock(tz);
    if (row.time_local !== clock.timeHm) continue;
    if (!frequencyMatches(row.frequency as ReportFrequency, row.weekday, clock.weekday)) continue;
    if (
      row.last_status === 'success' &&
      row.last_run_at &&
      getLocalClock(tz, row.last_run_at).dayLabel === clock.dayLabel
    ) {
      continue;
    }
    dueIds.push(row.id);
  }

  let ran = 0;
  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < dueIds.length; i += MAX_CONCURRENT_TICK) {
    const batch = dueIds.slice(i, i + MAX_CONCURRENT_TICK);
    const results = await Promise.all(
      batch.map((id) =>
        executeReportSchedule(id, { force: false }).catch((err) => ({
          status: 'failed' as const,
          error: err instanceof Error ? err.message : String(err),
        }))
      )
    );
    for (const r of results) {
      ran += 1;
      if (r.status === 'success') success += 1;
      else if (r.status === 'failed') failed += 1;
      else skipped += 1;
    }
  }

  return { scanned: rows.length, ran, success, skipped, failed };
}

export function formatFrequencyLabel(
  frequency: ReportFrequency,
  weekday: number | null,
  timeLocal: string
): string {
  const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  if (frequency === 'daily') return `每天 ${timeLocal}`;
  if (frequency === 'weekdays') return `工作日 ${timeLocal}`;
  const w = weekday != null && weekday >= 0 && weekday <= 6 ? weekNames[weekday] : '每周';
  return `每${w} ${timeLocal}`;
}

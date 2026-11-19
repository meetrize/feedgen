import crypto from 'crypto';

import { prisma } from '../../server';
import {
  dayRangeForLabel,
  DEFAULT_REPORT_TIMEZONE,
  getLocalClock,
} from '../ai/reportScheduleService';
import { extractFutureEvents, screenTitleForFuture } from './futureScanAi';
import {
  CALENDAR_FUTURE_SCAN_JOB_KEY,
  isCalendarFutureScanEnabled,
  mergeFutureScanConfig,
  type FutureScanConfig,
} from './futureScanConfig';
import { dedupeAndPrepareUpsert } from './futureScanDedupe';
import {
  buildFeCode,
  hashContent,
  type CalendarEventRow,
  upsertCalendarEvents,
} from './quoteCacheDb';

export { CALENDAR_FUTURE_SCAN_JOB_KEY };

let scanRunning = false;

export function isFutureCalendarScanBusy(): boolean {
  return scanRunning;
}

export type FutureScanStats = {
  scanned: number;
  titleHits: number;
  skippedNoFuture: number;
  skippedDone: number;
  eventsUpserted: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** 语义去重合并进已有事件（含东财） */
  merged: number;
  dedupeRuleHits: number;
  dedupeAiCalls: number;
  dedupeAiMerges: number;
  failed: number;
  disabled?: boolean;
};

function stripHtml(html: string): string {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveTitle(article: {
  title: string;
  title_zh: string | null;
}): string {
  return String(article.title_zh || article.title || '').trim();
}

function resolveBody(
  article: {
    content: string | null;
    description: string | null;
    description_zh: string | null;
    fulltext: {
      status: string;
      body_text: string | null;
      body_text_zh: string | null;
    } | null;
  },
  maxBodyChars: number,
): { body: string; hadBody: boolean } {
  const ft = article.fulltext;
  if (ft?.status === 'success') {
    const text = String(ft.body_text_zh || ft.body_text || '').trim();
    if (text) {
      return { body: text.slice(0, maxBodyChars), hadBody: true };
    }
  }
  const content = stripHtml(String(article.content || ''));
  if (content.length >= 80) {
    return { body: content.slice(0, maxBodyChars), hadBody: true };
  }
  const desc = String(article.description_zh || article.description || '').trim();
  if (desc.length >= 40) {
    return { body: desc.slice(0, maxBodyChars), hadBody: true };
  }
  return { body: '', hadBody: false };
}

function fingerprint(title: string, body: string): string {
  return crypto.createHash('sha1').update(`${title}\n${body}`).digest('hex');
}

function todayStartTs(todayLabel: string): number {
  const { start } = dayRangeForLabel(todayLabel, DEFAULT_REPORT_TIMEZONE);
  return start.getTime() / 1000;
}

function parseStartTs(iso: string): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return t / 1000;
}

function needsRescan(
  existing: {
    status: string;
    content_fingerprint: string | null;
    had_body: boolean;
  } | null,
  fp: string,
  hadBody: boolean,
): boolean {
  if (!existing) return true;
  if (existing.status === 'failed' || existing.status === 'pending') return true;
  if (existing.content_fingerprint === fp) return false;
  // 指纹变化：仅此前无正文、现在有正文时重抽
  return !existing.had_body && hadBody;
}

async function upsertExtraction(data: {
  article_id: number;
  status: string;
  title_hit: boolean;
  had_body: boolean;
  events_count: number;
  error?: string | null;
  content_fingerprint: string;
}) {
  const now = new Date();
  await prisma.articleCalendarExtraction.upsert({
    where: { article_id: data.article_id },
    create: {
      article_id: data.article_id,
      status: data.status,
      title_hit: data.title_hit,
      had_body: data.had_body,
      events_count: data.events_count,
      error: data.error ?? null,
      content_fingerprint: data.content_fingerprint,
      processed_at: now,
      updated_at: now,
    },
    update: {
      status: data.status,
      title_hit: data.title_hit,
      had_body: data.had_body,
      events_count: data.events_count,
      error: data.error ?? null,
      content_fingerprint: data.content_fingerprint,
      processed_at: now,
      updated_at: now,
    },
  });
}

function toCalendarRows(
  articleId: number,
  articleUrl: string | null,
  events: Awaited<ReturnType<typeof extractFutureEvents>>,
  todayLabel: string,
  maxEvents: number,
): CalendarEventRow[] {
  const minTs = todayStartTs(todayLabel);
  const rows: CalendarEventRow[] = [];
  for (const ev of events) {
    if (rows.length >= maxEvents) break;
    const startTs = parseStartTs(ev.start_at);
    if (startTs == null || startTs < minTs) continue;
    let endAt: string | null = ev.end_at;
    if (endAt) {
      const endTs = parseStartTs(endAt);
      if (endTs == null) endAt = null;
    }
    const feCode = buildFeCode(articleId, ev.name, ev.start_at, ev.std_type_code);
    const contentParts = [
      ev.summary || '',
      articleUrl ? `原文: ${articleUrl}` : '',
      `feedgen_article_id=${articleId}`,
    ].filter(Boolean);
    const content = contentParts.join('\n');
    rows.push({
      fe_code: feCode,
      start_at: ev.start_at,
      end_at: endAt,
      start_ts: startTs,
      name: ev.name,
      sponsor: ev.sponsor || '新闻推断',
      city: ev.city || '',
      fe_type: ev.fe_type || '新闻日程',
      std_type_code: ev.std_type_code,
      content,
      content_hash: hashContent([
        ev.name,
        ev.start_at,
        endAt || '',
        ev.std_type_code,
        content,
      ]),
      source: 'feedgen',
    });
  }
  return rows;
}

async function updateRunProgress(
  runId: number | undefined,
  progress: number,
  progressText: string,
  stats?: FutureScanStats,
) {
  if (runId == null) return;
  await prisma.systemJobRun.update({
    where: { id: runId },
    data: {
      progress,
      progress_text: progressText,
      ...(stats ? { stats: stats as any } : {}),
    },
  });
}

export async function runFutureCalendarScan(opts?: {
  runId?: number;
  config?: unknown;
}): Promise<FutureScanStats> {
  if (scanRunning) {
    throw Object.assign(new Error('新闻未来日程扫描正在运行中'), { code: 'SCAN_BUSY' });
  }
  scanRunning = true;
  try {
    return await runFutureCalendarScanInner(opts);
  } finally {
    scanRunning = false;
  }
}

async function runFutureCalendarScanInner(opts?: {
  runId?: number;
  config?: unknown;
}): Promise<FutureScanStats> {
  const stats: FutureScanStats = {
    scanned: 0,
    titleHits: 0,
    skippedNoFuture: 0,
    skippedDone: 0,
    eventsUpserted: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    merged: 0,
    dedupeRuleHits: 0,
    dedupeAiCalls: 0,
    dedupeAiMerges: 0,
    failed: 0,
  };

  if (!isCalendarFutureScanEnabled()) {
    stats.disabled = true;
    await updateRunProgress(opts?.runId, 100, '已禁用（CALENDAR_FUTURE_SCAN_ENABLED=0）', stats);
    return stats;
  }

  const cfg: FutureScanConfig = mergeFutureScanConfig(opts?.config);
  const clock = getLocalClock(DEFAULT_REPORT_TIMEZONE);
  const today = clock.dayLabel;
  const { start, end } = dayRangeForLabel(today, DEFAULT_REPORT_TIMEZONE);

  const articles = await prisma.article.findMany({
    where: {
      created_at: { gte: start, lt: end },
      OR: [
        { calendar_extraction: null },
        { calendar_extraction: { status: { in: ['failed', 'pending'] } } },
        // 此前无正文且原文抓取已成功：允许重抽
        {
          AND: [
            { calendar_extraction: { had_body: false } },
            { fulltext: { is: { status: 'success' } } },
          ],
        },
      ],
    },
    // 优先处理最新入库，避免积压时新文永远排在 batch 之后
    orderBy: { id: 'desc' },
    take: cfg.batchSize,
    select: {
      id: true,
      title: true,
      title_zh: true,
      content: true,
      description: true,
      description_zh: true,
      url: true,
      fulltext: {
        select: {
          status: true,
          body_text: true,
          body_text_zh: true,
        },
      },
      calendar_extraction: {
        select: {
          status: true,
          content_fingerprint: true,
          had_body: true,
        },
      },
    },
  });

  const total = articles.length;
  await updateRunProgress(opts?.runId, 5, `待扫描 ${total} 篇`, stats);

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    stats.scanned += 1;
    const title = resolveTitle(article);
    const { body, hadBody } = resolveBody(article, cfg.maxBodyChars);
    const fp = fingerprint(title, body);

    if (!needsRescan(article.calendar_extraction, fp, hadBody)) {
      stats.skippedDone += 1;
      continue;
    }

    try {
      if (!title) {
        await upsertExtraction({
          article_id: article.id,
          status: 'skipped_no_future',
          title_hit: false,
          had_body: hadBody,
          events_count: 0,
          content_fingerprint: fp,
        });
        stats.skippedNoFuture += 1;
        continue;
      }

      const screen = await screenTitleForFuture(cfg, { title, today });
      if (!screen.hit) {
        await upsertExtraction({
          article_id: article.id,
          status: 'skipped_no_future',
          title_hit: false,
          had_body: hadBody,
          events_count: 0,
          content_fingerprint: fp,
        });
        stats.skippedNoFuture += 1;
        continue;
      }

      stats.titleHits += 1;
      const extracted = await extractFutureEvents(cfg, {
        title,
        body,
        today,
        articleUrl: article.url || '',
        articleId: article.id,
      });
      const rows = toCalendarRows(
        article.id,
        article.url,
        extracted,
        today,
        cfg.maxEventsPerArticle,
      );

      if (rows.length) {
        const { toInsert, stats: dStats } = await dedupeAndPrepareUpsert(
          cfg,
          rows,
          today,
        );
        stats.merged += dStats.merged;
        stats.dedupeRuleHits += dStats.ruleHits;
        stats.dedupeAiCalls += dStats.aiCalls;
        stats.dedupeAiMerges += dStats.aiMerges;
        if (toInsert.length) {
          const up = upsertCalendarEvents(toInsert);
          stats.inserted += up.inserted;
          stats.updated += up.updated;
          stats.unchanged += up.unchanged;
        }
        stats.eventsUpserted += toInsert.length + dStats.merged;
      }

      await upsertExtraction({
        article_id: article.id,
        status: 'done',
        title_hit: true,
        had_body: hadBody,
        events_count: rows.length,
        content_fingerprint: fp,
      });
    } catch (err) {
      stats.failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      await upsertExtraction({
        article_id: article.id,
        status: 'failed',
        title_hit: false,
        had_body: hadBody,
        events_count: 0,
        error: msg.slice(0, 2000),
        content_fingerprint: fp,
      }).catch(() => {});
    }

    const pct = 5 + Math.floor(((i + 1) / Math.max(total, 1)) * 90);
    if ((i + 1) % 5 === 0 || i === articles.length - 1) {
      await updateRunProgress(
        opts?.runId,
        pct,
        `已处理 ${i + 1}/${total} · 命中 ${stats.titleHits} · 写入 ${stats.eventsUpserted} · 合并 ${stats.merged}`,
        stats,
      );
    }
  }

  await updateRunProgress(
    opts?.runId,
    100,
    `完成：扫描 ${stats.scanned} · 命中 ${stats.titleHits} · 新建 ${stats.inserted} · 合并 ${stats.merged} · 失败 ${stats.failed}`,
    stats,
  );
  return stats;
}

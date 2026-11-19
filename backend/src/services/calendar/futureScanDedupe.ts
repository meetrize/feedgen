/**
 * 新闻日程语义去重：规则召回 + 相似短路 + AI 判同 → 合并或新建。
 */

import type { FutureScanConfig } from './futureScanConfig';
import { judgeSameCalendarEvent } from './futureScanAi';
import {
  findCandidateEvents,
  hashContent,
  mergeIntoExistingEvent,
  type CalendarCandidate,
  type CalendarEventRow,
} from './quoteCacheDb';

const SHELL_WORDS =
  /据悉|报道称|消息称|预计|计划于|定于|即将|举行|召开|公布|发布|举行的|将于|关于|的通知|的公告/g;

export function normalizeEventName(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(SHELL_WORDS, '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/[\s\u3000\-—_·,，.。:：;；'"「」『』《》【】\[\]]+/g, '')
    .trim();
}

/** bigram Jaccard；短串用包含关系加权 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeEventName(a);
  const nb = normalizeEventName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) {
    const ratio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
    return 0.75 + 0.25 * ratio;
  }
  const grams = (s: string): Set<string> => {
    const set = new Set<string>();
    if (s.length < 2) {
      set.add(s);
      return set;
    }
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(na);
  const gb = grams(nb);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  const union = ga.size + gb.size - inter;
  return union <= 0 ? 0 : inter / union;
}

function dayKeyFromIso(iso: string): string {
  const m = String(iso || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return (m && m[1]) || '';
}

function sameCalendarDay(a: string, b: string): boolean {
  const da = dayKeyFromIso(a);
  const db = dayKeyFromIso(b);
  return Boolean(da && db && da === db);
}

export type DedupeResolveResult = {
  action: 'insert' | 'merge';
  mergeFeCode?: string;
  via: 'none' | 'rule' | 'ai' | 'skip_no_candidates' | 'ai_fail';
  confidence?: number;
  reason?: string;
};

/**
 * 对单条待写入事件做去重判定（不写库）。
 */
export async function resolveDedupeTarget(
  cfg: FutureScanConfig,
  row: CalendarEventRow,
  today: string,
): Promise<DedupeResolveResult> {
  if (!cfg.dedupeEnabled) {
    return { action: 'insert', via: 'none' };
  }

  const candidates = findCandidateEvents({
    startTs: row.start_ts,
    dayWindow: cfg.dedupeDayWindow,
    max: cfg.dedupeMaxCandidates,
    stdTypeCode: row.std_type_code,
  }).filter((c) => c.fe_code && c.fe_code !== row.fe_code);

  if (!candidates.length) {
    return { action: 'insert', via: 'skip_no_candidates' };
  }

  // 规则短路：同日 + 高相似
  let best: { c: CalendarCandidate; sim: number } | null = null;
  for (const c of candidates) {
    if (!sameCalendarDay(row.start_at, c.start_at) && cfg.dedupeDayWindow === 0) continue;
    const sim = nameSimilarity(row.name, c.name);
    if (!best || sim > best.sim) best = { c, sim };
  }
  if (best && best.sim >= cfg.dedupeRuleSimilarity && sameCalendarDay(row.start_at, best.c.start_at)) {
    return {
      action: 'merge',
      mergeFeCode: best.c.fe_code,
      via: 'rule',
      confidence: best.sim,
      reason: `规则相似 ${best.sim.toFixed(2)}`,
    };
  }

  try {
    const judged = await judgeSameCalendarEvent(cfg, {
      today,
      newEvent: {
        name: row.name,
        start_at: row.start_at,
        end_at: row.end_at,
        std_type_code: row.std_type_code,
        fe_type: row.fe_type,
        sponsor: row.sponsor,
        city: row.city,
        source: row.source,
      },
      candidates: candidates.map((c) => ({
        fe_code: c.fe_code,
        name: c.name,
        start_at: c.start_at,
        end_at: c.end_at,
        std_type_code: c.std_type_code,
        fe_type: c.fe_type,
        sponsor: c.sponsor,
        city: c.city,
        source: c.source,
      })),
    });

    const code = judged.same_as_fe_code;
    const allowed = code && candidates.some((c) => c.fe_code === code);
    if (allowed && judged.confidence >= cfg.dedupeMinConfidence) {
      return {
        action: 'merge',
        mergeFeCode: code!,
        via: 'ai',
        confidence: judged.confidence,
        reason: judged.reason,
      };
    }
    return {
      action: 'insert',
      via: 'ai',
      confidence: judged.confidence,
      reason: judged.reason || 'AI 判定非同一事件',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { action: 'insert', via: 'ai_fail', reason: msg.slice(0, 200) };
  }
}

export type DedupeBatchStats = {
  merged: number;
  insertedAfterDedupe: number;
  ruleHits: number;
  aiCalls: number;
  aiMerges: number;
};

/**
 * 对一批待写入行去重：合并则写库，新建返回剩余 rows 供 upsert。
 */
export async function dedupeAndPrepareUpsert(
  cfg: FutureScanConfig,
  rows: CalendarEventRow[],
  today: string,
): Promise<{ toInsert: CalendarEventRow[]; stats: DedupeBatchStats }> {
  const stats: DedupeBatchStats = {
    merged: 0,
    insertedAfterDedupe: 0,
    ruleHits: 0,
    aiCalls: 0,
    aiMerges: 0,
  };
  if (!cfg.dedupeEnabled || !rows.length) {
    return { toInsert: rows, stats };
  }

  const toInsert: CalendarEventRow[] = [];
  // 本批次内也去重：先写入的作为后续候选的「虚拟」合并目标
  const batchSeen: CalendarEventRow[] = [];

  for (const row of rows) {
    // 与本批已接受「待插入」行做规则合并（尚未落库，只改内存）
    let batchMerge: CalendarEventRow | null = null;
    for (const prev of batchSeen) {
      if (!sameCalendarDay(row.start_at, prev.start_at)) continue;
      if (nameSimilarity(row.name, prev.name) >= cfg.dedupeRuleSimilarity) {
        batchMerge = prev;
        break;
      }
    }
    if (batchMerge) {
      const appendix = String(row.content || '').trim();
      if (appendix && !batchMerge.content.includes(appendix)) {
        batchMerge.content = batchMerge.content
          ? `${batchMerge.content}\n---\n${appendix}`
          : appendix;
        batchMerge.content_hash = hashContent([
          batchMerge.name,
          batchMerge.start_at,
          batchMerge.end_at || '',
          batchMerge.std_type_code,
          batchMerge.content,
        ]);
      }
      stats.merged += 1;
      stats.ruleHits += 1;
      continue;
    }

    const resolved = await resolveDedupeTarget(cfg, row, today);
    if (resolved.via === 'ai' || resolved.via === 'ai_fail') stats.aiCalls += 1;

    if (resolved.action === 'merge' && resolved.mergeFeCode) {
      mergeIntoExistingEvent(resolved.mergeFeCode, {
        contentAppendix: row.content || '',
        name: row.name,
        sponsor: row.sponsor,
        city: row.city,
      });
      stats.merged += 1;
      if (resolved.via === 'rule') stats.ruleHits += 1;
      if (resolved.via === 'ai') stats.aiMerges += 1;
      continue;
    }

    toInsert.push(row);
    batchSeen.push(row);
  }

  stats.insertedAfterDedupe = toInsert.length;
  return { toInsert, stats };
}

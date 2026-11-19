import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

const DEFAULT_QUOTE_CACHE_PATH = '/Users/meetrice/pro/meostock/data/quote_cache.db';

export type CalendarEventRow = {
  fe_code: string;
  start_at: string;
  end_at: string | null;
  start_ts: number;
  name: string;
  sponsor: string;
  city: string;
  fe_type: string;
  std_type_code: string;
  content: string;
  content_hash: string;
  source: string;
};

export type UpsertStats = {
  inserted: number;
  updated: number;
  unchanged: number;
};

/** 语义去重召回用的精简行 */
export type CalendarCandidate = {
  fe_code: string;
  start_at: string;
  end_at: string | null;
  start_ts: number | null;
  name: string;
  sponsor: string | null;
  city: string | null;
  fe_type: string | null;
  std_type_code: string | null;
  source: string;
  content: string | null;
};

let cachedDb: Database.Database | null = null;
let cachedPath: string | null = null;

export function getQuoteCachePath(): string {
  const fromEnv = String(process.env.QUOTE_CACHE_PATH || '').trim();
  return fromEnv || DEFAULT_QUOTE_CACHE_PATH;
}

export function hashContent(parts: string[]): string {
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}

export function buildFeCode(articleId: number, name: string, startAt: string, stdType: string): string {
  const digest = crypto
    .createHash('sha1')
    .update(`${name}|${startAt}|${stdType}`)
    .digest('hex')
    .slice(0, 16);
  return `feedgen_${articleId}_${digest}`;
}

function openDb(): Database.Database {
  const dbPath = getQuoteCachePath();
  if (cachedDb && cachedPath === dbPath) return cachedDb;

  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {
      /* ignore */
    }
    cachedDb = null;
    cachedPath = null;
  }

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    throw Object.assign(new Error(`财经日历数据库目录不存在: ${dir}`), { code: 'QUOTE_CACHE_DIR_MISSING' });
  }
  if (!fs.existsSync(dbPath)) {
    throw Object.assign(new Error(`财经日历数据库不存在: ${dbPath}`), { code: 'QUOTE_CACHE_MISSING' });
  }

  const db = new Database(dbPath, { readonly: false, fileMustExist: true, timeout: 5000 });
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');

  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='finance_calendar_event'`,
    )
    .get() as { name?: string } | undefined;
  if (!row?.name) {
    db.close();
    throw Object.assign(new Error('数据库中缺少表 finance_calendar_event'), {
      code: 'QUOTE_CACHE_TABLE_MISSING',
    });
  }

  cachedDb = db;
  cachedPath = dbPath;
  return db;
}

/**
 * 按 start_ts 日期窗召回候选（含东财 + feedgen），用于语义去重。
 * dayWindow：中心日 ± N 天；max：最多返回条数。
 */
export function findCandidateEvents(opts: {
  startTs: number;
  dayWindow?: number;
  max?: number;
  stdTypeCode?: string | null;
}): CalendarCandidate[] {
  const dayWindow = Math.max(0, Math.min(7, opts.dayWindow ?? 2));
  const max = Math.max(1, Math.min(50, opts.max ?? 12));
  const pad = dayWindow * 86400;
  const lo = opts.startTs - pad;
  const hi = opts.startTs + pad + 86400;

  const db = openDb();
  const std = (opts.stdTypeCode || '').trim();
  const rows = std
    ? (db
        .prepare(
          `
        SELECT fe_code, start_at, end_at, start_ts, name, sponsor, city,
               fe_type, std_type_code, source, content
        FROM finance_calendar_event
        WHERE start_ts IS NOT NULL AND start_ts >= ? AND start_ts < ?
          AND (std_type_code = ? OR std_type_code IS NULL OR std_type_code = '')
        ORDER BY ABS(start_ts - ?) ASC
        LIMIT ?
        `,
        )
        .all(lo, hi, std, opts.startTs, max) as CalendarCandidate[])
    : (db
        .prepare(
          `
        SELECT fe_code, start_at, end_at, start_ts, name, sponsor, city,
               fe_type, std_type_code, source, content
        FROM finance_calendar_event
        WHERE start_ts IS NOT NULL AND start_ts >= ? AND start_ts < ?
        ORDER BY ABS(start_ts - ?) ASC
        LIMIT ?
        `,
        )
        .all(lo, hi, opts.startTs, max) as CalendarCandidate[]);

  return rows.map((r) => ({
    fe_code: String(r.fe_code || ''),
    start_at: String(r.start_at || ''),
    end_at: r.end_at == null ? null : String(r.end_at),
    start_ts: r.start_ts == null ? null : Number(r.start_ts),
    name: String(r.name || ''),
    sponsor: r.sponsor == null ? null : String(r.sponsor),
    city: r.city == null ? null : String(r.city),
    fe_type: r.fe_type == null ? null : String(r.fe_type),
    std_type_code: r.std_type_code == null ? null : String(r.std_type_code),
    source: String(r.source || ''),
    content: r.content == null ? null : String(r.content),
  }));
}

/**
 * 将新闻抽取结果合并进已有事件：追加原文线索到 content，不改 importance，
 * 不覆盖东财等已有名称（仅 feedgen 源可更新名称）。
 */
export function mergeIntoExistingEvent(
  feCode: string,
  incoming: {
    contentAppendix: string;
    name?: string;
    sponsor?: string;
    city?: string;
  },
): boolean {
  const db = openDb();
  const now = Date.now() / 1000;
  const row = db
    .prepare(
      `SELECT fe_code, name, sponsor, city, content, content_hash, source
       FROM finance_calendar_event WHERE fe_code = ?`,
    )
    .get(feCode) as
    | {
        fe_code: string;
        name: string;
        sponsor: string | null;
        city: string | null;
        content: string | null;
        content_hash: string | null;
        source: string;
      }
    | undefined;
  if (!row) return false;

  const appendix = String(incoming.contentAppendix || '').trim();
  let content = String(row.content || '');
  if (appendix && !content.includes(appendix)) {
    content = content ? `${content}\n---\n${appendix}` : appendix;
  }

  const source = String(row.source || '');
  const name =
    source === 'feedgen' && incoming.name?.trim()
      ? incoming.name.trim().slice(0, 200)
      : row.name;
  const sponsor =
    !row.sponsor && incoming.sponsor?.trim()
      ? incoming.sponsor.trim().slice(0, 120)
      : row.sponsor;
  const city =
    !row.city && incoming.city?.trim() ? incoming.city.trim().slice(0, 80) : row.city;

  const newHash = hashContent([
    name,
    String(row.content_hash || ''),
    content,
    String(sponsor || ''),
    String(city || ''),
  ]);

  db.prepare(
    `
    UPDATE finance_calendar_event
    SET name = ?, sponsor = ?, city = ?, content = ?, content_hash = ?,
        updated_at = ?, synced_at = ?
    WHERE fe_code = ?
    `,
  ).run(name, sponsor, city, content, newHash, now, now, feCode);
  return true;
}

/** 按 fe_code upsert；不触碰 importance 字段 */
export function upsertCalendarEvents(rows: CalendarEventRow[]): UpsertStats {
  if (!rows.length) return { inserted: 0, updated: 0, unchanged: 0 };

  const db = openDb();
  const now = Date.now() / 1000;
  const selectHash = db.prepare(
    'SELECT content_hash FROM finance_calendar_event WHERE fe_code = ?',
  );
  const insertStmt = db.prepare(`
    INSERT INTO finance_calendar_event(
      fe_code, start_at, end_at, start_ts, name, sponsor, city,
      fe_type, std_type_code, content, content_hash, source,
      first_seen_at, updated_at, synced_at
    ) VALUES (
      @fe_code, @start_at, @end_at, @start_ts, @name, @sponsor, @city,
      @fe_type, @std_type_code, @content, @content_hash, @source,
      @now, @now, @now
    )
  `);
  const updateStmt = db.prepare(`
    UPDATE finance_calendar_event
    SET start_at=@start_at, end_at=@end_at, start_ts=@start_ts, name=@name,
        sponsor=@sponsor, city=@city, fe_type=@fe_type, std_type_code=@std_type_code,
        content=@content, content_hash=@content_hash, updated_at=@now, synced_at=@now
    WHERE fe_code=@fe_code
  `);
  const touchStmt = db.prepare(
    'UPDATE finance_calendar_event SET synced_at=? WHERE fe_code=?',
  );

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  const tx = db.transaction((items: CalendarEventRow[]) => {
    for (const row of items) {
      const existing = selectHash.get(row.fe_code) as { content_hash?: string } | undefined;
      const payload = { ...row, now };
      if (!existing) {
        insertStmt.run(payload);
        inserted += 1;
      } else if (String(existing.content_hash || '') !== row.content_hash) {
        updateStmt.run(payload);
        updated += 1;
      } else {
        touchStmt.run(now, row.fe_code);
        unchanged += 1;
      }
    }
  });

  tx(rows);
  return { inserted, updated, unchanged };
}

export function closeQuoteCacheDb(): void {
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {
      /* ignore */
    }
    cachedDb = null;
    cachedPath = null;
  }
}

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { StockSDK } from 'stock-sdk';

import { prisma } from '../../server';
import { buildChartSymbol, inferCnExchange, stripCnPrefix } from './chartSymbol';
import { COMMON_STOCK_ABBRS, CORE_INDEX_SEEDS } from './coreIndexSeed';
import { normalizeKeyword, shouldEnableAliasByDefault } from './keywordNorm';
import { reloadFinanceMatchIndex } from './financeMatchService';

export type SyncMode = 'full' | 'incremental';
export type SyncTrigger = 'manual' | 'scheduled' | 'init';

export type SyncResult = {
  jobId: number;
  fetched_count: number;
  created_count: number;
  updated_count: number;
  disabled_count: number;
  alias_count: number;
  sources: string[];
};

type IncomingAlias = { keyword: string; kind: string; source?: string };

type IncomingInstrument = {
  market: string;
  symbol: string;
  chart_symbol: string;
  name: string;
  name_en?: string | null;
  asset_type: string;
  exchange?: string | null;
  currency?: string | null;
  source: string;
  priority?: number;
  aliases: IncomingAlias[];
  meta?: Record<string, unknown>;
};

function usTickerFromCode(code: string): string {
  let t = String(code || '').toUpperCase();
  if (/^\d+\./.test(t)) t = t.replace(/^\d+\./, '');
  t = t.replace(/\.(O|N|A|OQ|NQ|PK|OB)$/i, '');
  return t;
}

async function fetchFromStockSdk(includeFunds: boolean): Promise<IncomingInstrument[]> {
  const sdk = new StockSDK();
  const out: IncomingInstrument[] = [];

  // —— A 股 ——
  const [cnCodes, cnBatch] = await Promise.all([sdk.codes.cn(), sdk.batch.cn()]);
  const cnChartByDigits = new Map<string, string>();
  for (const c of cnCodes as string[]) {
    const digits = stripCnPrefix(String(c));
    cnChartByDigits.set(digits, String(c).toLowerCase());
  }
  for (const q of cnBatch as Array<{ code?: string; name?: string; marketId?: string }>) {
    const digits = String(q.code || '').replace(/\D/g, '');
    if (!digits || !q.name) continue;
    const chart = cnChartByDigits.get(digits) || buildChartSymbol({ market: 'cn', symbol: digits });
    const exchange = inferCnExchange(chart);
    out.push({
      market: 'cn',
      symbol: digits,
      chart_symbol: chart,
      name: String(q.name).trim(),
      asset_type: 'stock',
      exchange,
      currency: 'CNY',
      source: 'stock_sdk',
      aliases: [
        { keyword: String(q.name).trim(), kind: 'name' },
        { keyword: digits, kind: 'code' },
        { keyword: chart, kind: 'code' },
      ],
      meta: { marketId: q.marketId },
    });
  }

  // —— 港股 ——
  const hkBatch = (await sdk.batch.hk()) as Array<{ code?: string; name?: string }>;
  for (const q of hkBatch) {
    const raw = String(q.code || '').replace(/\D/g, '');
    if (!raw || !q.name) continue;
    const symbol = raw.padStart(5, '0');
    const chart = `hk${symbol}`;
    out.push({
      market: 'hk',
      symbol,
      chart_symbol: chart,
      name: String(q.name).trim(),
      asset_type: 'stock',
      exchange: 'HK',
      currency: 'HKD',
      source: 'stock_sdk',
      aliases: [
        { keyword: String(q.name).trim(), kind: 'name' },
        { keyword: symbol, kind: 'code' },
        { keyword: chart, kind: 'code' },
      ],
    });
  }

  // —— 美股 ——
  const usBatch = (await sdk.batch.us()) as Array<{ code?: string; name?: string }>;
  for (const q of usBatch) {
    const ticker = usTickerFromCode(String(q.code || ''));
    if (!ticker || !q.name) continue;
    out.push({
      market: 'us',
      symbol: ticker,
      chart_symbol: ticker,
      name: String(q.name).trim(),
      name_en: String(q.name).trim(),
      asset_type: 'stock',
      exchange: 'US',
      currency: 'USD',
      source: 'stock_sdk',
      aliases: [
        { keyword: String(q.name).trim(), kind: 'name' },
        { keyword: ticker, kind: 'code' },
      ],
    });
  }

  // —— 公募基金（分批 quotes.fund）——
  if (includeFunds) {
    const fundCodes = (await sdk.codes.fund()) as string[];
    const chunkSize = 200;
    for (let i = 0; i < fundCodes.length; i += chunkSize) {
      const chunk = fundCodes.slice(i, i + chunkSize);
      let quotes: Array<{ code?: string; name?: string }> = [];
      try {
        quotes = (await sdk.quotes.fund(chunk)) as Array<{ code?: string; name?: string }>;
      } catch (err) {
        console.warn(
          `[FinanceSync] quotes.fund chunk ${i} failed:`,
          err instanceof Error ? err.message : String(err),
        );
        continue;
      }
      for (const q of quotes) {
        const code = String(q.code || '').replace(/\D/g, '');
        if (!code || !q.name) continue;
        out.push({
          market: 'fund',
          symbol: code,
          chart_symbol: code,
          name: String(q.name).trim(),
          asset_type: 'fund',
          exchange: 'CN',
          currency: 'CNY',
          source: 'stock_sdk',
          aliases: [
            { keyword: String(q.name).trim(), kind: 'name' },
            { keyword: code, kind: 'code' },
          ],
        });
      }
    }
  }

  return out;
}

function resolveYfinanceScriptPath(): string {
  if (process.env.YFINANCE_SCRIPT) {
    return path.resolve(process.env.YFINANCE_SCRIPT);
  }
  // dist/services/finance → 仓库根 scripts/
  const fromDist = path.resolve(__dirname, '../../../../scripts/yfinance_sync.py');
  const fromSrc = path.resolve(__dirname, '../../../scripts/yfinance_sync.py');
  const fromCwd = path.resolve(process.cwd(), '../scripts/yfinance_sync.py');
  for (const p of [fromDist, fromSrc, fromCwd]) {
    if (fs.existsSync(p)) return p;
  }
  return fromDist;
}

function runYfinanceScript(): Promise<IncomingInstrument[]> {
  return new Promise((resolve) => {
    const python = process.env.YFINANCE_PYTHON || 'python3';
    const scriptPath = resolveYfinanceScriptPath();
    const child = spawn(python, [scriptPath], { timeout: 120000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => {
      console.warn('[FinanceSync] yfinance 启动失败:', err.message);
      resolve([]);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        console.warn('[FinanceSync] yfinance 退出码', code, stderr.slice(0, 500));
        resolve([]);
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim() || '[]') as Array<{
          symbol?: string;
          name?: string;
          name_en?: string;
          market?: string;
          exchange?: string;
          asset_type?: string;
          chart_symbol?: string;
          aliases?: string[];
        }>;
        const items: IncomingInstrument[] = [];
        for (const row of parsed) {
          if (!row.symbol || !row.name) continue;
          const market = row.market || 'index';
          const symbol = String(row.symbol);
          const chart =
            row.chart_symbol ||
            buildChartSymbol({
              market,
              symbol,
              ...(row.exchange ? { exchange: row.exchange } : {}),
            });
          const aliases: IncomingAlias[] = (row.aliases || []).map((k) => ({
            keyword: k,
            kind: 'alias',
            source: 'auto',
          }));
          aliases.push({ keyword: row.name, kind: 'name', source: 'auto' });
          if (row.name_en) aliases.push({ keyword: row.name_en, kind: 'name', source: 'auto' });
          aliases.push({ keyword: symbol, kind: 'code', source: 'auto' });
          items.push({
            market,
            symbol,
            chart_symbol: chart,
            name: row.name,
            name_en: row.name_en ?? null,
            asset_type: row.asset_type || 'index',
            exchange: row.exchange ?? null,
            source: 'yfinance',
            aliases,
            priority: 180,
          });
        }
        resolve(items);
      } catch (e) {
        console.warn(
          '[FinanceSync] yfinance JSON 解析失败:',
          e instanceof Error ? e.message : String(e),
        );
        resolve([]);
      }
    });
  });
}

async function upsertAlias(
  instrumentId: number,
  keyword: string,
  kind: string,
  source: string,
): Promise<boolean> {
  const keyword_norm = normalizeKeyword(keyword);
  if (!keyword_norm) return false;
  const enabled = shouldEnableAliasByDefault(keyword_norm, kind);

  const existing = await prisma.financeAlias.findUnique({
    where: { keyword_norm },
  });
  if (existing) {
    if (existing.source === 'manual' || existing.instrument_id !== instrumentId) {
      return false;
    }
    await prisma.financeAlias.update({
      where: { id: existing.id },
      data: {
        keyword,
        kind,
        enabled: existing.source === 'manual' ? existing.enabled : enabled,
        updated_at: new Date(),
      },
    });
    return true;
  }

  await prisma.financeAlias.create({
    data: {
      instrument_id: instrumentId,
      keyword,
      keyword_norm,
      kind,
      enabled,
      source,
    },
  });
  return true;
}

/** 批量写入产品 + 别名（避免逐条 upsert 过慢） */
async function bulkPersistInstruments(
  items: IncomingInstrument[],
): Promise<{ created: number; updated: number; aliasCount: number }> {
  const now = new Date();
  const existing = await prisma.financeInstrument.findMany({
    select: {
      id: true,
      market: true,
      symbol: true,
      source: true,
      status: true,
      name_en: true,
      exchange: true,
      currency: true,
      priority: true,
      meta: true,
      chart_symbol: true,
    },
  });
  type ExistingRow = (typeof existing)[number];
  const byKey = new Map<string, ExistingRow>();
  for (const e of existing as ExistingRow[]) {
    byKey.set(`${e.market}|${e.symbol}`, e);
  }

  const toCreate: IncomingInstrument[] = [];
  const toUpdate: Array<{ id: number; item: IncomingInstrument; row: ExistingRow }> = [];

  for (const item of items) {
    const key = `${item.market}|${item.symbol}`;
    const row = byKey.get(key);
    if (!row) toCreate.push(item);
    else toUpdate.push({ id: row.id, item, row });
  }

  const CHUNK = 500;
  for (let i = 0; i < toCreate.length; i += CHUNK) {
    const chunk = toCreate.slice(i, i + CHUNK);
    await prisma.financeInstrument.createMany({
      data: chunk.map((item) => ({
        market: item.market,
        symbol: item.symbol,
        chart_symbol: item.chart_symbol,
        name: item.name,
        name_en: item.name_en || null,
        asset_type: item.asset_type,
        exchange: item.exchange || null,
        currency: item.currency || null,
        source: item.source,
        status: 'active',
        priority: item.priority ?? 100,
        meta: item.meta || undefined,
        synced_at: now,
        updated_at: now,
      })),
      skipDuplicates: true,
    });
  }

  // 更新：分批并发
  const UPDATE_CONCURRENCY = 40;
  for (let i = 0; i < toUpdate.length; i += UPDATE_CONCURRENCY) {
    const chunk = toUpdate.slice(i, i + UPDATE_CONCURRENCY);
    await Promise.all(
      chunk.map(async ({ id, item, row }) => {
        const meta = (row.meta as Record<string, unknown> | null) || {};
        const manualOverride = Boolean(meta.manual_override);
        const patch: Record<string, unknown> = {
          name: item.name,
          name_en: item.name_en ?? row.name_en,
          asset_type: item.asset_type,
          exchange: item.exchange ?? row.exchange,
          currency: item.currency ?? row.currency,
          synced_at: now,
          updated_at: now,
          status: row.status === 'disabled' ? row.status : 'active',
        };
        if (item.source === 'yfinance' && row.source === 'stock_sdk') {
          if (!row.name_en && item.name_en) patch.name_en = item.name_en;
          delete patch.name;
          delete patch.asset_type;
          delete patch.exchange;
        }
        if (!manualOverride) patch.chart_symbol = item.chart_symbol;
        if (item.priority != null && item.priority > (row.priority || 0)) {
          patch.priority = item.priority;
        }
        await prisma.financeInstrument.update({ where: { id }, data: patch });
      }),
    );
  }

  // 重新加载 id 映射
  const allRows = await prisma.financeInstrument.findMany({
    select: { id: true, market: true, symbol: true },
  });
  const idByKey = new Map<string, number>();
  for (const r of allRows as Array<{ id: number; market: string; symbol: string }>) {
    idByKey.set(`${r.market}|${r.symbol}`, r.id);
  }

  // 别名：createMany + skipDuplicates（一词一主由唯一约束保证）
  const aliasRows: Array<{
    instrument_id: number;
    keyword: string;
    keyword_norm: string;
    kind: string;
    enabled: boolean;
    source: string;
  }> = [];
  const seenNorm = new Set<string>();
  for (const item of items) {
    const id = idByKey.get(`${item.market}|${item.symbol}`);
    if (id == null) continue;
    for (const a of item.aliases) {
      const keyword_norm = normalizeKeyword(a.keyword);
      if (!keyword_norm || seenNorm.has(keyword_norm)) continue;
      seenNorm.add(keyword_norm);
      aliasRows.push({
        instrument_id: id,
        keyword: String(a.keyword).trim().slice(0, 255),
        keyword_norm: keyword_norm.slice(0, 255),
        kind: a.kind,
        enabled: shouldEnableAliasByDefault(keyword_norm, a.kind),
        source: a.source || 'auto',
      });
    }
  }

  for (let i = 0; i < aliasRows.length; i += CHUNK) {
    await prisma.financeAlias.createMany({
      data: aliasRows.slice(i, i + CHUNK),
      skipDuplicates: true,
    });
  }

  return {
    created: toCreate.length,
    updated: toUpdate.length,
    aliasCount: aliasRows.length,
  };
}

async function applySeeds(): Promise<number> {
  const seedItems: IncomingInstrument[] = CORE_INDEX_SEEDS.map((seed) => ({
    market: seed.market,
    symbol: seed.symbol,
    chart_symbol: seed.chart_symbol,
    name: seed.name,
    name_en: seed.name_en ?? null,
    asset_type: seed.asset_type,
    exchange: seed.exchange ?? null,
    source: 'manual',
    priority: seed.priority ?? 200,
    aliases: seed.aliases.map((a) => ({ ...a, source: 'manual' })),
  }));
  await bulkPersistInstruments(seedItems);

  let aliasCount = seedItems.reduce((n, s) => n + s.aliases.length, 0);
  for (const abbr of COMMON_STOCK_ABBRS) {
    const inst = await prisma.financeInstrument.findUnique({
      where: { market_symbol: { market: abbr.market, symbol: abbr.symbol } },
    });
    if (!inst) continue;
    for (const a of abbr.aliases) {
      const ok = await upsertAlias(inst.id, a.keyword, a.kind, 'manual');
      if (ok) aliasCount += 1;
    }
  }
  return aliasCount;
}

export async function runFinanceDictSync(options: {
  mode?: SyncMode;
  trigger?: SyncTrigger;
  includeFunds?: boolean;
  includeYfinance?: boolean;
}): Promise<SyncResult> {
  const mode: SyncMode = options.mode || 'full';
  const trigger: SyncTrigger = options.trigger || 'manual';
  const includeFunds = options.includeFunds !== false;
  const includeYfinance = options.includeYfinance !== false;

  const job = await prisma.financeSyncJob.create({
    data: {
      status: 'running',
      mode,
      trigger,
      source: 'stock_sdk',
      started_at: new Date(),
    },
  });

  let fetched = 0;
  let created = 0;
  let updated = 0;
  let aliasCount = 0;
  const sources: string[] = ['stock_sdk'];

  try {
    const sdkItems = await fetchFromStockSdk(includeFunds);
    fetched += sdkItems.length;

    // 去重：同 market+symbol 保留第一条（stock_sdk）
    const seen = new Set<string>();
    const merged: IncomingInstrument[] = [];
    for (const item of sdkItems) {
      const key = `${item.market}|${item.symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }

    if (includeYfinance) {
      const yfItems = await runYfinanceScript();
      if (yfItems.length) {
        sources.push('yfinance');
        fetched += yfItems.length;
        for (const item of yfItems) {
          const key = `${item.market}|${item.symbol}`;
          if (seen.has(key)) {
            // 仅追加别名到已有项
            const existing = merged.find((m) => m.market === item.market && m.symbol === item.symbol);
            if (existing) {
              existing.aliases.push(...item.aliases);
              if (!existing.name_en && item.name_en) existing.name_en = item.name_en;
            }
            continue;
          }
          seen.add(key);
          merged.push(item);
        }
      }
    }

    const persist = await bulkPersistInstruments(merged);
    created += persist.created;
    updated += persist.updated;
    aliasCount += persist.aliasCount;

    aliasCount += await applySeeds();

    await prisma.financeSyncJob.update({
      where: { id: job.id },
      data: {
        status: 'success',
        source: sources.join('+'),
        fetched_count: fetched,
        created_count: created,
        updated_count: updated,
        alias_count: aliasCount,
        finished_at: new Date(),
      },
    });

    try {
      await reloadFinanceMatchIndex();
    } catch (e) {
      console.warn(
        '[FinanceSync] 重建匹配索引失败:',
        e instanceof Error ? e.message : String(e),
      );
    }

    return {
      jobId: job.id,
      fetched_count: fetched,
      created_count: created,
      updated_count: updated,
      disabled_count: 0,
      alias_count: aliasCount,
      sources,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await prisma.financeSyncJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        error_msg: msg.slice(0, 2000),
        fetched_count: fetched,
        created_count: created,
        updated_count: updated,
        alias_count: aliasCount,
        finished_at: new Date(),
      },
    });
    throw error;
  }
}

export async function listSyncJobs(limit = 20) {
  return prisma.financeSyncJob.findMany({
    orderBy: { created_at: 'desc' },
    take: Math.min(100, Math.max(1, limit)),
  });
}

export async function getFinanceOverview() {
  const [instruments, aliases, lastJob] = await Promise.all([
    prisma.financeInstrument.count(),
    prisma.financeAlias.count({ where: { enabled: true } }),
    prisma.financeSyncJob.findFirst({ orderBy: { created_at: 'desc' } }),
  ]);
  const byMarket = await prisma.financeInstrument.groupBy({
    by: ['market'],
    _count: { _all: true },
  });
  return {
    instrument_count: instruments,
    alias_count: aliases,
    by_market: byMarket.map((r: { market: string; _count: { _all: number } }) => ({
      market: r.market,
      count: r._count._all,
    })),
    last_job: lastJob,
    match_enabled: process.env.FINANCE_MATCH_ENABLED !== '0',
    sync_enabled: process.env.FINANCE_DICT_SYNC_ENABLED !== '0',
  };
}

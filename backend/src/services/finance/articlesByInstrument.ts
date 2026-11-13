import { Prisma } from '@prisma/client';

import { prisma } from '../../server';
import { buildArticleFinanceMap } from './financeMatchService';
import { buildKlineUrl, getFinanceSettings } from './financeSettings';

export type ArticlesByInstrumentQuery = {
  chart_symbol?: string;
  market?: string;
  symbol?: string;
  cursor?: string;
  limit?: number;
  from?: string;
  to?: string;
};

export type ArticlesByInstrumentItem = {
  id: number;
  title: string;
  title_zh: string | null;
  description: string | null;
  description_zh: string | null;
  url: string;
  author: string | null;
  pub_date: string | null;
  created_at: string;
  feed_title: string;
  feed_id: number | null;
  reader_url: string;
  finance_instruments: Array<{
    id: number;
    name: string;
    symbol: string;
    chart_symbol: string;
    market: string;
    asset_type: string;
    kline_url: string;
    matched_keyword?: string;
  }>;
};

type CursorPayload = { pub: string | null; id: number };

/** 生成与 meostock klineSymbol / feedgen chart_symbol 对齐的候选 */
export function chartSymbolCandidates(raw: string): string[] {
  const s = String(raw || '').trim();
  if (!s) return [];
  const lower = s.toLowerCase();
  const upper = s.toUpperCase();
  const out = new Set<string>([s, lower, upper]);

  // 美股：usAAPL ↔ AAPL
  if (/^us[a-z0-9.\-]+$/i.test(s)) {
    const ticker = s.slice(2);
    out.add(ticker);
    out.add(ticker.toUpperCase());
    out.add(ticker.toLowerCase());
    out.add(`us${ticker.toUpperCase()}`);
    out.add(`us${ticker.toLowerCase()}`);
  } else if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s) && !/^(SH|SZ|BJ|HK)/i.test(s)) {
    out.add(`us${s}`);
    out.add(`us${s.toLowerCase()}`);
    out.add(`us${s.toUpperCase()}`);
  }

  // 港股：hk00700 / 00700
  if (/^hk\d{1,5}$/i.test(s)) {
    const digits = s.replace(/^hk/i, '').padStart(5, '0');
    out.add(`hk${digits}`);
    out.add(`HK${digits}`);
  } else if (/^\d{1,5}$/.test(s)) {
    const digits = s.padStart(5, '0');
    out.add(`hk${digits}`);
  }

  // A 股：sh600519 / 600519
  const cn = lower.match(/^(sh|sz|bj)(\d{6})$/);
  if (cn?.[1] && cn[2]) {
    out.add(`${cn[1]}${cn[2]}`);
    out.add(cn[2]);
  } else if (/^\d{6}$/.test(s)) {
    out.add(`sh${s}`);
    out.add(`sz${s}`);
    out.add(`bj${s}`);
  }

  return [...out].filter(Boolean);
}

function encodeCursor(pubDate: Date | null, id: number): string {
  const payload: CursorPayload = {
    pub: pubDate ? pubDate.toISOString() : null,
    id,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | undefined): CursorPayload | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(String(raw), 'base64url').toString('utf8');
    const obj = JSON.parse(json) as CursorPayload;
    if (!obj || typeof obj.id !== 'number') return null;
    return obj;
  } catch {
    return null;
  }
}

function parseDayBound(raw: string | undefined, endOfDay: boolean): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(`${s}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function resolveInstrumentIds(q: ArticlesByInstrumentQuery): Promise<number[]> {
  const candidates = new Set<string>();
  for (const c of chartSymbolCandidates(String(q.chart_symbol || ''))) {
    candidates.add(c);
  }
  const market = String(q.market || '').trim().toLowerCase();
  const symbol = String(q.symbol || '').trim();
  if (symbol) {
    candidates.add(symbol);
    for (const c of chartSymbolCandidates(symbol)) candidates.add(c);
  }

  const list = [...candidates];
  if (!list.length && !(market && symbol)) return [];

  const or: Prisma.FinanceInstrumentWhereInput[] = [];
  if (list.length) {
    or.push({ chart_symbol: { in: list, mode: 'insensitive' } });
    or.push({ symbol: { in: list, mode: 'insensitive' } });
  }
  if (market && symbol) {
    or.push({
      market: { equals: market, mode: 'insensitive' },
      symbol: { equals: symbol, mode: 'insensitive' },
    });
  }

  const rows = await prisma.financeInstrument.findMany({
    where: {
      status: 'active',
      OR: or,
    },
    select: { id: true },
    take: 20,
  });
  return rows.map((r: { id: number }) => r.id);
}

/**
 * 按金融产品倒序分页文章（供 meostock 资讯时间线）。
 */
export async function listArticlesByInstrument(
  q: ArticlesByInstrumentQuery,
): Promise<{
  ok: true;
  articles: ArticlesByInstrumentItem[];
  next_cursor: string | null;
  instrument_ids: number[];
}> {
  const instrumentIds = await resolveInstrumentIds(q);
  if (!instrumentIds.length) {
    return { ok: true, articles: [], next_cursor: null, instrument_ids: [] };
  }

  const limit = Math.min(50, Math.max(1, Number(q.limit) || 20));
  const cursor = decodeCursor(q.cursor);
  const from = parseDayBound(q.from, false);
  const to = parseDayBound(q.to, true);

  const filterParts: Prisma.Sql[] = [
    Prisma.sql`EXISTS (
      SELECT 1 FROM "article_finance_instruments" afi
      WHERE afi."article_id" = a."id"
        AND afi."instrument_id" IN (${Prisma.join(instrumentIds)})
    )`,
  ];
  if (from) {
    filterParts.push(Prisma.sql`COALESCE(a."pub_date", a."created_at") >= ${from}`);
  }
  if (to) {
    filterParts.push(Prisma.sql`COALESCE(a."pub_date", a."created_at") <= ${to}`);
  }
  if (cursor) {
    const cPub = cursor.pub ? new Date(cursor.pub) : null;
    const cId = cursor.id;
    if (cPub && !Number.isNaN(cPub.getTime())) {
      filterParts.push(
        Prisma.sql`(
          COALESCE(a."pub_date", a."created_at") < ${cPub}
          OR (
            COALESCE(a."pub_date", a."created_at") = ${cPub}
            AND a."id" < ${cId}
          )
        )`,
      );
    } else {
      filterParts.push(Prisma.sql`a."id" < ${cId}`);
    }
  }

  const whereSql = Prisma.sql`${Prisma.join(filterParts, ' AND ')}`;

  const rows = (await prisma.$queryRaw(
    Prisma.sql`
      SELECT
        a."id",
        a."title",
        a."title_zh",
        a."description",
        a."description_zh",
        a."url",
        a."author",
        a."pub_date",
        a."created_at",
        a."feed_id",
        f."title" AS feed_title
      FROM "articles" a
      LEFT JOIN "feeds" f ON f."id" = a."feed_id"
      WHERE ${whereSql}
      ORDER BY COALESCE(a."pub_date", a."created_at") DESC, a."id" DESC
      LIMIT ${limit + 1}
    `,
  )) as Array<{
    id: number;
    title: string;
    title_zh: string | null;
    description: string | null;
    description_zh: string | null;
    url: string;
    author: string | null;
    pub_date: Date | null;
    created_at: Date;
    feed_id: number | null;
    feed_title: string | null;
  }>;

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;

  const settings = await getFinanceSettings();
  const financeMap = await buildArticleFinanceMap(slice.map((r) => r.id));
  const basePublic =
    String(process.env.FEEDGEN_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || '').replace(
      /\/$/,
      '',
    ) || '';

  const articles: ArticlesByInstrumentItem[] = slice.map((item) => {
    const instruments = financeMap.get(item.id) || [];
    // 确保 kline_url 最新
    const withUrls = instruments.map((inst) => ({
      ...inst,
      kline_url: inst.kline_url || buildKlineUrl(inst.chart_symbol, settings),
    }));
    const readerPath = `/?article=${item.id}`;
    return {
      id: item.id,
      title: item.title,
      title_zh: item.title_zh,
      description: item.description,
      description_zh: item.description_zh,
      url: item.url,
      author: item.author,
      pub_date: item.pub_date ? item.pub_date.toISOString() : null,
      created_at: item.created_at.toISOString(),
      feed_title: item.feed_title || '',
      feed_id: item.feed_id,
      reader_url: basePublic ? `${basePublic}${readerPath}` : readerPath,
      finance_instruments: withUrls,
    };
  });

  let next_cursor: string | null = null;
  const last = hasMore && slice.length ? slice[slice.length - 1] : undefined;
  if (last) {
    next_cursor = encodeCursor(last.pub_date || last.created_at, last.id);
  }

  return { ok: true, articles, next_cursor, instrument_ids: instrumentIds };
}

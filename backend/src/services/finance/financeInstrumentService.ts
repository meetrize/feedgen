import { prisma } from '../../server';
import { buildChartSymbol } from './chartSymbol';
import { normalizeKeyword, shouldEnableAliasByDefault } from './keywordNorm';
import { reloadFinanceMatchIndex } from './financeMatchService';

export async function listInstruments(query: {
  q?: string;
  market?: string;
  asset_type?: string;
  status?: string;
  limit?: number;
  offset?: number;
}) {
  const limit = Math.min(200, Math.max(1, query.limit || 50));
  const offset = Math.max(0, query.offset || 0);
  const where: Record<string, unknown> = {};
  if (query.market) where.market = query.market;
  if (query.asset_type) where.asset_type = query.asset_type;
  if (query.status) where.status = query.status;
  if (query.q?.trim()) {
    const q = query.q.trim();
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { symbol: { contains: q, mode: 'insensitive' } },
      { chart_symbol: { contains: q, mode: 'insensitive' } },
      { name_en: { contains: q, mode: 'insensitive' } },
    ];
  }

  const [total, items] = await Promise.all([
    prisma.financeInstrument.count({ where }),
    prisma.financeInstrument.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { id: 'asc' }],
      take: limit,
      skip: offset,
      include: { _count: { select: { aliases: true } } },
    }),
  ]);

  return {
    total,
    limit,
    offset,
    instruments: items.map((it: any) => ({
      ...it,
      alias_count: it._count?.aliases ?? 0,
      _count: undefined,
    })),
  };
}

export async function createInstrument(body: {
  symbol: string;
  name: string;
  market: string;
  chart_symbol?: string;
  name_en?: string;
  asset_type?: string;
  exchange?: string;
  priority?: number;
  aliases?: string[];
}) {
  const symbol = String(body.symbol || '').trim();
  const name = String(body.name || '').trim();
  const market = String(body.market || '').trim().toLowerCase();
  if (!symbol || !name || !market) {
    throw new Error('symbol、name、market 为必填项');
  }
  const chart_symbol =
    body.chart_symbol?.trim() ||
    buildChartSymbol({
      market,
      symbol,
      ...(body.exchange ? { exchange: body.exchange } : {}),
    });

  const created = await prisma.financeInstrument.create({
    data: {
      symbol,
      name,
      market,
      chart_symbol,
      name_en: body.name_en || null,
      asset_type: body.asset_type || 'stock',
      exchange: body.exchange || null,
      source: 'manual',
      status: 'active',
      priority: body.priority ?? 100,
      meta: { manual_override: Boolean(body.chart_symbol) },
      synced_at: new Date(),
    },
  });

  const aliasKeywords = [
    name,
    symbol,
    chart_symbol,
    ...(body.name_en ? [body.name_en] : []),
    ...(body.aliases || []),
  ];
  for (const kw of aliasKeywords) {
    await tryCreateAlias(created.id, kw, kw === symbol || kw === chart_symbol ? 'code' : 'alias', 'manual');
  }
  await reloadFinanceMatchIndex();
  return created;
}

export async function updateInstrument(
  id: number,
  body: {
    name?: string;
    name_en?: string | null;
    chart_symbol?: string;
    status?: string;
    priority?: number;
    exchange?: string | null;
    asset_type?: string;
  },
) {
  const existing = await prisma.financeInstrument.findUnique({ where: { id } });
  if (!existing) throw new Error('产品不存在');

  const meta = ((existing.meta as Record<string, unknown>) || {}) as Record<string, unknown>;
  if (body.chart_symbol != null && body.chart_symbol !== existing.chart_symbol) {
    meta.manual_override = true;
  }

  const updated = await prisma.financeInstrument.update({
    where: { id },
    data: {
      ...(body.name != null ? { name: String(body.name).trim() } : {}),
      ...(body.name_en !== undefined ? { name_en: body.name_en } : {}),
      ...(body.chart_symbol != null ? { chart_symbol: String(body.chart_symbol).trim() } : {}),
      ...(body.status != null ? { status: body.status } : {}),
      ...(body.priority != null ? { priority: Number(body.priority) } : {}),
      ...(body.exchange !== undefined ? { exchange: body.exchange } : {}),
      ...(body.asset_type != null ? { asset_type: body.asset_type } : {}),
      meta,
      updated_at: new Date(),
    },
  });
  return updated;
}

async function tryCreateAlias(
  instrumentId: number,
  keyword: string,
  kind: string,
  source: string,
) {
  const keyword_norm = normalizeKeyword(keyword);
  if (!keyword_norm) return null;
  const existing = await prisma.financeAlias.findUnique({ where: { keyword_norm } });
  if (existing) {
    if (existing.instrument_id !== instrumentId) {
      throw new Error(`关键词「${keyword}」已被其他产品占用`);
    }
    return existing;
  }
  return prisma.financeAlias.create({
    data: {
      instrument_id: instrumentId,
      keyword: String(keyword).trim(),
      keyword_norm,
      kind,
      enabled: shouldEnableAliasByDefault(keyword_norm, kind),
      source,
    },
  });
}

export async function listAliases(instrumentId: number) {
  return prisma.financeAlias.findMany({
    where: { instrument_id: instrumentId },
    orderBy: [{ kind: 'asc' }, { id: 'asc' }],
  });
}

export async function createAlias(
  instrumentId: number,
  body: { keyword: string; kind?: string; enabled?: boolean },
) {
  const inst = await prisma.financeInstrument.findUnique({ where: { id: instrumentId } });
  if (!inst) throw new Error('产品不存在');
  const created = await tryCreateAlias(
    instrumentId,
    body.keyword,
    body.kind || 'alias',
    'manual',
  );
  if (created && body.enabled === false) {
    await prisma.financeAlias.update({
      where: { id: created.id },
      data: { enabled: false },
    });
  }
  await reloadFinanceMatchIndex();
  return created;
}

export async function updateAlias(
  instrumentId: number,
  aliasId: number,
  body: { keyword?: string; kind?: string; enabled?: boolean },
) {
  const alias = await prisma.financeAlias.findFirst({
    where: { id: aliasId, instrument_id: instrumentId },
  });
  if (!alias) throw new Error('别名不存在');

  const data: Record<string, unknown> = { updated_at: new Date(), source: 'manual' };
  if (body.kind != null) data.kind = body.kind;
  if (body.enabled != null) data.enabled = body.enabled;
  if (body.keyword != null) {
    const keyword = String(body.keyword).trim();
    const keyword_norm = normalizeKeyword(keyword);
    if (!keyword_norm) throw new Error('关键词不能为空');
    const conflict = await prisma.financeAlias.findUnique({ where: { keyword_norm } });
    if (conflict && conflict.id !== aliasId) {
      throw new Error(`关键词「${keyword}」已被其他产品占用`);
    }
    data.keyword = keyword;
    data.keyword_norm = keyword_norm;
  }

  const updated = await prisma.financeAlias.update({ where: { id: aliasId }, data });
  await reloadFinanceMatchIndex();
  return updated;
}

export async function deleteAlias(instrumentId: number, aliasId: number) {
  const alias = await prisma.financeAlias.findFirst({
    where: { id: aliasId, instrument_id: instrumentId },
  });
  if (!alias) throw new Error('别名不存在');
  await prisma.financeAlias.delete({ where: { id: aliasId } });
  await reloadFinanceMatchIndex();
}

import { prisma } from '../../server';
import { AhoCorasickIndex, hasCodeBoundary, type AcHit } from './acIndex';
import { buildKlineUrl, getFinanceSettings } from './financeSettings';
import { isPureNumericCode, normalizeKeyword, shouldEnableAliasByDefault } from './keywordNorm';

const MAX_PER_ARTICLE = 5;
const DESC_TRUNCATE = 2000;

let matchIndex: AhoCorasickIndex | null = null;
let indexLoading: Promise<void> | null = null;

export type ArticleFinanceListItem = {
  id: number;
  name: string;
  symbol: string;
  chart_symbol: string;
  market: string;
  asset_type: string;
  kline_url: string;
  matched_keyword?: string;
};

function isMatchEnabled(): boolean {
  return process.env.FINANCE_MATCH_ENABLED !== '0';
}

export async function reloadFinanceMatchIndex(): Promise<{ patterns: number }> {
  const aliases = await prisma.financeAlias.findMany({
    where: {
      enabled: true,
      instrument: { status: 'active' },
    },
    select: {
      keyword: true,
      keyword_norm: true,
      kind: true,
      source: true,
      instrument_id: true,
      instrument: { select: { priority: true } },
    },
  });

  const idx = new AhoCorasickIndex();
  for (const a of aliases) {
    // auto 短 code 运行时再过滤，避免历史同步留下的短 ticker 误匹配；manual 别名保留
    if (
      a.source !== 'manual' &&
      a.kind === 'code' &&
      !shouldEnableAliasByDefault(a.keyword_norm, a.kind)
    ) {
      continue;
    }
    idx.add({
      keywordNorm: a.keyword_norm,
      keyword: a.keyword,
      kind: a.kind,
      instrumentId: a.instrument_id,
      priority: a.instrument.priority ?? 100,
    });
  }
  idx.build();
  matchIndex = idx;
  console.log(`[FinanceMatch] 内存索引已加载 patterns=${idx.size}`);
  return { patterns: idx.size };
}

async function ensureIndex(): Promise<AhoCorasickIndex> {
  if (matchIndex) return matchIndex;
  if (!indexLoading) {
    indexLoading = reloadFinanceMatchIndex()
      .then(() => undefined)
      .finally(() => {
        indexLoading = null;
      });
  }
  await indexLoading;
  if (!matchIndex) {
    matchIndex = new AhoCorasickIndex();
    matchIndex.build();
  }
  return matchIndex;
}

type FieldHit = {
  instrumentId: number;
  keyword: string;
  kind: string;
  priority: number;
  field: string;
  confidence: number;
  keywordLen: number;
};

function collectHits(text: string, field: string, idx: AhoCorasickIndex): FieldHit[] {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const truncated = raw.length > DESC_TRUNCATE ? raw.slice(0, DESC_TRUNCATE) : raw;
  const norm = normalizeKeyword(truncated);
  if (!norm) return [];

  const hits: AcHit[] = idx.search(norm);
  const out: FieldHit[] = [];
  for (const hit of hits) {
    const p = hit.pattern;
    const isCodeLike =
      p.kind === 'code' ||
      isPureNumericCode(p.keywordNorm) ||
      /^[a-z0-9.^]{1,6}$/i.test(p.keywordNorm);
    // 短代码 / ticker 必须落在非字母数字边界，避免 CURI 误匹配英文词片段
    if (isCodeLike && p.keywordNorm.length <= 5) {
      if (!hasCodeBoundary(norm, hit.start, hit.end)) continue;
    }
    let confidence = 1;
    if (p.kind === 'code' && isPureNumericCode(p.keywordNorm)) confidence = 0.7;
    else if (p.kind === 'code' && p.keywordNorm.length <= 4) confidence = 0.65;
    else if (p.keywordNorm.length < 3) confidence = 0.75;
    out.push({
      instrumentId: p.instrumentId,
      keyword: p.keyword,
      kind: p.kind,
      priority: p.priority,
      field,
      confidence,
      keywordLen: p.keywordNorm.length,
    });
  }
  return out;
}

function pickBest(hits: FieldHit[]): FieldHit[] {
  const byInst = new Map<number, FieldHit>();
  for (const h of hits) {
    const prev = byInst.get(h.instrumentId);
    if (!prev) {
      byInst.set(h.instrumentId, h);
      continue;
    }
    // 更长关键词优先，其次 priority，其次 confidence
    if (
      h.keywordLen > prev.keywordLen ||
      (h.keywordLen === prev.keywordLen && h.priority > prev.priority) ||
      (h.keywordLen === prev.keywordLen &&
        h.priority === prev.priority &&
        h.confidence > prev.confidence)
    ) {
      byInst.set(h.instrumentId, h);
    }
  }
  return [...byInst.values()]
    .sort((a, b) => b.keywordLen - a.keywordLen || b.priority - a.priority || b.confidence - a.confidence)
    .slice(0, MAX_PER_ARTICLE);
}

export async function matchArticleById(articleId: number): Promise<number> {
  if (!isMatchEnabled()) return 0;

  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: {
      id: true,
      title: true,
      title_zh: true,
      description: true,
      description_zh: true,
    },
  });
  if (!article) return 0;

  const idx = await ensureIndex();
  const titleText = article.title_zh || article.title || '';
  const descText = article.description_zh || article.description || '';

  const hits = pickBest([
    ...collectHits(titleText, article.title_zh ? 'title_zh' : 'title', idx),
    ...collectHits(descText, article.description_zh ? 'description_zh' : 'description', idx),
  ]);

  await prisma.articleFinanceInstrument.deleteMany({ where: { article_id: articleId } });

  if (!hits.length) return 0;

  const now = new Date();
  await prisma.articleFinanceInstrument.createMany({
    data: hits.map((h) => ({
      article_id: articleId,
      instrument_id: h.instrumentId,
      matched_keyword: h.keyword.slice(0, 255),
      matched_field: h.field.slice(0, 32),
      confidence: h.confidence,
      matched_at: now,
    })),
    skipDuplicates: true,
  });

  return hits.length;
}

export async function backfillFinanceMatch(options: {
  since?: Date;
  until?: Date;
  limit?: number;
}): Promise<{ matched_articles: number; processed: number }> {
  const limit = Math.min(5000, Math.max(1, options.limit || 500));
  const where: Record<string, unknown> = {};
  if (options.since || options.until) {
    where.created_at = {
      ...(options.since ? { gte: options.since } : {}),
      ...(options.until ? { lte: options.until } : {}),
    };
  }

  const articles = await prisma.article.findMany({
    where,
    select: { id: true },
    orderBy: { created_at: 'desc' },
    take: limit,
  });

  let matchedArticles = 0;
  for (const a of articles) {
    const n = await matchArticleById(a.id);
    if (n > 0) matchedArticles += 1;
  }
  return { matched_articles: matchedArticles, processed: articles.length };
}

/** 批量加载文章列表用的金融产品（避免 N+1） */
export async function buildArticleFinanceMap(
  articleIds: number[],
): Promise<Map<number, ArticleFinanceListItem[]>> {
  const map = new Map<number, ArticleFinanceListItem[]>();
  for (const id of articleIds) map.set(id, []);
  if (!articleIds.length) return map;

  const settings = await getFinanceSettings();
  const rows = await prisma.articleFinanceInstrument.findMany({
    where: {
      article_id: { in: articleIds },
      instrument: { status: 'active' },
    },
    include: {
      instrument: {
        select: {
          id: true,
          name: true,
          symbol: true,
          chart_symbol: true,
          market: true,
          asset_type: true,
          priority: true,
        },
      },
    },
    orderBy: { matched_at: 'desc' },
  });

  for (const row of rows) {
    const list = map.get(row.article_id) || [];
    if (list.length >= settings.max_chips) continue;
    const inst = row.instrument;
    list.push({
      id: inst.id,
      name: inst.name,
      symbol: inst.symbol,
      chart_symbol: inst.chart_symbol,
      market: inst.market,
      asset_type: inst.asset_type,
      kline_url: buildKlineUrl(inst.chart_symbol, settings),
      matched_keyword: row.matched_keyword,
    });
    map.set(row.article_id, list);
  }
  return map;
}

export async function removeArticleInstrument(
  articleId: number,
  instrumentId: number,
  disableAliasKeyword?: string,
): Promise<void> {
  await prisma.articleFinanceInstrument.deleteMany({
    where: { article_id: articleId, instrument_id: instrumentId },
  });
  if (disableAliasKeyword) {
    const norm = normalizeKeyword(disableAliasKeyword);
    if (norm) {
      await prisma.financeAlias.updateMany({
        where: { keyword_norm: norm },
        data: { enabled: false, updated_at: new Date() },
      });
      await reloadFinanceMatchIndex();
    }
  }
}

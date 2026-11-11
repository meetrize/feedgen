import { Prisma } from '@prisma/client';

import { prisma } from '../../server';
import { bigramJaccard, hammingDistance } from './simhash';
import { buildTitleDedupFields } from './titleFingerprint';
import { normalizeTitle, normalizeUrl } from './titleNormalize';

export type DedupConfig = {
  hammingMax: number;
  jaccardMin: number;
  forceRebuild: boolean;
};

export const DEFAULT_DEDUP_CONFIG: DedupConfig = {
  hammingMax: 3,
  jaccardMin: 0.88,
  forceRebuild: false,
};

export type DedupProgress = {
  progress: number;
  progressText: string;
  stats: Record<string, number>;
};

type ArticleRow = {
  id: number;
  title: string;
  title_norm: string | null;
  title_simhash: bigint | null;
  url: string | null;
  pub_date: Date | null;
  created_at: Date;
  dup_cluster_id: number | null;
};

function localDayBounds(runDay: string): { start: Date; end: Date; dayDate: Date } {
  // runDay = YYYY-MM-DD in local timezone
  const [y, m, d] = runDay.split('-').map((x) => Number(x));
  const start = new Date(y!, m! - 1, d!, 0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const dayDate = new Date(Date.UTC(y!, m! - 1, d!));
  return { start, end, dayDate };
}

export function formatLocalDay(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function sortEarliest(a: ArticleRow, b: ArticleRow): number {
  const ap = a.pub_date ? a.pub_date.getTime() : Number.POSITIVE_INFINITY;
  const bp = b.pub_date ? b.pub_date.getTime() : Number.POSITIVE_INFINITY;
  if (ap !== bp) return ap - bp;
  const ac = a.created_at.getTime();
  const bc = b.created_at.getTime();
  if (ac !== bc) return ac - bc;
  return a.id - b.id;
}

function sameCluster(a: ArticleRow, b: ArticleRow, cfg: DedupConfig): boolean {
  const urlA = normalizeUrl(a.url);
  const urlB = normalizeUrl(b.url);
  if (urlA && urlB && urlA === urlB) return true;

  const na = a.title_norm || normalizeTitle(a.title);
  const nb = b.title_norm || normalizeTitle(b.title);
  if (!na || !nb) return false;
  if (na === nb) return true;

  if (a.title_simhash != null && b.title_simhash != null) {
    const dist = hammingDistance(a.title_simhash, b.title_simhash);
    if (dist > cfg.hammingMax) return false;
  }

  return bigramJaccard(na, nb) >= cfg.jaccardMin;
}

async function ensureFingerprints(rows: ArticleRow[]): Promise<void> {
  const updates: Array<{ id: number; title_norm: string | null; title_simhash: bigint | null }> = [];
  for (const row of rows) {
    if (row.title_norm && row.title_simhash != null) continue;
    const fields = buildTitleDedupFields(row.title);
    row.title_norm = fields.title_norm;
    row.title_simhash = fields.title_simhash;
    updates.push({ id: row.id, ...fields });
  }
  for (const u of updates) {
    await prisma.article.update({
      where: { id: u.id },
      data: {
        title_norm: u.title_norm,
        title_simhash: u.title_simhash,
      },
    });
  }
}

async function clearDayClusters(runDay: string): Promise<number> {
  const { start, end, dayDate } = localDayBounds(runDay);
  const articles = await prisma.article.findMany({
    where: {
      OR: [
        { pub_date: { gte: start, lt: end } },
        { AND: [{ pub_date: null }, { created_at: { gte: start, lt: end } }] },
      ],
    },
    select: { id: true, dup_cluster_id: true },
  });
  const clusterIds = [
    ...new Set(
      articles
        .map((a: { dup_cluster_id: number | null }) => a.dup_cluster_id)
        .filter((x: number | null): x is number => x != null),
    ),
  ];

  if (articles.length) {
    await prisma.article.updateMany({
      where: { id: { in: articles.map((a: { id: number }) => a.id) } },
      data: {
        dup_cluster_id: null,
        dup_is_primary: true,
        dup_checked_at: null,
      },
    });
  }

  if (clusterIds.length) {
    await prisma.articleDupCluster.deleteMany({
      where: { OR: [{ id: { in: clusterIds } }, { run_day: dayDate }] },
    });
  } else {
    await prisma.articleDupCluster.deleteMany({ where: { run_day: dayDate } });
  }
  return articles.length;
}

/**
 * 对指定自然日跑近重复聚类。
 * shouldCancel: 协作式取消回调
 */
export async function runDedupForDay(
  runDay: string,
  config: Partial<DedupConfig> = {},
  options: {
    shouldCancel?: () => Promise<boolean>;
    onProgress?: (p: DedupProgress) => Promise<void> | void;
  } = {},
): Promise<Record<string, number | boolean>> {
  const cfg: DedupConfig = { ...DEFAULT_DEDUP_CONFIG, ...config };
  const { start, end, dayDate } = localDayBounds(runDay);

  if (cfg.forceRebuild) {
    await clearDayClusters(runDay);
  }

  const where: Prisma.ArticleWhereInput = {
    OR: [
      { pub_date: { gte: start, lt: end } },
      { AND: [{ pub_date: null }, { created_at: { gte: start, lt: end } }] },
    ],
  };

  const rowsRaw = await prisma.article.findMany({
    where,
    select: {
      id: true,
      title: true,
      title_norm: true,
      title_simhash: true,
      url: true,
      pub_date: true,
      created_at: true,
      dup_cluster_id: true,
      dup_checked_at: true,
    },
    orderBy: [{ pub_date: 'asc' }, { created_at: 'asc' }, { id: 'asc' }],
  });

  const rows: ArticleRow[] = rowsRaw.map((r: (typeof rowsRaw)[number]) => ({
    id: r.id,
    title: r.title,
    title_norm: r.title_norm,
    title_simhash: r.title_simhash,
    url: r.url,
    pub_date: r.pub_date,
    created_at: r.created_at,
    dup_cluster_id: r.dup_cluster_id,
  }));

  await ensureFingerprints(rows);

  const total = rows.length;
  let processed = 0;
  let clustersCreated = 0;
  let membersMerged = 0;
  let cancelled = false;

  // Union-Find
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let p = parent.get(x) ?? x;
    if (p !== x) {
      p = find(p);
      parent.set(x, p);
    }
    return p;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // 挂到更早的那一侧的根（按 id 近似；最终再按时间选 primary）
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  for (const r of rows) parent.set(r.id, r.id);

  const report = async (force = false) => {
    if (!options.onProgress) return;
    if (!force && processed % 25 !== 0 && processed !== total) return;
    const progress = total === 0 ? 100 : Math.min(99, Math.round((processed / total) * 100));
    await options.onProgress({
      progress,
      progressText: `处理 ${processed}/${total}`,
      stats: {
        total,
        processed,
        clustersCreated,
        membersMerged,
      },
    });
  };

  // 两两比较：日窗文章量通常可控；大日可后续改 LSH 桶
  for (let i = 0; i < rows.length; i++) {
    if (options.shouldCancel && (await options.shouldCancel())) {
      cancelled = true;
      break;
    }
    const a = rows[i]!;
    for (let j = i + 1; j < rows.length; j++) {
      const b = rows[j]!;
      if (sameCluster(a, b, cfg)) union(a.id, b.id);
    }
    processed = i + 1;
    await report();
  }

  if (cancelled) {
    await options.onProgress?.({
      progress: Math.min(99, Math.round((processed / Math.max(total, 1)) * 100)),
      progressText: '已取消',
      stats: { total, processed, clustersCreated, membersMerged },
    });
    return { total, processed, clustersCreated, membersMerged, cancelled: true };
  }

  const groups = new Map<number, ArticleRow[]>();
  for (const r of rows) {
    const root = find(r.id);
    const list = groups.get(root) || [];
    list.push(r);
    groups.set(root, list);
  }

  const now = new Date();

  for (const members of groups.values()) {
    if (options.shouldCancel && (await options.shouldCancel())) {
      cancelled = true;
      break;
    }
    members.sort(sortEarliest);
    const primary = members[0]!;

    if (members.length === 1) {
      await prisma.article.update({
        where: { id: primary.id },
        data: {
          dup_cluster_id: null,
          dup_is_primary: true,
          dup_checked_at: now,
        },
      });
      continue;
    }

    const sampleTitle = (primary.title || '').slice(0, 500);
    const existingClusterId = members.map((m) => m.dup_cluster_id).find((x) => x != null) ?? null;

    let clusterId: number;
    if (existingClusterId != null && !cfg.forceRebuild) {
      await prisma.articleDupCluster.update({
        where: { id: existingClusterId },
        data: {
          primary_article_id: primary.id,
          member_count: members.length,
          sample_title: sampleTitle,
          updated_at: now,
          run_day: dayDate,
        },
      });
      clusterId = existingClusterId;
    } else {
      const created = await prisma.articleDupCluster.create({
        data: {
          run_day: dayDate,
          primary_article_id: primary.id,
          member_count: members.length,
          sample_title: sampleTitle,
          created_at: now,
          updated_at: now,
        },
      });
      clusterId = created.id;
      clustersCreated += 1;
    }

    for (let i = 0; i < members.length; i++) {
      const m = members[i]!;
      await prisma.article.update({
        where: { id: m.id },
        data: {
          dup_cluster_id: clusterId,
          dup_is_primary: i === 0,
          dup_checked_at: now,
        },
      });
    }
    membersMerged += members.length - 1;
  }

  const stats = {
    total,
    processed: total,
    clustersCreated,
    membersMerged,
    clusterGroups: [...groups.values()].filter((g) => g.length > 1).length,
  };

  await options.onProgress?.({
    progress: cancelled ? 99 : 100,
    progressText: cancelled ? '已取消' : `完成 ${total} 篇，簇 ${stats.clusterGroups}`,
    stats,
  });

  return { ...stats, cancelled };
}

export async function runDedupBackfill(
  fromDay: string,
  toDay: string,
  config: Partial<DedupConfig> = {},
  options: {
    shouldCancel?: () => Promise<boolean>;
    onProgress?: (p: DedupProgress) => Promise<void> | void;
  } = {},
): Promise<Record<string, number | boolean>> {
  const days: string[] = [];
  const { start } = localDayBounds(fromDay);
  const { start: endStart } = localDayBounds(toDay);
  const cur = new Date(start);
  while (cur.getTime() <= endStart.getTime()) {
    days.push(formatLocalDay(cur));
    cur.setDate(cur.getDate() + 1);
  }

  let dayIndex = 0;
  const aggregate = {
    days: days.length,
    total: 0,
    clustersCreated: 0,
    membersMerged: 0,
    cancelled: false as boolean,
  };

  for (const day of days) {
    if (options.shouldCancel && (await options.shouldCancel())) {
      aggregate.cancelled = true;
      break;
    }
    dayIndex += 1;
    await options.onProgress?.({
      progress: Math.round(((dayIndex - 1) / Math.max(days.length, 1)) * 100),
      progressText: `回填 ${day} (${dayIndex}/${days.length})`,
      stats: {
        days: aggregate.days,
        total: aggregate.total,
        clustersCreated: aggregate.clustersCreated,
        membersMerged: aggregate.membersMerged,
      },
    });

    const dayOpts: {
      shouldCancel?: () => Promise<boolean>;
      onProgress?: (p: DedupProgress) => Promise<void> | void;
    } = {
      onProgress: async (p) => {
        const base = ((dayIndex - 1) / Math.max(days.length, 1)) * 100;
        const slice = (1 / Math.max(days.length, 1)) * p.progress;
        await options.onProgress?.({
          progress: Math.min(99, Math.round(base + slice)),
          progressText: `${day}: ${p.progressText}`,
          stats: {
            days: aggregate.days,
            total: aggregate.total,
            clustersCreated: aggregate.clustersCreated,
            membersMerged: aggregate.membersMerged,
            ...(p.stats || {}),
          },
        });
      },
    };
    if (options.shouldCancel) dayOpts.shouldCancel = options.shouldCancel;

    const stats = await runDedupForDay(day, config, dayOpts);

    aggregate.total += Number(stats.total || 0);
    aggregate.clustersCreated += Number(stats.clustersCreated || 0);
    aggregate.membersMerged += Number(stats.membersMerged || 0);
    if (stats.cancelled) {
      aggregate.cancelled = true;
      break;
    }
  }

  await options.onProgress?.({
    progress: aggregate.cancelled ? 99 : 100,
    progressText: aggregate.cancelled ? '回填已取消' : `回填完成 ${days.length} 天`,
    stats: {
      days: aggregate.days,
      total: aggregate.total,
      clustersCreated: aggregate.clustersCreated,
      membersMerged: aggregate.membersMerged,
    },
  });

  return aggregate;
}

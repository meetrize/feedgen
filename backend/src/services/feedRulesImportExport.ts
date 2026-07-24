import type { Feed, FeedCrawlerStrategy, UserFeedGroup } from '@prisma/client';
import { prisma } from '../server';
import { buildSourceFingerprint } from './sourceFingerprint';
import { checkSource } from './publicFeedService';

export const FEED_RULES_FORMAT = 'feedgen-rules';
export const FEED_RULES_VERSION = 1;

const STRATEGY_MODES = new Set(['auto', 'manual', 'cooldown', 'disabled']);
const MIN_INTERVAL = 60;
const MAX_INTERVAL = 604800;

export type CrawlerStrategyExport = {
  strategy_mode: string;
  min_interval: number;
  max_interval: number;
  failure_threshold: number;
  auto_disable_enabled: boolean;
  note: string | null;
};

export type FeedRuleExport = {
  kind: 'native' | 'parsed';
  title: string;
  description: string;
  url: string;
  feed_type: string;
  source_type: 'native' | 'parsed';
  update_interval: number;
  use_proxy: boolean;
  needs_translation: boolean;
  favicon_url: string | null;
  favicon_custom_text: string | null;
  favicon_custom_bg: string | null;
  is_active: boolean;
  group_name: string | null;
  sort_order: number;
  selector_rules: object | null;
  auth_cookie: string | null;
  crawler_strategy: CrawlerStrategyExport | null;
};

export type FeedRulesBundle = {
  format: typeof FEED_RULES_FORMAT;
  version: number;
  exported_at: string;
  app: 'feedgen';
  include_secrets: boolean;
  groups: Array<{ name: string; icon: string | null }>;
  feeds: FeedRuleExport[];
};

export type ImportDetail = {
  url: string;
  status: 'created' | 'updated' | 'failed';
  feed_id?: number;
  reason?: string;
  note?: string;
};

export type ImportReport = {
  created: number;
  updated: number;
  failed: number;
  groups_created: number;
  details: ImportDetail[];
};

type FeedWithRelations = Feed & {
  group: UserFeedGroup | null;
  crawler_strategy: FeedCrawlerStrategy | null;
};

function isValidUrl(string: string): boolean {
  try {
    new URL(string);
    return true;
  } catch {
    return false;
  }
}

/** 指纹比对时去掉 Cookie，避免无 secrets 导出后再导入变成「新源」 */
export function stripSecretsFromRules(rules: unknown): object | null {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return null;
  const clone = { ...(rules as Record<string, unknown>) };
  delete clone.authCookie;
  delete clone.auth_cookie;
  return clone;
}

function cloneSelectorRules(rules: unknown, includeSecrets: boolean): object | null {
  const stripped = stripSecretsFromRules(rules);
  if (!stripped) return null;
  if (includeSecrets && rules && typeof rules === 'object' && !Array.isArray(rules)) {
    const raw = rules as Record<string, unknown>;
    if (typeof raw.authCookie === 'string' && raw.authCookie.trim()) {
      return { ...stripped, authCookie: String(raw.authCookie).trim().slice(0, 8000) };
    }
  }
  return stripped;
}

function serializeStrategy(strategy: FeedCrawlerStrategy | null): CrawlerStrategyExport | null {
  if (!strategy) return null;
  return {
    strategy_mode: strategy.strategy_mode || 'auto',
    min_interval: strategy.min_interval ?? 1800,
    max_interval: strategy.max_interval ?? 86400,
    failure_threshold: strategy.failure_threshold ?? 3,
    auto_disable_enabled: strategy.auto_disable_enabled === true,
    note: strategy.note ?? null,
  };
}

function serializeFeed(feed: FeedWithRelations, includeSecrets: boolean): FeedRuleExport | null {
  const url = String(feed.url || '').trim();
  if (!url) return null;

  const sourceType = feed.source_type === 'parsed' ? 'parsed' : 'native';
  const selectorRules =
    sourceType === 'parsed' ? cloneSelectorRules(feed.selector_rules, includeSecrets) : null;

  return {
    kind: sourceType,
    title: feed.title || url,
    description: feed.description || '',
    url,
    feed_type: feed.feed_type || 'rss',
    source_type: sourceType,
    update_interval: feed.update_interval ?? 1800,
    use_proxy: feed.use_proxy === true,
    needs_translation: feed.needs_translation === true,
    favicon_url: feed.favicon_url || null,
    favicon_custom_text: feed.favicon_custom_text || null,
    favicon_custom_bg: feed.favicon_custom_bg || null,
    is_active: feed.is_active !== false,
    group_name: feed.group?.name || null,
    sort_order: feed.sort_order ?? 0,
    selector_rules: selectorRules,
    auth_cookie:
      includeSecrets && feed.auth_cookie
        ? String(feed.auth_cookie).slice(0, 8000)
        : null,
    crawler_strategy: serializeStrategy(feed.crawler_strategy),
  };
}

export async function exportFeedRules(options: {
  userId: number;
  includeSecrets?: boolean;
  feedIds?: number[];
  sourceTypes?: Array<'native' | 'parsed'>;
}): Promise<FeedRulesBundle> {
  const includeSecrets = options.includeSecrets === true;
  const where: Record<string, unknown> = { user_id: options.userId };

  if (options.feedIds && options.feedIds.length > 0) {
    where.id = { in: options.feedIds };
  }
  if (options.sourceTypes && options.sourceTypes.length > 0) {
    where.source_type = { in: options.sourceTypes };
  }

  const feeds = (await prisma.feed.findMany({
    where,
    include: {
      group: true,
      crawler_strategy: true,
    },
    orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
  })) as FeedWithRelations[];

  const serialized: FeedRuleExport[] = [];
  const groupMap = new Map<string, { name: string; icon: string | null }>();

  for (const feed of feeds) {
    const item = serializeFeed(feed, includeSecrets);
    if (!item) continue;
    serialized.push(item);
    if (feed.group?.name) {
      groupMap.set(feed.group.name, {
        name: feed.group.name,
        icon: feed.group.icon || null,
      });
    }
  }

  return {
    format: FEED_RULES_FORMAT,
    version: FEED_RULES_VERSION,
    exported_at: new Date().toISOString(),
    app: 'feedgen',
    include_secrets: includeSecrets,
    groups: [...groupMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    feeds: serialized,
  };
}

export function validateFeedRulesBundle(body: unknown): { ok: true; bundle: FeedRulesBundle } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: '规则包须为 JSON 对象' };
  }
  const raw = body as Record<string, unknown>;
  if (raw.format !== FEED_RULES_FORMAT) {
    return { ok: false, error: `format 须为 ${FEED_RULES_FORMAT}` };
  }
  if (Number(raw.version) !== FEED_RULES_VERSION) {
    return { ok: false, error: `仅支持 version ${FEED_RULES_VERSION}` };
  }
  if (!Array.isArray(raw.feeds)) {
    return { ok: false, error: 'feeds 须为数组' };
  }
  if (raw.groups !== undefined && !Array.isArray(raw.groups)) {
    return { ok: false, error: 'groups 须为数组' };
  }
  return { ok: true, bundle: raw as unknown as FeedRulesBundle };
}

function clampInterval(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.floor(n)));
}

function isLegacyCheerioRules(rules: object): boolean {
  const r = rules as Record<string, unknown>;
  return typeof r.item === 'string' && typeof r.title === 'string' && typeof r.link === 'string';
}

function isVisualRules(rules: object): boolean {
  const r = rules as Record<string, unknown>;
  return typeof r.listSelector === 'string' && r.listSelector.trim().length > 0;
}

function validateSelectorRules(sourceType: string, rules: unknown): string | null {
  if (sourceType !== 'parsed') return null;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
    return 'parsed 源须提供 selector_rules 对象';
  }
  if (!isVisualRules(rules) && !isLegacyCheerioRules(rules)) {
    return 'selector_rules 须为 visual（listSelector）或 legacy（item/title/link）格式';
  }
  return null;
}

async function nextFeedSortOrder(userId: number): Promise<number> {
  const agg = await prisma.feed.aggregate({
    where: { user_id: userId },
    _max: { sort_order: true },
  });
  return (agg._max.sort_order ?? -1) + 1;
}

async function upsertGroupsForImport(
  userId: number,
  bundle: FeedRulesBundle
): Promise<{ groupIdByName: Map<string, number>; groupsCreated: number }> {
  const groupIdByName = new Map<string, number>();
  let groupsCreated = 0;

  const names = new Set<string>();
  for (const g of bundle.groups || []) {
    const name = String(g?.name || '').trim().slice(0, 100);
    if (name) names.add(name);
  }
  for (const f of bundle.feeds || []) {
    const name = String(f?.group_name || '').trim().slice(0, 100);
    if (name) names.add(name);
  }

  const existing = await prisma.userFeedGroup.findMany({
    where: { user_id: userId },
    select: { id: true, name: true, icon: true },
  });
  for (const g of existing) {
    groupIdByName.set(g.name, g.id);
  }

  const iconByName = new Map<string, string | null>();
  for (const g of bundle.groups || []) {
    const name = String(g?.name || '').trim().slice(0, 100);
    if (!name) continue;
    const icon = g?.icon == null || g.icon === '' ? null : String(g.icon).slice(0, 50);
    iconByName.set(name, icon);
  }

  for (const name of names) {
    if (groupIdByName.has(name)) {
      const icon = iconByName.get(name);
      if (icon !== undefined) {
        await prisma.userFeedGroup.update({
          where: { id: groupIdByName.get(name)! },
          data: { icon, updated_at: new Date() },
        });
      }
      continue;
    }
    const created = await prisma.userFeedGroup.create({
      data: {
        user_id: userId,
        name,
        icon: iconByName.get(name) ?? null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    groupIdByName.set(name, created.id);
    groupsCreated += 1;
  }

  return { groupIdByName, groupsCreated };
}

function fingerprintForMatch(url: string, sourceType: string, selectorRules: unknown): string {
  return buildSourceFingerprint({
    url,
    source_type: sourceType,
    selector_rules: sourceType === 'parsed' ? stripSecretsFromRules(selectorRules) : null,
  });
}

async function applyCrawlerStrategy(
  feedId: number,
  strategy: CrawlerStrategyExport | null | undefined,
  updateInterval?: number
): Promise<void> {
  const feedUpdate: Record<string, unknown> = { updated_at: new Date() };
  if (updateInterval !== undefined) {
    feedUpdate.update_interval = clampInterval(updateInterval, 1800);
  }

  if (!strategy) {
    if (updateInterval !== undefined) {
      await prisma.feed.update({ where: { id: feedId }, data: feedUpdate });
    }
    return;
  }

  const mode = String(strategy.strategy_mode || 'auto').trim();
  if (!STRATEGY_MODES.has(mode)) {
    throw new Error('strategy_mode 仅支持 auto/manual/cooldown/disabled');
  }
  if (mode === 'disabled') {
    feedUpdate.is_active = false;
  }

  const minInterval = clampInterval(Number(strategy.min_interval), 1800);
  const maxInterval = clampInterval(Number(strategy.max_interval), 86400);
  let failureThreshold = Number(strategy.failure_threshold);
  if (!Number.isInteger(failureThreshold) || failureThreshold < 1 || failureThreshold > 20) {
    failureThreshold = 3;
  }

  const strategyData = {
    strategy_mode: mode,
    min_interval: minInterval,
    max_interval: Math.max(maxInterval, minInterval),
    failure_threshold: failureThreshold,
    auto_disable_enabled: strategy.auto_disable_enabled === true,
    note: strategy.note == null ? null : String(strategy.note).slice(0, 2000),
    updated_at: new Date(),
  };

  await prisma.$transaction([
    prisma.feed.update({ where: { id: feedId }, data: feedUpdate }),
    prisma.feedCrawlerStrategy.upsert({
      where: { feed_id: feedId },
      create: {
        feed_id: feedId,
        ...strategyData,
      },
      update: strategyData,
    }),
  ]);
}

function pickAuthCookie(
  item: FeedRuleExport,
  includeSecrets: boolean
): string | null {
  if (!includeSecrets) return null;
  const fromField = item.auth_cookie != null ? String(item.auth_cookie).trim() : '';
  if (fromField) return fromField.slice(0, 8000);
  const rules = item.selector_rules as Record<string, unknown> | null;
  const fromRules = rules && typeof rules.authCookie === 'string' ? rules.authCookie.trim() : '';
  return fromRules ? fromRules.slice(0, 8000) : null;
}

function prepareSelectorRulesForStore(
  item: FeedRuleExport,
  includeSecrets: boolean
): object | null {
  if (item.source_type !== 'parsed') return null;
  const rules = cloneSelectorRules(item.selector_rules, includeSecrets);
  return rules;
}

export async function importFeedRules(options: {
  userId: number;
  bundle: FeedRulesBundle;
  includeSecrets?: boolean;
}): Promise<ImportReport> {
  const includeSecrets = options.includeSecrets === true;
  const report: ImportReport = {
    created: 0,
    updated: 0,
    failed: 0,
    groups_created: 0,
    details: [],
  };

  const { groupIdByName, groupsCreated } = await upsertGroupsForImport(options.userId, options.bundle);
  report.groups_created = groupsCreated;

  const existingFeeds = await prisma.feed.findMany({
    where: { user_id: options.userId },
    select: {
      id: true,
      url: true,
      source_type: true,
      selector_rules: true,
    },
  });

  const fingerprintToFeedId = new Map<string, number>();
  for (const feed of existingFeeds) {
    const url = String(feed.url || '').trim();
    if (!url) continue;
    const fp = fingerprintForMatch(url, feed.source_type, feed.selector_rules);
    // 若冲突保留较小 id（更早创建）
    if (!fingerprintToFeedId.has(fp)) {
      fingerprintToFeedId.set(fp, feed.id);
    }
  }

  for (const rawItem of options.bundle.feeds || []) {
    const url = String(rawItem?.url || '').trim();
    try {
      if (!url || !isValidUrl(url)) {
        report.failed += 1;
        report.details.push({ url: url || '(空)', status: 'failed', reason: 'url 无效' });
        continue;
      }

      const sourceType = rawItem.source_type === 'parsed' || rawItem.kind === 'parsed' ? 'parsed' : 'native';
      const selectorErr = validateSelectorRules(sourceType, rawItem.selector_rules);
      if (selectorErr) {
        report.failed += 1;
        report.details.push({ url, status: 'failed', reason: selectorErr });
        continue;
      }

      const title = String(rawItem.title || '').trim().slice(0, 255) || new URL(url).hostname;
      const description = rawItem.description == null ? '' : String(rawItem.description);
      const feedType = String(rawItem.feed_type || 'rss').slice(0, 50);
      const updateInterval = clampInterval(Number(rawItem.update_interval), 1800);
      const useProxy = rawItem.use_proxy === true;
      const needsTranslation = rawItem.needs_translation === true;
      const isActive = rawItem.is_active !== false;
      let sortOrder = Number(rawItem.sort_order);
      if (!Number.isFinite(sortOrder) || sortOrder < 0 || sortOrder > 999999) {
        sortOrder = await nextFeedSortOrder(options.userId);
      }

      let faviconUrl: string | null = null;
      if (rawItem.favicon_url != null && String(rawItem.favicon_url).trim()) {
        const fav = String(rawItem.favicon_url).trim();
        if (!isValidUrl(fav)) {
          report.failed += 1;
          report.details.push({ url, status: 'failed', reason: 'favicon_url 无效' });
          continue;
        }
        faviconUrl = fav.slice(0, 2000);
      }

      let faviconBg: string | null = null;
      if (rawItem.favicon_custom_bg != null && String(rawItem.favicon_custom_bg).trim()) {
        const color = String(rawItem.favicon_custom_bg).trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
          report.failed += 1;
          report.details.push({ url, status: 'failed', reason: 'favicon_custom_bg 须为 #RRGGBB' });
          continue;
        }
        faviconBg = color;
      }

      const faviconText =
        rawItem.favicon_custom_text == null || !String(rawItem.favicon_custom_text).trim()
          ? null
          : String(rawItem.favicon_custom_text).trim().slice(0, 12);

      const groupName = rawItem.group_name == null ? '' : String(rawItem.group_name).trim();
      const groupId = groupName && groupIdByName.has(groupName) ? groupIdByName.get(groupName)! : null;

      const storedRules = prepareSelectorRulesForStore(
        { ...rawItem, source_type: sourceType, url, title } as FeedRuleExport,
        includeSecrets
      );
      const authCookie = pickAuthCookie(rawItem as FeedRuleExport, includeSecrets);

      const fp = fingerprintForMatch(url, sourceType, storedRules ?? rawItem.selector_rules);
      const existingId = fingerprintToFeedId.get(fp);

      let note: string | undefined;
      try {
        const check = await checkSource({
          url,
          source_type: sourceType,
          selector_rules: storedRules,
          userId: options.userId,
        });
        if (check?.match === 'public') {
          note = 'public_source_also_exists';
        }
      } catch {
        // 公开目录检测失败不阻断导入
      }

      if (existingId) {
        const updateData: Record<string, unknown> = {
          title,
          description,
          feed_type: feedType,
          update_interval: updateInterval,
          use_proxy: useProxy,
          needs_translation: needsTranslation,
          is_active: isActive,
          sort_order: Math.floor(sortOrder),
          group_id: groupId,
          favicon_url: faviconUrl,
          favicon_custom_text: faviconText,
          favicon_custom_bg: faviconBg,
          updated_at: new Date(),
        };
        if (sourceType === 'parsed') {
          updateData.selector_rules = storedRules;
        }
        if (includeSecrets) {
          updateData.auth_cookie = authCookie;
        }

        await prisma.feed.update({
          where: { id: existingId },
          data: updateData,
        });
        await applyCrawlerStrategy(existingId, rawItem.crawler_strategy, updateInterval);

        report.updated += 1;
        report.details.push({
          url,
          status: 'updated',
          feed_id: existingId,
          ...(note ? { note } : {}),
        });
      } else {
        const created = await prisma.feed.create({
          data: {
            user_id: options.userId,
            title,
            description,
            url,
            feed_type: feedType,
            source_type: sourceType,
            group_id: groupId,
            favicon_url: faviconUrl,
            favicon_custom_text: faviconText,
            favicon_custom_bg: faviconBg,
            update_interval: updateInterval,
            use_proxy: useProxy,
            needs_translation: needsTranslation,
            is_active: isActive,
            sort_order: Math.floor(sortOrder),
            selector_rules: sourceType === 'parsed' ? (storedRules as object) : undefined,
            auth_cookie: includeSecrets ? authCookie : null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        });

        await applyCrawlerStrategy(created.id, rawItem.crawler_strategy, updateInterval);
        fingerprintToFeedId.set(fp, created.id);

        report.created += 1;
        report.details.push({
          url,
          status: 'created',
          feed_id: created.id,
          ...(note ? { note } : {}),
        });
      }
    } catch (err: any) {
      report.failed += 1;
      report.details.push({
        url: url || '(空)',
        status: 'failed',
        reason: err?.message || '导入失败',
      });
    }
  }

  return report;
}

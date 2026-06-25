import { Prisma } from '@prisma/client';
import { prisma } from '../server';
import {
  buildSelectorFingerprint,
  buildSourceFingerprint,
  normalizeUrl,
} from './sourceFingerprint';

const SUPER_PLAN_ID = 3;

export type CheckSourceResult = {
  match: 'public' | 'pending' | 'none';
  public_feed: ReturnType<typeof formatPublicFeedSummary> | null;
  pending_request: { id: number; submitted_at: Date } | null;
  already_subscribed: boolean;
};

export function formatContributor(user: {
  id: number;
  username: string;
} | null | undefined) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    display_name: user.username,
  };
}

export function formatPublicFeedSummary(
  feed: {
    id: number;
    title: string;
    description: string | null;
    url: string;
    favicon_url: string | null;
    source_type: string;
    verified: boolean;
    requires_auth: boolean;
    subscriber_count: number;
    last_fetched_at: Date | null;
    tags: Prisma.JsonValue;
    status: string;
    contributor_user_id: number | null;
    contributor?: { id: number; username: string } | null;
  },
  extra?: { already_subscribed?: boolean }
) {
  return {
    id: feed.id,
    title: feed.title,
    description: feed.description,
    url: feed.url,
    favicon_url: feed.favicon_url,
    source_type: feed.source_type,
    verified: feed.verified,
    requires_auth: feed.requires_auth,
    subscriber_count: feed.subscriber_count,
    last_fetched_at: feed.last_fetched_at,
    tags: Array.isArray(feed.tags) ? feed.tags : [],
    status: feed.status,
    contributor: feed.contributor_user_id
      ? formatContributor(feed.contributor ?? null)
      : null,
    contributor_label: feed.contributor_user_id ? undefined : '平台维护',
    already_subscribed: extra?.already_subscribed ?? false,
  };
}

export async function getOptionalUserId(req: any): Promise<number | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const decoded: any = await req.jwtVerify();
    return decoded?.userId ?? null;
  } catch {
    return null;
  }
}

export async function isSuperMember(userId: number): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { current_plan_id: true },
  });
  return user?.current_plan_id === SUPER_PLAN_ID;
}

export async function checkSource(input: {
  url: string;
  source_type?: string;
  selector_rules?: object | null;
  userId?: number | null;
}): Promise<CheckSourceResult> {
  const sourceType = input.source_type === 'parsed' ? 'parsed' : 'native';
  const fingerprint = buildSourceFingerprint({
    url: input.url,
    source_type: sourceType,
    selector_rules: input.selector_rules ?? null,
  });

  const publicFeed = await prisma.publicFeed.findFirst({
    where: {
      source_fingerprint: fingerprint,
      status: 'approved',
    },
    include: {
      contributor: { select: { id: true, username: true } },
    },
  });

  if (publicFeed) {
    let alreadySubscribed = false;
    if (input.userId) {
      const sub = await prisma.userFeedSubscription.findFirst({
        where: {
          user_id: input.userId,
          public_feed_id: publicFeed.id,
          is_active: true,
        },
      });
      alreadySubscribed = !!sub;
    }
    return {
      match: 'public',
      public_feed: formatPublicFeedSummary(publicFeed, { already_subscribed: alreadySubscribed }),
      pending_request: null,
      already_subscribed: alreadySubscribed,
    };
  }

  const pendingRequests = await prisma.publicFeedShareRequest.findMany({
    where: { status: 'pending' },
    include: {
      private_feed: { select: { url: true, source_type: true, selector_rules: true } },
    },
    orderBy: { submitted_at: 'desc' },
    take: 200,
  });

  for (const pendingRequest of pendingRequests) {
    if (!pendingRequest.private_feed?.url) continue;
    const pendingFp = buildSourceFingerprint({
      url: pendingRequest.private_feed.url,
      source_type: pendingRequest.private_feed.source_type,
      selector_rules: pendingRequest.private_feed.selector_rules as object,
    });
    if (pendingFp === fingerprint) {
      return {
        match: 'pending',
        public_feed: null,
        pending_request: {
          id: pendingRequest.id,
          submitted_at: pendingRequest.submitted_at,
        },
        already_subscribed: false,
      };
    }
  }

  return {
    match: 'none',
    public_feed: null,
    pending_request: null,
    already_subscribed: false,
  };
}

export async function assertCanCreatePrivateFeed(
  userId: number,
  input: {
    url: string;
    source_type?: string;
    selector_rules?: object | null;
    force_private?: boolean;
  }
): Promise<{ blocked: boolean; check: CheckSourceResult }> {
  const check = await checkSource({
    url: input.url,
    ...(input.source_type ? { source_type: input.source_type } : {}),
    ...(input.selector_rules !== undefined ? { selector_rules: input.selector_rules } : {}),
    userId,
  });

  if (check.match !== 'public') {
    return { blocked: false, check };
  }

  if (input.force_private === true && (await isSuperMember(userId))) {
    return { blocked: false, check };
  }

  return { blocked: true, check };
}

export async function assertCanCreatePublicSubscription(userId: number): Promise<void> {
  const rows = await prisma.$queryRaw<{ can_create: boolean }[]>`
    SELECT public.can_create_public_subscription(${userId}) AS can_create
  `;
  if (!rows[0]?.can_create) {
    throw Object.assign(new Error('公开源订阅数量已达上限'), { code: 'PUBLIC_SUB_LIMIT' });
  }
}

export async function nextPublicSubscriptionSortOrder(userId: number): Promise<number> {
  const agg = await prisma.userFeedSubscription.aggregate({
    where: { user_id: userId },
    _max: { sort_order: true },
  });
  return (agg._max.sort_order ?? -1) + 1;
}

export async function createPublicSubscription(input: {
  userId: number;
  public_feed_id: number;
  group_id?: number | null;
  custom_title?: string | null;
  needs_translation?: boolean;
}) {
  await assertCanCreatePublicSubscription(input.userId);

  const publicFeed = await prisma.publicFeed.findFirst({
    where: { id: input.public_feed_id, status: 'approved' },
  });
  if (!publicFeed) {
    throw Object.assign(new Error('公开源不存在或不可用'), { code: 'NOT_FOUND' });
  }

  if (input.group_id != null) {
    const group = await prisma.userFeedGroup.findFirst({
      where: { id: input.group_id, user_id: input.userId },
    });
    if (!group) {
      throw Object.assign(new Error('分组不存在'), { code: 'GROUP_NOT_FOUND' });
    }
  }

  const existing = await prisma.userFeedSubscription.findFirst({
    where: {
      user_id: input.userId,
      public_feed_id: input.public_feed_id,
    },
  });

  if (existing) {
    if (!existing.is_active) {
      const updated = await prisma.$transaction(async (tx: any) => {
        const sub = await tx.userFeedSubscription.update({
          where: { id: existing.id },
          data: {
            is_active: true,
            group_id: input.group_id ?? existing.group_id,
            custom_title: input.custom_title ?? existing.custom_title,
            needs_translation: input.needs_translation ?? existing.needs_translation,
            updated_at: new Date(),
          },
          include: { public_feed: { include: { contributor: { select: { id: true, username: true } } } } },
        });
        await tx.publicFeed.update({
          where: { id: input.public_feed_id },
          data: { subscriber_count: { increment: 1 } },
        });
        return sub;
      });
      await maybeRewardContributor(input.public_feed_id);
      return updated;
    }
    throw Object.assign(new Error('已订阅该公开源'), { code: 'ALREADY_SUBSCRIBED' });
  }

  const sortOrder = await nextPublicSubscriptionSortOrder(input.userId);
  const subscription = await prisma.$transaction(async (tx: any) => {
    const sub = await tx.userFeedSubscription.create({
      data: {
        user_id: input.userId,
        public_feed_id: input.public_feed_id,
        group_id: input.group_id ?? null,
        custom_title: input.custom_title?.trim() || null,
        sort_order: sortOrder,
        needs_translation: input.needs_translation === true,
        is_active: true,
      },
      include: { public_feed: { include: { contributor: { select: { id: true, username: true } } } } },
    });
    await tx.publicFeed.update({
      where: { id: input.public_feed_id },
      data: { subscriber_count: { increment: 1 } },
    });
    return sub;
  });

  await maybeRewardContributor(input.public_feed_id);
  return subscription;
}

export async function cancelPublicSubscription(userId: number, subscriptionId: number) {
  const sub = await prisma.userFeedSubscription.findFirst({
    where: { id: subscriptionId, user_id: userId },
  });
  if (!sub) {
    throw Object.assign(new Error('订阅不存在'), { code: 'NOT_FOUND' });
  }
  if (!sub.is_active) return sub;

  return prisma.$transaction(async (tx: any) => {
    const updated = await tx.userFeedSubscription.update({
      where: { id: sub.id },
      data: { is_active: false, updated_at: new Date() },
      include: { public_feed: true },
    });
    await tx.publicFeed.update({
      where: { id: sub.public_feed_id },
      data: { subscriber_count: { decrement: 1 } },
    });
    return updated;
  });
}

export async function maybeRewardContributor(publicFeedId: number): Promise<void> {
  const feed = await prisma.publicFeed.findUnique({
    where: { id: publicFeedId },
    select: { contributor_user_id: true, subscriber_count: true },
  });
  if (!feed?.contributor_user_id) return;
  if (feed.subscriber_count <= 0 || feed.subscriber_count % 10 !== 0) return;

  const user = await prisma.user.findUnique({
    where: { id: feed.contributor_user_id },
    select: { plan_end_date: true, current_plan_id: true },
  });
  if (!user) return;

  const base = user.plan_end_date ? new Date(user.plan_end_date) : new Date();
  const now = new Date();
  const start = base > now ? base : now;
  const extended = new Date(start);
  extended.setDate(extended.getDate() + 7);

  await prisma.user.update({
    where: { id: feed.contributor_user_id },
    data: {
      current_plan_id: user.current_plan_id && user.current_plan_id > 1 ? user.current_plan_id : 2,
      plan_end_date: extended,
      updated_at: new Date(),
    },
  });
}

export function buildPublicFeedFromPrivateFeed(feed: {
  title: string;
  description: string | null;
  url: string | null;
  favicon_url: string | null;
  source_type: string;
  selector_rules: Prisma.JsonValue;
  feed_type: string | null;
  update_interval: number | null;
  use_proxy: boolean;
  anti_bot_status: string;
  auth_cookie: string | null;
}) {
  const url = String(feed.url || '').trim();
  const sourceType = feed.source_type === 'parsed' ? 'parsed' : 'native';
  const selectorRules = feed.selector_rules as object | null;
  const sourceFingerprint = buildSourceFingerprint({
    url,
    source_type: sourceType,
    selector_rules: selectorRules,
  });
  const selectorFingerprint = buildSelectorFingerprint(selectorRules);
  const { auth_cookie: _auth, ...safeSelector } = (selectorRules || {}) as Record<string, unknown>;
  if ('authCookie' in safeSelector) delete safeSelector.authCookie;

  return {
    title: feed.title,
    description: feed.description,
    url,
    url_normalized: normalizeUrl(url),
    source_type: sourceType,
    selector_rules: sourceType === 'parsed' ? safeSelector : Prisma.JsonNull,
    selector_fingerprint: selectorFingerprint,
    source_fingerprint: sourceFingerprint,
    feed_type: feed.feed_type || 'rss',
    favicon_url: feed.favicon_url,
    update_interval: feed.update_interval ?? 1800,
    use_proxy: feed.use_proxy,
    anti_bot_status: feed.anti_bot_status,
    requires_auth: Boolean(feed.auth_cookie?.trim()),
    status: 'approved',
    is_active: true,
  };
}

const SHARE_REQUEST_MONTHLY_LIMIT = 5;

export async function validateShareRequestEligibility(feedId: number, userId: number) {
  const feed = await prisma.feed.findFirst({
    where: { id: feedId, user_id: userId, public_feed_id: null },
  });
  if (!feed) {
    throw Object.assign(new Error('Feed 不存在或不可分享'), { code: 'NOT_FOUND' });
  }

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthlyCount = await prisma.publicFeedShareRequest.count({
    where: {
      user_id: userId,
      submitted_at: { gte: monthStart },
    },
  });
  if (monthlyCount >= SHARE_REQUEST_MONTHLY_LIMIT) {
    throw Object.assign(new Error('本月分享申请次数已达上限'), { code: 'MONTHLY_LIMIT' });
  }

  const existingPending = await prisma.publicFeedShareRequest.findFirst({
    where: { private_feed_id: feedId, status: 'pending' },
  });
  if (existingPending) {
    throw Object.assign(new Error('该 Feed 已有待审核申请'), { code: 'PENDING_EXISTS' });
  }

  const feedAgeDays =
    (Date.now() - new Date(feed.created_at || new Date()).getTime()) / (1000 * 60 * 60 * 24);
  const successCount = await prisma.crawlerTaskHistory.count({
    where: { feed_id: feedId, status: 'success' },
  });
  if (feedAgeDays < 7 && successCount < 10) {
    throw Object.assign(new Error('Feed 需稳定运行至少 7 天或成功抓取 10 次'), { code: 'NOT_STABLE' });
  }

  const since = new Date();
  since.setDate(since.getDate() - 30);
  const recentTasks = await prisma.crawlerTaskHistory.findMany({
    where: { feed_id: feedId, started_at: { gte: since } },
    select: { status: true },
  });
  if (recentTasks.length > 0) {
    const successRate =
      recentTasks.filter((t: { status: string }) => t.status === 'success').length / recentTasks.length;
    if (successRate < 0.8) {
      throw Object.assign(new Error('近 30 天抓取成功率需不低于 80%'), { code: 'LOW_SUCCESS_RATE' });
    }
  }

  return feed;
}

export async function createShareRequest(feedId: number, userId: number) {
  await validateShareRequestEligibility(feedId, userId);
  return prisma.publicFeedShareRequest.create({
    data: {
      user_id: userId,
      private_feed_id: feedId,
      status: 'pending',
    },
  });
}

export async function approveShareRequest(
  requestId: number,
  adminUserId: number,
  options?: { title?: string; tags?: string[] }
) {
  const request = await prisma.publicFeedShareRequest.findFirst({
    where: { id: requestId, status: 'pending' },
    include: { private_feed: true },
  });
  if (!request?.private_feed) {
    throw Object.assign(new Error('申请不存在或已处理'), { code: 'NOT_FOUND' });
  }

  const privateFeed = request.private_feed;
  const feedData = buildPublicFeedFromPrivateFeed(privateFeed);
  const tags = (options?.tags || []).slice(0, 3);

  return prisma.$transaction(async (tx: any) => {
    let publicFeed = await tx.publicFeed.findUnique({
      where: { source_fingerprint: feedData.source_fingerprint },
    });

    const isMerge = !!publicFeed;
    if (!publicFeed) {
      publicFeed = await tx.publicFeed.create({
        data: {
          ...feedData,
          title: options?.title?.trim() || feedData.title,
          contributor_user_id: request.user_id,
          tags: tags.length ? tags : Prisma.JsonNull,
          subscriber_count: 0,
        },
      });

      await tx.article.updateMany({
        where: { feed_id: privateFeed.id },
        data: { public_feed_id: publicFeed.id, feed_id: null },
      });
    }

    let subscription = await tx.userFeedSubscription.findFirst({
      where: { user_id: request.user_id, public_feed_id: publicFeed.id },
    });
    if (!subscription) {
      const sortOrder = await tx.userFeedSubscription.aggregate({
        where: { user_id: request.user_id },
        _max: { sort_order: true },
      });
      subscription = await tx.userFeedSubscription.create({
        data: {
          user_id: request.user_id,
          public_feed_id: publicFeed.id,
          group_id: privateFeed.group_id,
          custom_title: privateFeed.title,
          sort_order: (sortOrder._max.sort_order ?? -1) + 1,
          needs_translation: privateFeed.needs_translation,
          is_active: true,
        },
      });
      await tx.publicFeed.update({
        where: { id: publicFeed.id },
        data: { subscriber_count: { increment: 1 } },
      });
    } else if (!subscription.is_active) {
      subscription = await tx.userFeedSubscription.update({
        where: { id: subscription.id },
        data: { is_active: true, updated_at: new Date() },
      });
      await tx.publicFeed.update({
        where: { id: publicFeed.id },
        data: { subscriber_count: { increment: 1 } },
      });
    }

    await tx.feed.update({
      where: { id: privateFeed.id },
      data: {
        is_active: false,
        public_feed_id: publicFeed.id,
        updated_at: new Date(),
      },
    });

    await tx.publicFeedShareRequest.update({
      where: { id: request.id },
      data: {
        status: 'approved',
        reviewed_by: adminUserId,
        reviewed_at: new Date(),
      },
    });

    return { publicFeed, subscription, merged: isMerge };
  });
}

export async function rejectShareRequest(
  requestId: number,
  adminUserId: number,
  reason?: string
) {
  const request = await prisma.publicFeedShareRequest.findFirst({
    where: { id: requestId, status: 'pending' },
  });
  if (!request) {
    throw Object.assign(new Error('申请不存在或已处理'), { code: 'NOT_FOUND' });
  }
  return prisma.publicFeedShareRequest.update({
    where: { id: request.id },
    data: {
      status: 'rejected',
      reviewed_by: adminUserId,
      reviewed_at: new Date(),
      reject_reason: reason?.trim() || null,
    },
  });
}

export async function getUserContributions(userId: number) {
  const feeds = await prisma.publicFeed.findMany({
    where: { contributor_user_id: userId },
    select: { id: true, subscriber_count: true },
  });
  const totalSubscribers = feeds.reduce((sum: number, f: { subscriber_count: number }) => sum + f.subscriber_count, 0);
  const pendingRewards = feeds.filter((f: { subscriber_count: number }) => f.subscriber_count > 0 && f.subscriber_count % 10 === 0).length;
  return {
    contributed_count: feeds.length,
    total_subscribers: totalSubscribers,
    pending_rewards: pendingRewards,
    feeds: feeds.map((f: { id: number; subscriber_count: number }) => ({
      public_feed_id: f.id,
      subscriber_count: f.subscriber_count,
    })),
  };
}

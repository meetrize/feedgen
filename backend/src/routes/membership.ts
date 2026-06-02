import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../server';

const DEFAULT_MEMBERSHIP_PLANS = [
  {
    id: 1,
    key: 'free',
    name: '免费版',
    price_label: '免费',
    price_suffix: '/年',
    description: '适合轻度使用，个人日常阅读。',
    max_feeds: 30,
    min_fetch_interval: 1800,
    history_days: 30,
    storage_mb: 500,
    highlight: false,
  },
  {
    id: 2,
    key: 'standard',
    name: '普通会员',
    price_label: '¥98',
    price_suffix: '/年',
    description: '适合深度用户，提升信息覆盖范围。',
    max_feeds: 200,
    min_fetch_interval: 600,
    history_days: 180,
    storage_mb: 5120,
    highlight: true,
  },
  {
    id: 3,
    key: 'pro',
    name: '超级会员',
    price_label: '¥580',
    price_suffix: '/年',
    description: '适合团队/重度监控，高频抓取与长期沉淀。',
    max_feeds: 1000,
    min_fetch_interval: 60,
    history_days: 1095,
    storage_mb: 51200,
    highlight: false,
  },
];

const PLAN_FIELDS = [
  'name',
  'price_label',
  'price_suffix',
  'description',
  'max_feeds',
  'min_fetch_interval',
  'history_days',
  'storage_mb',
  'highlight',
  'sort_order',
] as const;

function normalizePlans(rows: any[] | undefined) {
  const map = new Map<number, any>();
  for (const row of rows || []) map.set(row.id, row);
  return DEFAULT_MEMBERSHIP_PLANS.map((plan) => ({
    ...plan,
    ...(map.get(plan.id) || {}),
  }));
}

function normalizePlanInput(plan: any, fallback: any) {
  return {
    id: fallback.id,
    key: fallback.key,
    name: typeof plan?.name === 'string' ? plan.name.trim().slice(0, 100) : fallback.name,
    price_label: typeof plan?.price_label === 'string' ? plan.price_label.trim().slice(0, 32) : fallback.price_label,
    price_suffix: typeof plan?.price_suffix === 'string' ? plan.price_suffix.trim().slice(0, 12) : fallback.price_suffix,
    description: typeof plan?.description === 'string' ? plan.description.trim().slice(0, 255) : fallback.description,
    max_feeds: Number.isFinite(Number(plan?.max_feeds)) ? Math.max(0, parseInt(String(plan.max_feeds), 10)) : fallback.max_feeds,
    min_fetch_interval: Number.isFinite(Number(plan?.min_fetch_interval)) ? Math.max(0, parseInt(String(plan.min_fetch_interval), 10)) : fallback.min_fetch_interval,
    history_days: Number.isFinite(Number(plan?.history_days)) ? Math.max(0, parseInt(String(plan.history_days), 10)) : fallback.history_days,
    storage_mb: Number.isFinite(Number(plan?.storage_mb)) ? Math.max(0, parseInt(String(plan.storage_mb), 10)) : fallback.storage_mb,
    highlight: !!plan?.highlight,
    sort_order: Number.isFinite(Number(plan?.sort_order)) ? Math.max(0, parseInt(String(plan.sort_order), 10)) : fallback.id,
  };
}

const membershipRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/plans', async () => {
    try {
      const rows = await prisma.membership_plan_configs.findMany({ orderBy: { sort_order: 'asc' } });
      return { plans: normalizePlans(rows) };
    } catch {
      return { plans: DEFAULT_MEMBERSHIP_PLANS };
    }
  });

  fastify.put('/plans', async (req: any, res: any) => {
    try {
      const body = req.body as { plans?: any[] };
      const plans = Array.isArray(body?.plans) ? body.plans : [];
      if (plans.length === 0) {
        return res.status(400).send({ error: '请提供 plans 数组' });
      }
      const normalized = DEFAULT_MEMBERSHIP_PLANS.map((fallback) => {
        const input = plans.find((p) => Number(p?.id) === fallback.id) || {};
        return normalizePlanInput(input, fallback);
      });

      const saved = [] as any[];
      for (const plan of normalized) {
        const data: Record<string, unknown> = {};
        for (const field of PLAN_FIELDS) {
          data[field] = (plan as any)[field];
        }
        const row = await prisma.membership_plan_configs.upsert({
          where: { id: plan.id },
          create: { id: plan.id, ...data },
          update: data,
        });
        saved.push(row);
      }
      return { plans: normalizePlans(saved) };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '保存会员配置失败' });
    }
  });
};

export { membershipRoutes };

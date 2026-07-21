import { FastifyPluginAsync } from 'fastify';

// 从server.ts导入prisma实例
import { prisma } from '../server';

const PLAN_KEY_BY_ID: Record<number, string> = {
  1: 'free',
  2: 'basic',
  3: 'pro',
};

const billingRoutes: FastifyPluginAsync = async (fastify) => {
  // 获取用户的使用情况
  fastify.get('/usage', async (req: any, res: any) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Authentication required' });
      }

      const decoded: any = await req.jwtVerify();
      const userId = decoded.userId;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          current_plan_id: true,
          user_plans: { select: { id: true, name: true, max_feeds: true } },
        },
      });

      if (!user) {
        return res.status(404).send({ error: 'User not found' });
      }

      const planId = user.current_plan_id ?? 1;
      const membership = await prisma.membership_plan_configs.findUnique({
        where: { id: planId },
      });

      const feedCount = await prisma.feed.count({
        where: { user_id: userId, is_active: true },
      });

      const maxFeeds =
        membership?.max_private_feeds ??
        membership?.max_feeds ??
        user.user_plans?.max_feeds ??
        30;
      const planKey = PLAN_KEY_BY_ID[planId] || 'free';

      return {
        usage: {
          userId,
          plan: planKey,
          planId,
          planName: membership?.name || user.user_plans?.name || '免费版',
          feedCount,
          requestCount: 0,
          limits: {
            feeds: maxFeeds,
            requests: 100000,
          },
          canCreateMoreFeeds: maxFeeds <= 0 || feedCount < maxFeeds,
          canMakeMoreRequests: true,
        },
      };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Failed to fetch usage data' });
    }
  });

  // 获取账单记录（当前库无独立账单表时返回空列表）
  fastify.get('/records', async (req: any, res: any) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Authentication required' });
      }

      await req.jwtVerify();
      return { records: [] };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Failed to fetch billing records' });
    }
  });

  // 获取当前账单周期
  fastify.get('/current-cycle', async (req: any, res: any) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Authentication required' });
      }

      const decoded: any = await req.jwtVerify();
      const userId = decoded.userId;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { plan_start_date: true, plan_end_date: true, current_plan_id: true },
      });

      const now = new Date();
      const start = user?.plan_start_date || new Date(now.getFullYear(), now.getMonth(), 1);
      const end = user?.plan_end_date || new Date(now.getFullYear(), now.getMonth() + 1, 0);

      return {
        cycle: {
          userId,
          planId: user?.current_plan_id ?? 1,
          startDate: start,
          endDate: end,
        },
      };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Failed to fetch current cycle' });
    }
  });
};

export { billingRoutes };

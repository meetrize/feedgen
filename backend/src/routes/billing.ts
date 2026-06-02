import { FastifyPluginAsync } from 'fastify';

// 从server.ts导入prisma实例
import { prisma } from '../server';

const billingRoutes: FastifyPluginAsync = async (fastify) => {
  // 获取用户的使用情况
  fastify.get('/usage', async (req: any, res: any) => {
    try {
      // 检查认证
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Authentication required' });
      }

      const token = authHeader.substring(7); // 移除 "Bearer " 前缀
      const decoded: any = await req.jwtVerify();
      const userId = decoded.userId;

      // 获取当前用户的套餐信息
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { plan: true }
      });

      if (!user) {
        return res.status(404).send({ error: 'User not found' });
      }

      // 获取当前月份的使用日志
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

      const usageLogs = await prisma.usageLog.count({
        where: {
          userId,
          timestamp: {
            gte: startOfMonth,
            lte: endOfMonth,
          },
        },
      });

      // 获取用户拥有的feed数量
      const feedCount = await prisma.feed.count({
        where: { userId },
      });

      // 套餐限制
      const plans: Record<string, { feeds: number; requests: number }> = {
        free: { feeds: 3, requests: 1000 },
        basic: { feeds: 10, requests: 10000 },
        pro: { feeds: 50, requests: 100000 },
      };

      const planLimits = plans[user.plan] || plans.free;

      return {
        usage: {
          userId,
          plan: user.plan,
          feedCount,
          requestCount: usageLogs,
          limits: planLimits,
          canCreateMoreFeeds: feedCount < (planLimits?.feeds || 0),
          canMakeMoreRequests: usageLogs < (planLimits?.requests || 0),
        }
      };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Failed to fetch usage data' });
    }
  });

  // 获取账单记录
  fastify.get('/records', async (req: any, res: any) => {
    try {
      // 检查认证
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Authentication required' });
      }

      const token = authHeader.substring(7); // 移除 "Bearer " 前缀
      const decoded: any = await req.jwtVerify();
      const userId = decoded.userId;

      const records = await prisma.billingRecord.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 12, // 最近12条记录
      });

      return { records };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Failed to fetch billing records' });
    }
  });

  // 获取当前账单周期信息
  fastify.get('/current-cycle', async (req: any, res: any) => {
    try {
      // 检查认证
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Authentication required' });
      }

      const token = authHeader.substring(7); // 移除 "Bearer " 前缀
      const decoded: any = await req.jwtVerify();
      const userId = decoded.userId;

      const now = new Date();
      const billingPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      // 获取当前周期的账单记录
      const currentRecord = await prisma.billingRecord.findFirst({
        where: {
          userId,
          billingPeriod,
        },
      });

      // 如果没有当前周期的记录，则创建一个
      if (!currentRecord) {
        const newRecord = await prisma.billingRecord.create({
          data: {
            userId,
            feedCount: await prisma.feed.count({ where: { userId } }),
            requestCount: 0, // 初始为0
            billingPeriod,
          },
        });

        return { record: newRecord };
      }

      return { record: currentRecord };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Failed to fetch current billing cycle' });
    }
  });
};

export { billingRoutes };
import { FastifyPluginAsync } from 'fastify';

import { prisma } from '../server';
import {
  cancelDedupRun,
  DEDUP_JOB_KEY,
  enqueueDedupBackfill,
  enqueueDedupDay,
} from '../services/dedup/dedupQueue';
import { formatLocalDay } from '../services/dedup/dedupService';
import { FULLTEXT_JOB_KEY } from '../services/fulltext/fulltextConfig';
import {
  cancelFulltextRun,
  enqueueFulltextBackfill,
} from '../services/fulltext/fulltextQueue';
import { BUILTIN_JOBS, getBuiltinMeta } from '../services/jobs/jobRegistry';
import { reloadJobSchedules } from '../services/jobs/jobScheduler';

async function verifyAdmin(req: any, res: any) {
  const authHeader = req.headers.authorization as string | undefined;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).send({ error: '需要提供 Authorization: Bearer <登录令牌>' });
  }
  try {
    const decoded: any = await req.jwtVerify();
    const userId = decoded.userId as number | undefined;
    if (userId == null) return res.status(403).send({ error: '无效令牌' });
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { is_admin: true },
    });
    if (!user?.is_admin) return res.status(403).send({ error: '需要管理员账号' });
    req.adminUserId = userId;
  } catch {
    return res.status(401).send({ error: '无效或已过期的登录令牌，请重新登录' });
  }
}

const systemJobsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', verifyAdmin);

  /** 任务列表 + 最近一次 run */
  fastify.get('/', async (_req: any, res: any) => {
    type JobRow = Awaited<ReturnType<typeof prisma.systemJob.findMany>>[number];
    type RunRow = Awaited<ReturnType<typeof prisma.systemJobRun.findMany>>[number];

    const dbJobs = await prisma.systemJob.findMany({ orderBy: { id: 'asc' } });
    const dbByKey = new Map<string, JobRow>();
    for (const j of dbJobs) dbByKey.set(j.key, j);

    const keys = [
      ...new Set([...BUILTIN_JOBS.map((b) => b.key), ...dbJobs.map((j: JobRow) => j.key)]),
    ];

    const latestRuns = await prisma.systemJobRun.findMany({
      where: { job_key: { in: keys } },
      orderBy: { created_at: 'desc' },
      take: 200,
    });
    const latestByKey = new Map<string, RunRow>();
    for (const run of latestRuns) {
      if (!latestByKey.has(run.job_key)) latestByKey.set(run.job_key, run);
    }

    const jobs = keys.map((key) => {
      const meta = getBuiltinMeta(key);
      const db: JobRow | undefined = dbByKey.get(key);
      const latest = latestByKey.get(key) || null;
      return {
        key,
        name: db?.name || meta?.name || key,
        description: db?.description || meta?.description || null,
        cron: db?.cron || meta?.cron || '—',
        enabled: db?.enabled ?? meta?.enabled ?? false,
        queue_name: db?.queue_name || meta?.queue_name || null,
        config: db?.config || meta?.config || {},
        runnable: meta?.runnable ?? Boolean(db),
        readonly: meta?.readonly ?? false,
        latest_run: latest,
      };
    });

    return res.send({ jobs });
  });

  fastify.get('/:key/runs', async (req: any, res: any) => {
    const key = String(req.params.key || '');
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 30));
    const runs = await prisma.systemJobRun.findMany({
      where: { job_key: key },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    return res.send({ runs });
  });

  fastify.patch('/:key', async (req: any, res: any) => {
    const key = String(req.params.key || '');
    const meta = getBuiltinMeta(key);
    if (meta?.readonly) {
      return res.status(400).send({ error: '只读任务不可修改' });
    }
    const body = (req.body || {}) as {
      cron?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
      name?: string;
      description?: string;
    };

    const existing = await prisma.systemJob.findUnique({ where: { key } });
    if (!existing && !meta) {
      return res.status(404).send({ error: '任务不存在' });
    }

    const data: any = { updated_at: new Date() };
    if (typeof body.cron === 'string' && body.cron.trim()) data.cron = body.cron.trim();
    if (typeof body.enabled === 'boolean') data.enabled = body.enabled;
    if (body.config && typeof body.config === 'object') data.config = body.config;
    if (typeof body.name === 'string') data.name = body.name;
    if (typeof body.description === 'string') data.description = body.description;

    const job = existing
      ? await prisma.systemJob.update({ where: { key }, data })
      : await prisma.systemJob.create({
          data: {
            key,
            name: data.name || meta!.name,
            description: data.description || meta!.description,
            cron: data.cron || meta!.cron,
            enabled: data.enabled ?? meta!.enabled,
            queue_name: meta!.queue_name,
            config: data.config || meta!.config,
          },
        });

    await reloadJobSchedules();
    return res.send({ job });
  });

  fastify.post('/:key/trigger', async (req: any, res: any) => {
    const key = String(req.params.key || '');
    const meta = getBuiltinMeta(key);
    if (meta?.readonly || meta?.runnable === false) {
      return res.status(400).send({ error: '该任务不支持手动触发' });
    }
    if (key !== DEDUP_JOB_KEY && key !== FULLTEXT_JOB_KEY) {
      return res.status(400).send({ error: '暂不支持触发此任务' });
    }

    const body = (req.body || {}) as {
      mode?: 'day' | 'backfill';
      run_day?: string;
      from?: string;
      to?: string;
      forceRebuild?: boolean;
    };

    const job = await prisma.systemJob.findUnique({ where: { key } });
    if (!job) return res.status(404).send({ error: '任务未注册' });
    if (!job.enabled) return res.status(400).send({ error: '任务已禁用' });

    const cfg = { ...((job.config || {}) as any) };
    if (body.forceRebuild) cfg.forceRebuild = true;

    if (key === FULLTEXT_JOB_KEY) {
      const run = await prisma.systemJobRun.create({
        data: {
          job_key: key,
          status: 'queued',
          progress: 0,
          progress_text: '手动补扫',
          triggered_by: 'manual',
          stats: body as any,
        },
      });
      const bull = await enqueueFulltextBackfill(run.id);
      if (!bull) {
        return res.status(503).send({ error: '入队失败（Redis 不可用或正文抓取已禁用）', run });
      }
      return res.send({ run, bull_job_id: bull.id });
    }

    const mode = body.mode || 'day';
    const run = await prisma.systemJobRun.create({
      data: {
        job_key: key,
        status: 'queued',
        progress: 0,
        progress_text: '手动触发',
        triggered_by: 'manual',
        stats: body as any,
      },
    });

    if (mode === 'backfill') {
      const from = body.from || formatLocalDay();
      const to = body.to || from;
      const bull = await enqueueDedupBackfill({
        runId: run.id,
        from,
        to,
        config: cfg,
      });
      if (!bull) {
        return res.status(503).send({ error: '入队失败（Redis 不可用或查重已禁用）', run });
      }
      return res.send({ run, bull_job_id: bull.id });
    }

    const run_day = body.run_day || formatLocalDay();
    const bull = await enqueueDedupDay({ runId: run.id, run_day, config: cfg });
    if (!bull) {
      return res.status(503).send({ error: '入队失败（Redis 不可用或查重已禁用）', run });
    }
    return res.send({ run, bull_job_id: bull.id });
  });

  fastify.post('/runs/:id/cancel', async (req: any, res: any) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).send({ error: '无效 run id' });
    }
    const run = await prisma.systemJobRun.findUnique({ where: { id } });
    if (!run) return res.status(404).send({ error: '运行记录不存在' });

    if (run.job_key === DEDUP_JOB_KEY) {
      const ok = await cancelDedupRun(id);
      if (!ok) return res.status(400).send({ error: '当前状态不可取消' });
      const updated = await prisma.systemJobRun.findUnique({ where: { id } });
      return res.send({ run: updated });
    }

    if (run.job_key === FULLTEXT_JOB_KEY) {
      const ok = await cancelFulltextRun(id);
      if (!ok) return res.status(400).send({ error: '当前状态不可取消' });
      const updated = await prisma.systemJobRun.findUnique({ where: { id } });
      return res.send({ run: updated });
    }

    return res.status(400).send({ error: '该任务不支持取消' });
  });
};

export { systemJobsRoutes };

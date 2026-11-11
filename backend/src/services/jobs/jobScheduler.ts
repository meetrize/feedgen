import cron from 'node-cron';

import { prisma } from '../../server';
import {
  DEDUP_JOB_KEY,
  enqueueDedupDay,
} from '../dedup/dedupQueue';
import { formatLocalDay } from '../dedup/dedupService';
import { ensureBuiltinJobsSeeded } from './jobRegistry';

type ScheduledHandle = { stop: () => void };

const handles = new Map<string, ScheduledHandle>();
let started = false;

async function triggerCronJob(jobKey: string): Promise<void> {
  const job = await prisma.systemJob.findUnique({ where: { key: jobKey } });
  if (!job || !job.enabled) return;

  if (jobKey === DEDUP_JOB_KEY) {
    const run = await prisma.systemJobRun.create({
      data: {
        job_key: jobKey,
        status: 'queued',
        progress: 0,
        progress_text: '定时触发',
        triggered_by: 'cron',
        stats: { run_day: formatLocalDay() },
      },
    });
    await enqueueDedupDay({
      runId: run.id,
      run_day: formatLocalDay(),
      config: (job.config || {}) as any,
    });
    return;
  }
}

function rescheduleOne(key: string, cronExpr: string, enabled: boolean): void {
  const existing = handles.get(key);
  if (existing) {
    existing.stop();
    handles.delete(key);
  }
  if (!enabled) return;
  if (!cronExpr || cronExpr === '—' || !cron.validate(cronExpr)) {
    console.warn(`[JobScheduler] 无效 cron，跳过 ${key}: ${cronExpr}`);
    return;
  }
  const task = cron.schedule(cronExpr, () => {
    triggerCronJob(key).catch((err) => {
      console.error(
        `[JobScheduler] 触发 ${key} 失败:`,
        err instanceof Error ? err.message : String(err),
      );
    });
  });
  handles.set(key, task);
}

/** 从 DB 重载可调度任务的 cron */
export async function reloadJobSchedules(): Promise<void> {
  const jobs = await prisma.systemJob.findMany({
    where: { enabled: true },
  });
  const activeKeys = new Set<string>();
  for (const job of jobs) {
    activeKeys.add(job.key);
    rescheduleOne(job.key, job.cron, true);
  }
  for (const [key, handle] of handles) {
    if (!activeKeys.has(key)) {
      handle.stop();
      handles.delete(key);
    }
  }
}

export async function startJobScheduler(): Promise<void> {
  if (started) return;
  if (process.env.JOB_SCHEDULER_ENABLED === '0') {
    console.log('[JobScheduler] disabled (JOB_SCHEDULER_ENABLED=0)');
    return;
  }
  started = true;
  await ensureBuiltinJobsSeeded();
  await reloadJobSchedules();
  console.log(`[JobScheduler] started, ${handles.size} cron job(s)`);
}

export function stopJobScheduler(): void {
  for (const [, h] of handles) h.stop();
  handles.clear();
  started = false;
}

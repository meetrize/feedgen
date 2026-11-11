import { prisma } from '../../server';
import { DEDUP_JOB_KEY, DEDUP_QUEUE_NAME } from '../dedup/dedupQueue';

export type BuiltinJobMeta = {
  key: string;
  name: string;
  description: string;
  cron: string;
  enabled: boolean;
  queue_name: string | null;
  config: Record<string, unknown>;
  /** 是否可由任务台触发运行 */
  runnable: boolean;
  /** 只读展示（现有独立 worker） */
  readonly: boolean;
};

/** 内置任务定义；首批可运行：dedup.daily；其余只读卡片 */
export const BUILTIN_JOBS: BuiltinJobMeta[] = [
  {
    key: DEDUP_JOB_KEY,
    name: '文章标题查重（按日）',
    description: '异步扫描当日文章近重复标题，标记转载簇；不影响爬虫主路径',
    cron: '15 */2 * * *',
    enabled: true,
    queue_name: DEDUP_QUEUE_NAME,
    config: { hammingMax: 3, jaccardMin: 0.88, forceRebuild: false },
    runnable: true,
    readonly: false,
  },
  {
    key: 'importance.queue',
    name: '文章重要度评分',
    description: '独立 Bull 队列（只读展示，请在重要度管理中操作）',
    cron: '—',
    enabled: true,
    queue_name: 'importance-queue',
    config: {},
    runnable: false,
    readonly: true,
  },
  {
    key: 'theme.match',
    name: '主题关键词匹配',
    description: '独立 Bull 队列（只读展示）',
    cron: '—',
    enabled: true,
    queue_name: 'theme-match-queue',
    config: {},
    runnable: false,
    readonly: true,
  },
  {
    key: 'finance.match',
    name: '金融产品匹配 / 词典同步',
    description: '独立队列与调度（只读展示，请在金融产品面板操作）',
    cron: '—',
    enabled: true,
    queue_name: 'finance-match-queue',
    config: {},
    runnable: false,
    readonly: true,
  },
];

export async function ensureBuiltinJobsSeeded(): Promise<void> {
  for (const job of BUILTIN_JOBS) {
    if (job.readonly) continue;
    await prisma.systemJob.upsert({
      where: { key: job.key },
      create: {
        key: job.key,
        name: job.name,
        description: job.description,
        cron: job.cron,
        enabled: job.enabled,
        queue_name: job.queue_name,
        config: job.config as any,
      },
      update: {
        name: job.name,
        description: job.description,
        queue_name: job.queue_name,
        // 不覆盖用户已改的 cron/enabled/config
      },
    });
  }
}

export function getBuiltinMeta(key: string): BuiltinJobMeta | undefined {
  return BUILTIN_JOBS.find((j) => j.key === key);
}

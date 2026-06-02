import { crawlLog, type CrawlLogLine, type ManualCrawlResult } from './crawlRunResult';

interface ProgressEntry extends ManualCrawlResult {
  startedAtMs: number;
}

const store = new Map<number, ProgressEntry>();

const TERMINAL = new Set(['success', 'failed', 'skipped']);

export function getCrawlProgress(feedId: number): ManualCrawlResult | null {
  const entry = store.get(feedId);
  if (!entry) return null;
  const { startedAtMs: _s, ...result } = entry;
  return result;
}

export function getCrawlProgressStartedAt(feedId: number): number | null {
  return store.get(feedId)?.startedAtMs ?? null;
}

export function isCrawlInProgress(feedId: number): boolean {
  const status = store.get(feedId)?.status;
  return status === 'running' || status === 'queued';
}

export function startCrawlProgress(feedId: number, mode: string, targetUrl?: string | null): ManualCrawlResult {
  const entry: ProgressEntry = {
    mode,
    status: 'running',
    message: '爬取进行中…',
    logs: [crawlLog('info', '任务已启动，正在连接目标…')],
    targetUrl: targetUrl ?? null,
    startedAtMs: Date.now(),
  };
  store.set(feedId, entry);
  return entry;
}

export function appendProgressLog(feedId: number, line: CrawlLogLine): void {
  const entry = store.get(feedId);
  if (!entry) return;
  entry.logs.push(line);
  if (line.level === 'error') {
    entry.message = line.message;
  } else if (line.level === 'ok' || line.level === 'info') {
    entry.message = line.message;
  }
  if (/已成功连接|HTTP 响应正常|已加载页面|连接测试通过|目标网站可访问/.test(line.message)) {
    entry.connected = true;
  }
  if (/无法连接|连接超时|DNS 解析失败|连接被拒绝/.test(line.message)) {
    entry.connected = false;
  }
  if (/共匹配 (\d+) 条|共 (\d+) 条条目/.test(line.message)) {
    const m = line.message.match(/(\d+)/);
    if (m) entry.parsedCount = Number(m[1]);
  }
}

export function finishCrawlProgress(feedId: number, result: ManualCrawlResult): void {
  const startedAtMs = store.get(feedId)?.startedAtMs ?? Date.now();
  store.set(feedId, { ...result, startedAtMs });
  if (TERMINAL.has(result.status)) {
    setTimeout(() => {
      const cur = store.get(feedId);
      if (cur && cur.status === result.status) store.delete(feedId);
    }, 10 * 60 * 1000);
  }
}

export function makeFeedLogger(logs: CrawlLogLine[], onLogLine?: (line: CrawlLogLine) => void) {
  return (level: Parameters<typeof crawlLog>[0], message: string): CrawlLogLine => {
    const line = crawlLog(level, message);
    logs.push(line);
    onLogLine?.(line);
    return line;
  };
}

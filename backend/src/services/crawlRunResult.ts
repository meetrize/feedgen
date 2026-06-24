export type CrawlLogLevel = 'info' | 'ok' | 'warn' | 'error';

export interface CrawlLogLine {
  time: string;
  level: CrawlLogLevel;
  message: string;
}

export interface ManualCrawlResult {
  mode: string;
  status: 'success' | 'failed' | 'skipped' | 'queued' | 'running';
  message: string;
  logs: CrawlLogLine[];
  connected?: boolean;
  targetUrl?: string | null;
  parsedCount?: number;
  newArticlesCount?: number;
  durationMs?: number;
  errorMessage?: string | null;
}

export function crawlLog(level: CrawlLogLevel, message: string): CrawlLogLine {
  return { time: new Date().toISOString(), level, message };
}

export function connectionErrorMessage(error: unknown): string {
  const err = error as { code?: string; message?: string };
  const code = String(err?.code || '');
  const msg = String(err?.message || error || '未知错误');
  if (code === 'ENOTFOUND') return 'DNS 解析失败，无法连接到目标主机';
  if (code === 'ECONNREFUSED') return '连接被拒绝，目标主机未响应';
  if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) return '连接超时，未能及时访问目标网站';
  if (/certificate|ssl|tls/i.test(msg)) return `SSL/TLS 连接失败：${msg}`;
  if (/401|403|404|5\d{2}/.test(msg)) return `HTTP 请求失败：${msg}`;
  return msg;
}

export function crawlResultFromHistory(row: {
  mode: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: number | null;
  new_articles_count: number;
  error_message: string | null;
}): ManualCrawlResult {
  const logs: CrawlLogLine[] = [];
  logs.push(crawlLog('info', `执行模式：${row.mode}`));
  logs.push(crawlLog('info', `开始时间：${row.started_at.toISOString()}`));

  if (row.status === 'queued') {
    logs.push(crawlLog('info', '任务已入队，等待 Worker 执行…'));
    return {
      mode: row.mode,
      status: 'queued',
      message: '任务排队中',
      logs,
      newArticlesCount: row.new_articles_count,
    };
  }

  if (row.finished_at) {
    logs.push(crawlLog('info', `结束时间：${row.finished_at.toISOString()}`));
  }
  if (row.duration_ms != null) {
    logs.push(crawlLog('info', `耗时：${Math.round(row.duration_ms / 1000)} 秒`));
  }

  if (row.status === 'success') {
    logs.push(crawlLog('ok', '已成功连接并完成爬取'));
    logs.push(crawlLog('ok', `新增 ${row.new_articles_count} 篇文章入库`));
    return {
      mode: row.mode,
      status: 'success',
      message: `爬取成功，新增 ${row.new_articles_count} 篇`,
      logs,
      connected: true,
      newArticlesCount: row.new_articles_count,
      ...(row.duration_ms != null ? { durationMs: row.duration_ms } : {}),
    };
  }

  if (row.status === 'skipped') {
    logs.push(crawlLog('warn', row.error_message || '已跳过本次爬取'));
    return {
      mode: row.mode,
      status: 'skipped',
      message: row.error_message || '已跳过',
      logs,
      errorMessage: row.error_message,
      ...(row.duration_ms != null ? { durationMs: row.duration_ms } : {}),
    };
  }

  logs.push(crawlLog('error', row.error_message || '爬取失败'));
  return {
    mode: row.mode,
    status: 'failed',
    message: row.error_message || '爬取失败',
    logs,
    connected: false,
    errorMessage: row.error_message,
    newArticlesCount: row.new_articles_count,
    ...(row.duration_ms != null ? { durationMs: row.duration_ms } : {}),
  };
}

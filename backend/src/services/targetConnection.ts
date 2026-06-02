import axios from 'axios';
import { connectionErrorMessage } from './crawlRunResult';

/** 连接测试超时（毫秒） */
export const TARGET_CONNECT_TIMEOUT_MS = 5000;

const PROBE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; FeedGen Bot/1.0)',
};

export type TargetConnectionResult =
  | { ok: true; statusCode: number }
  | { ok: false; message: string };

function formatProbeError(error: unknown): TargetConnectionResult {
  if (axios.isAxiosError(error)) {
    const code = error.code || '';
    if (code === 'ECONNABORTED' || /timeout/i.test(error.message)) {
      return { ok: false, message: '连接超时（5 秒内无响应），无法连接目标网站' };
    }
    const status = error.response?.status;
    if (status != null && status < 500) {
      return { ok: true, statusCode: status };
    }
  }
  return { ok: false, message: connectionErrorMessage(error) };
}

function judgeStatus(status: number): TargetConnectionResult {
  if (status >= 500) {
    return { ok: false, message: `目标网站返回 HTTP ${status}，无法正常使用` };
  }
  return { ok: true, statusCode: status };
}

/** 收到响应头后立即中止，避免下载大页面正文 */
async function probeWithStreamGet(url: string): Promise<TargetConnectionResult> {
  try {
    const response = await axios.get(url, {
      timeout: TARGET_CONNECT_TIMEOUT_MS,
      maxRedirects: 5,
      responseType: 'stream',
      headers: PROBE_HEADERS,
      validateStatus: () => true,
    });
    response.data.destroy();
    return judgeStatus(response.status);
  } catch (error) {
    return formatProbeError(error);
  }
}

/**
 * 测试目标 URL 是否可在限定时间内建立 HTTP 连接。
 * 优先 HEAD（无正文）；不支持时回退为 stream GET（仅读响应头）。
 */
export async function testTargetConnection(url: string): Promise<TargetConnectionResult> {
  const normalized = String(url || '').trim();
  if (!normalized) {
    return { ok: false, message: '目标 URL 为空' };
  }

  try {
    const response = await axios.head(normalized, {
      timeout: TARGET_CONNECT_TIMEOUT_MS,
      maxRedirects: 5,
      headers: PROBE_HEADERS,
      validateStatus: () => true,
    });
    if (response.status === 405 || response.status === 501) {
      return probeWithStreamGet(normalized);
    }
    return judgeStatus(response.status);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      if (status === 405 || status === 501) {
        return probeWithStreamGet(normalized);
      }
      if (status != null && status < 500) {
        return { ok: true, statusCode: status };
      }
      const code = error.code || '';
      if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ECONNABORTED' || /timeout/i.test(error.message)) {
        return formatProbeError(error);
      }
    }
    return probeWithStreamGet(normalized);
  }
}

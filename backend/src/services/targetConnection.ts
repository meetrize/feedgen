import http from 'http';
import https from 'https';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { connectionErrorMessage } from './crawlRunResult';
import { getFeedFetchHeaders } from './feedFetchHeaders';
import { LOCAL_PROXY_URL, shouldUseProxy } from './proxyConfig';

/** 连接测试超时（毫秒） */
export const TARGET_CONNECT_TIMEOUT_MS = 5000;

/** Yahoo 等站点 Cookie/响应头极大，需高于 Node 默认 16KB */
const MAX_HTTP_HEADER_SIZE = 1024 * 1024;

const PROBE_HEADERS = getFeedFetchHeaders();

export type TargetConnectionResult =
  | { ok: true; statusCode: number }
  | { ok: false; message: string };

function isHeaderOverflowError(error: unknown): boolean {
  const err = error as { code?: string; message?: string };
  const code = String(err?.code || '');
  const msg = String(err?.message || error || '');
  return (
    code === 'HPE_HEADER_OVERFLOW' ||
    /header overflow/i.test(msg) ||
    /HPE_HEADER_OVERFLOW/i.test(msg)
  );
}

function createProbeAgents(useProxy: boolean): {
  httpAgent: http.Agent;
  httpsAgent: http.Agent | https.Agent;
  proxy: false | undefined;
} {
  // @types/node 未完整暴露 maxHeaderSize，运行时 Node 支持该选项
  const agentOpts = { maxHeaderSize: MAX_HTTP_HEADER_SIZE } as http.AgentOptions;
  if (shouldUseProxy(useProxy)) {
    const agent = new (HttpsProxyAgent as any)(LOCAL_PROXY_URL, agentOpts);
    return { httpAgent: agent, httpsAgent: agent, proxy: false };
  }
  return {
    httpAgent: new http.Agent(agentOpts),
    httpsAgent: new https.Agent(agentOpts),
    proxy: undefined,
  };
}

function formatProbeError(error: unknown): TargetConnectionResult {
  // 能触发 Header overflow 说明 TCP/TLS/HTTP 已通，只是响应头过大；对连接预检视为成功
  if (isHeaderOverflowError(error)) {
    return { ok: true, statusCode: 200 };
  }
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

function probeAxiosConfig(useProxy: boolean) {
  const agents = createProbeAgents(useProxy);
  return {
    timeout: TARGET_CONNECT_TIMEOUT_MS,
    maxRedirects: 5,
    headers: PROBE_HEADERS,
    validateStatus: () => true,
    httpAgent: agents.httpAgent,
    httpsAgent: agents.httpsAgent,
    ...(agents.proxy === false ? { proxy: false as const } : {}),
    maxContentLength: 64_000,
    maxBodyLength: 64_000,
  };
}

/** 收到响应头后立即中止，避免下载大页面正文 */
async function probeWithStreamGet(url: string, useProxy = false): Promise<TargetConnectionResult> {
  try {
    const response = await axios.get(url, {
      ...probeAxiosConfig(useProxy),
      responseType: 'stream' as const,
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
export async function testTargetConnection(url: string, useProxy = false): Promise<TargetConnectionResult> {
  const normalized = String(url || '').trim();
  if (!normalized) {
    return { ok: false, message: '目标 URL 为空' };
  }

  try {
    const response = await axios.head(normalized, probeAxiosConfig(useProxy));
    if (response.status === 405 || response.status === 501) {
      return probeWithStreamGet(normalized, useProxy);
    }
    return judgeStatus(response.status);
  } catch (error) {
    if (isHeaderOverflowError(error)) {
      return { ok: true, statusCode: 200 };
    }
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      if (status === 405 || status === 501) {
        return probeWithStreamGet(normalized, useProxy);
      }
      if (status != null && status < 500) {
        return { ok: true, statusCode: status };
      }
      const code = error.code || '';
      if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ECONNABORTED' || /timeout/i.test(error.message)) {
        return formatProbeError(error);
      }
    }
    return probeWithStreamGet(normalized, useProxy);
  }
}

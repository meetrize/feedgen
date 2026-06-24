import type { AxiosRequestConfig } from 'axios';

/** 本机 HTTP 代理（如 Clash 默认端口） */
export const LOCAL_PROXY_URL = 'http://127.0.0.1:7890';

export function shouldUseProxy(useProxy?: boolean | null): boolean {
  return useProxy === true;
}

/** axios 代理配置 */
export function getAxiosProxyConfig(useProxy?: boolean | null) {
  if (!shouldUseProxy(useProxy)) return undefined;
  return {
    protocol: 'http' as const,
    host: '127.0.0.1',
    port: 7890,
  };
}

/** Playwright 代理配置 */
export function getPlaywrightProxyConfig(useProxy?: boolean | null) {
  if (!shouldUseProxy(useProxy)) return undefined;
  return { server: LOCAL_PROXY_URL };
}

/** 将代理字段合并进 axios 请求配置（避免 exactOptionalPropertyTypes 下 proxy: undefined） */
export function withAxiosProxy<T extends AxiosRequestConfig>(
  config: T,
  useProxy?: boolean | null,
): T {
  const proxy = getAxiosProxyConfig(useProxy);
  if (!proxy) return config;
  return { ...config, proxy };
}

/** 将代理字段合并进 Playwright 上下文配置 */
export function withPlaywrightProxy<T extends Record<string, unknown>>(
  config: T,
  useProxy?: boolean | null,
): T | (T & { proxy: NonNullable<ReturnType<typeof getPlaywrightProxyConfig>> }) {
  const proxy = getPlaywrightProxyConfig(useProxy);
  if (!proxy) return config;
  return { ...config, proxy };
}

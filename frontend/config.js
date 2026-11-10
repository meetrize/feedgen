// 后端直连回退（仅在页面不在已知前端/反代端口、且无公网映射时使用）
const BACKEND_HOST = '156.254.7.10';
const BACKEND_API_PORT = 3000;

/**
 * 公网端口映射：浏览器访问的前端端口 → 后端 API 端口。
 * 例：外网 53001→前端、53000→后端时，页面在 53001 则 API 走同主机 53000。
 */
const PUBLIC_API_PORT_BY_PAGE_PORT = {
  '53001': '53000',
};

/** 本机/局域网：由前端 dev-server 反代 /api，走同源（无跨域） */
const SAME_ORIGIN_API_PORTS = new Set(['3001', '3000', '63443', '']);

// API 地址：本机/局域网同源反代；公网映射端口走对应后端端口
function resolveApiBaseUrl() {
  if (typeof window === 'undefined' || !window.location.hostname) {
    return `http://${BACKEND_HOST}:${BACKEND_API_PORT}/api`;
  }
  const { protocol, hostname, port } = window.location;
  const hostWithPort = port ? `${hostname}:${port}` : hostname;

  const mappedBackendPort = PUBLIC_API_PORT_BY_PAGE_PORT[port];
  if (mappedBackendPort) {
    return `${protocol}//${hostname}:${mappedBackendPort}/api`;
  }

  if (SAME_ORIGIN_API_PORTS.has(port)) {
    return `${protocol}//${hostWithPort}/api`;
  }

  // 其他未知前端端口：同主机默认后端端口
  return `${protocol}//${hostname}:${BACKEND_API_PORT}/api`;
}

const API_BASE_URL = resolveApiBaseUrl();
const SERVER_BASE_URL = API_BASE_URL.replace(/\/api\/?$/, '');
const TTS_API_BASE_URL = (typeof window !== 'undefined' && window.location.hostname)
  ? (window.location.protocol + '//' + window.location.hostname + ':52492')
  : `http://${BACKEND_HOST}:52492`;

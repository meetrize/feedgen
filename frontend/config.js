// 外网映射的后端 API（浏览器直连）
const BACKEND_HOST = 'xy.senkin.dpdns.org';
const BACKEND_API_PORT = 56546;

// API 地址：优先与当前页面同源（经 63443/3000 反代访问时走 /api，无跨域）
function resolveApiBaseUrl() {
  if (typeof window === 'undefined' || !window.location.hostname) {
    return `http://${BACKEND_HOST}:${BACKEND_API_PORT}/api`;
  }
  const { protocol, hostname, port } = window.location;
  const hostWithPort = port ? `${hostname}:${port}` : hostname;
  // 本机开发：页面在 3001 时走同源 /api 反代（避免 CORS）
  if (
    (hostname === '127.0.0.1' || hostname === 'localhost') &&
    (port === '3001' || port === '3000' || port === '63443' || port === '')
  ) {
    if (port === '3001') {
      return `${protocol}//${hostWithPort}/api`;
    }
    return `${protocol}//${hostWithPort}/api`;
  }
  // 外网访问：固定走映射后的后端地址
  return `http://${BACKEND_HOST}:${BACKEND_API_PORT}/api`;
}

const API_BASE_URL = resolveApiBaseUrl();
const SERVER_BASE_URL = API_BASE_URL.replace(/\/api\/?$/, '');
const TTS_API_BASE_URL = (typeof window !== 'undefined' && window.location.hostname)
  ? (window.location.protocol + '//' + window.location.hostname + ':52492')
  : `http://${BACKEND_HOST}:52492`;

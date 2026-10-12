// 后端直连回退（仅在页面不在 3001/3000/63443 反代端口时使用）
const BACKEND_HOST = '156.254.7.10';
const BACKEND_API_PORT = 3000;

// API 地址：优先与当前页面同源（经 3001/3000/63443 反代访问时走 /api，无跨域）
function resolveApiBaseUrl() {
  if (typeof window === 'undefined' || !window.location.hostname) {
    return `http://${BACKEND_HOST}:${BACKEND_API_PORT}/api`;
  }
  const { protocol, hostname, port } = window.location;
  const hostWithPort = port ? `${hostname}:${port}` : hostname;
  // 前端 3001（含外网 IP）或后端/反代同端口：同源 /api
  if (port === '3001' || port === '3000' || port === '63443' || port === '') {
    return `${protocol}//${hostWithPort}/api`;
  }
  // 其他端口：同主机后端端口
  return `${protocol}//${hostname}:${BACKEND_API_PORT}/api`;
}

const API_BASE_URL = resolveApiBaseUrl();
const SERVER_BASE_URL = API_BASE_URL.replace(/\/api\/?$/, '');
const TTS_API_BASE_URL = (typeof window !== 'undefined' && window.location.hostname)
  ? (window.location.protocol + '//' + window.location.hostname + ':52492')
  : `http://${BACKEND_HOST}:52492`;

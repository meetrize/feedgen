// API 地址：优先与当前页面同源（经 63443/3000 反代访问时走 /api，无跨域）
function resolveApiBaseUrl() {
  if (typeof window === 'undefined' || !window.location.hostname) {
    return 'http://103.236.70.119:63443/api';
  }
  const { protocol, hostname, port } = window.location;
  const hostWithPort = port ? `${hostname}:${port}` : hostname;
  // 页面已由后端/反代在同一端口提供时，API 走同源
  if (port === '63443' || port === '3000' || port === '') {
    return `${protocol}//${hostWithPort}/api`;
  }
  // 本机开发：前端 3001 → 后端 3000
  if ((hostname === '127.0.0.1' || hostname === 'localhost') && port === '3001') {
    return `${protocol}//${hostname}:3000/api`;
  }
  // 其他情况：同协议 + 63443 反代端口
  return `${protocol}//${hostname}:63443/api`;
}

const API_BASE_URL = resolveApiBaseUrl();
const SERVER_BASE_URL = API_BASE_URL.replace(/\/api\/?$/, '');
const TTS_API_BASE_URL = (typeof window !== 'undefined' && window.location.hostname)
  ? (window.location.protocol + '//' + window.location.hostname + ':52492')
  : 'http://103.236.70.119:52492';

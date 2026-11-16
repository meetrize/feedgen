/**
 * 前端 API 基址：按浏览器访问入口智能选择后端。
 *
 * - 本机 / 局域网（3001 等）：同源 `/api`（由前端或反代转发）
 * - 公网 rp 映射：页面端口 → 后端端口（如 63001→63000、53001→53000）
 * - 未登记但符合 *01 模式：自动推断后端为 *00（同主机）
 */

/** 公网端口映射：浏览器访问的前端端口 → 后端 API 端口（显式优先） */
const PUBLIC_API_PORT_BY_PAGE_PORT = {
  '63001': '63000',
  '53001': '53000',
};

/** 本机/局域网：由前端 dev-server / nginx 反代 /api，走同源（无跨域） */
const SAME_ORIGIN_API_PORTS = new Set(['3001', '3000', '63443', '']);

/** 无 window 时的兜底（极少用到） */
const FALLBACK_BACKEND_HOST = '127.0.0.1';
const FALLBACK_BACKEND_API_PORT = '3000';

/**
 * 常见 rp 约定：前端 N01 → 后端 N00（如 63001→63000）。
 * 本机 3001 已在 SAME_ORIGIN 中，不会走到这里。
 */
function inferBackendPortFromPagePort(pagePort) {
  const p = String(pagePort || '');
  const m = p.match(/^(\d+)01$/);
  if (!m) return null;
  return `${m[1]}00`;
}

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function isPrivateLanHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (isLoopbackHost(h)) return true;
  // IPv4 私网
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  // 常见内网主机名
  if (h.endsWith('.local') || h.endsWith('.lan')) return true;
  return false;
}

// API 地址：本机/局域网同源反代；公网映射端口走对应后端端口
function resolveApiBaseUrl() {
  if (typeof window === 'undefined' || !window.location.hostname) {
    return `http://${FALLBACK_BACKEND_HOST}:${FALLBACK_BACKEND_API_PORT}/api`;
  }
  const { protocol, hostname, port } = window.location;
  const pagePort = port || (protocol === 'https:' ? '443' : '80');
  const hostWithPort = port ? `${hostname}:${port}` : hostname;

  // 1) 显式公网映射表（同主机名，换后端端口）
  const mappedBackendPort = PUBLIC_API_PORT_BY_PAGE_PORT[pagePort];
  if (mappedBackendPort) {
    return `${protocol}//${hostname}:${mappedBackendPort}/api`;
  }

  // 2) 本机 / 已知同源端口：走当前入口的 /api
  if (SAME_ORIGIN_API_PORTS.has(port) || SAME_ORIGIN_API_PORTS.has(pagePort)) {
    return `${protocol}//${hostWithPort}/api`;
  }

  // 3) 局域网 IP + 非常规端口：仍优先同源 /api（若反代存在）
  //    若端口符合 *01→*00，则走映射后端（rp 在局域网也常见）
  const inferred = inferBackendPortFromPagePort(pagePort);
  if (inferred) {
    return `${protocol}//${hostname}:${inferred}/api`;
  }

  // 4) 局域网访问但无映射线索：同源 /api
  if (isPrivateLanHost(hostname)) {
    return `${protocol}//${hostWithPort}/api`;
  }

  // 5) 其他未知公网入口：同主机默认后端端口
  return `${protocol}//${hostname}:${FALLBACK_BACKEND_API_PORT}/api`;
}

const API_BASE_URL = resolveApiBaseUrl();
const SERVER_BASE_URL = API_BASE_URL.replace(/\/api\/?$/, '');
const TTS_API_BASE_URL =
  typeof window !== 'undefined' && window.location.hostname
    ? `${window.location.protocol}//${window.location.hostname}:52492`
    : `http://${FALLBACK_BACKEND_HOST}:52492`;

/** meostock K 线：本机/局域网 :8765；公网 rp :53076（与当前访问主机同 IP） */
const MEOSTOCK_LOCAL_PORT = '8765';
const MEOSTOCK_PUBLIC_PORT = '53076';

/**
 * 按浏览器入口选择 meostock 根地址。
 * - 本机 → http://127.0.0.1:8765
 * - 局域网 → http://<lan-ip>:8765
 * - 公网 → http://<公网ip>:53076
 */
function resolveMeostockBaseUrl() {
  if (typeof window === 'undefined' || !window.location.hostname) {
    return `http://${FALLBACK_BACKEND_HOST}:${MEOSTOCK_LOCAL_PORT}`;
  }
  const { protocol, hostname } = window.location;
  if (isLoopbackHost(hostname)) {
    return `${protocol}//127.0.0.1:${MEOSTOCK_LOCAL_PORT}`;
  }
  if (isPrivateLanHost(hostname)) {
    return `${protocol}//${hostname}:${MEOSTOCK_LOCAL_PORT}`;
  }
  return `${protocol}//${hostname}:${MEOSTOCK_PUBLIC_PORT}`;
}

/**
 * 将后端存的 kline_url（常为 127.0.0.1:8765）改写为当前入口可达的地址，保留 path/query。
 */
function resolveKlineOpenUrl(storedUrl, chartSymbol) {
  const base = resolveMeostockBaseUrl().replace(/\/$/, '');
  const raw = String(storedUrl || '').trim();
  if (raw) {
    try {
      const src = new URL(raw, `${base}/`);
      const dest = new URL(base);
      dest.pathname = src.pathname || '/';
      dest.search = src.search;
      dest.hash = src.hash;
      return dest.toString();
    } catch {
      /* fall through */
    }
  }
  const symbol = String(chartSymbol || '').trim();
  if (symbol) {
    return `${base}/?symbol=${encodeURIComponent(symbol)}&period=1d`;
  }
  return `${base}/`;
}

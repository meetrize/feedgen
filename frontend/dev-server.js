#!/usr/bin/env node
/**
 * 静态站 + /api 反代，使 3001 与后端同源，避免浏览器 CORS。
 * 对瞬时连接失败做有限次重试，降低「后端不可用」误报。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.FRONTEND_PORT || 3001);
const BACKEND = process.env.BACKEND_ORIGIN || 'http://127.0.0.1:3000';
const ROOT = __dirname;
const PROXY_TIMEOUT_MS = Number(process.env.API_PROXY_TIMEOUT_MS || 30000);
const PROXY_RETRIES = Number(process.env.API_PROXY_RETRIES || 2);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function canRetry(method, errCode) {
  const m = (method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(m) && m !== 'POST') {
    // POST 仅对连接级失败重试（尚未写出 body 时由上层处理）；这里统一允许连接失败重试
  }
  return (
    errCode === 'ECONNREFUSED' ||
    errCode === 'ECONNRESET' ||
    errCode === 'ETIMEDOUT' ||
    errCode === 'EPIPE' ||
    errCode === 'EAI_AGAIN'
  );
}

function proxyApi(req, res) {
  const backendUrl = new URL(BACKEND);
  const chunks = [];
  let bodyDone = false;

  const bufferBody = new Promise((resolve) => {
    if (['GET', 'HEAD'].includes((req.method || 'GET').toUpperCase())) {
      bodyDone = true;
      resolve(Buffer.alloc(0));
      return;
    }
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      bodyDone = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', () => {
      bodyDone = true;
      resolve(Buffer.concat(chunks));
    });
  });

  bufferBody.then((bodyBuf) => {
    let attempt = 0;

    const tryOnce = () => {
      attempt += 1;
      const headers = { ...req.headers, host: backendUrl.host };
      delete headers['connection'];
      if (bodyBuf.length && !headers['content-length']) {
        headers['content-length'] = String(bodyBuf.length);
      }

      const p = http.request(
        {
          hostname: backendUrl.hostname,
          port: backendUrl.port || 80,
          path: req.url,
          method: req.method,
          headers,
          timeout: PROXY_TIMEOUT_MS,
        },
        (up) => {
          res.writeHead(up.statusCode || 502, up.headers);
          up.pipe(res);
        }
      );

      p.on('timeout', () => {
        p.destroy(Object.assign(new Error('proxy timeout'), { code: 'ETIMEDOUT' }));
      });

      p.on('error', (err) => {
        if (!res.headersSent && attempt <= PROXY_RETRIES + 1 && canRetry(req.method, err.code)) {
          const delay = 150 * attempt;
          console.warn(`[proxy] ${req.method} ${req.url} ${err.code || err.message}, retry ${attempt}/${PROXY_RETRIES + 1} in ${delay}ms`);
          setTimeout(tryOnce, delay);
          return;
        }
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              error: `后端不可用（${BACKEND}）: ${err.message}`,
              code: err.code || 'PROXY_ERROR',
            })
          );
        }
      });

      if (bodyBuf.length) p.write(bodyBuf);
      p.end();
    };

    if (!bodyDone) return;
    tryOnce();
  });
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent((urlPath || '/').split('?')[0]);
  const rel = decoded.replace(/^\/+/, '');
  const full = path.normalize(path.join(root, rel || 'index.html'));
  if (!full.startsWith(root)) return null;
  return full;
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const urlPath = req.url || '/';
  if (urlPath.startsWith('/api/') || urlPath === '/api') {
    proxyApi(req, res);
    return;
  }

  let filePath = safeJoin(ROOT, urlPath);
  if (!filePath) {
    res.writeHead(400).end('Bad request');
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (!err && st.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    fs.stat(filePath, (err2, st2) => {
      if (err2 || !st2.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      sendFile(res, filePath);
    });
  });
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Frontend http://127.0.0.1:${PORT}  (API -> ${BACKEND}, retries=${PROXY_RETRIES})`);
});

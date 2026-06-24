/**
 * 爬取日志浮层（article-reader / crawler-strategy 共用）
 * 右下角非模态面板，不阻挡文章浏览；后台轮询实时更新日志。
 */
const CrawlLogDialog = (function () {
  let panelEl = null;
  let logBodyEl = null;
  let summaryEl = null;
  let titleEl = null;
  let pollTimer = null;
  let pollFeedId = null;
  let pollOptions = null;
  let pollVisible = true;

  function authHeadersBearer() {
    const token = localStorage.getItem('anonymousUserToken');
    if (!token) return null;
    return { Authorization: `Bearer ${token}` };
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function formatLogTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function levelClass(level) {
    if (level === 'ok') return 'crawl-log-line--ok';
    if (level === 'warn') return 'crawl-log-line--warn';
    if (level === 'error') return 'crawl-log-line--error';
    return 'crawl-log-line--info';
  }

  function statusLabel(status) {
    if (status === 'running') return '进行中';
    if (status === 'queued') return '排队中';
    if (status === 'success') return '成功';
    if (status === 'failed') return '失败';
    if (status === 'skipped') return '已跳过';
    return status || '—';
  }

  function isInProgress(status) {
    return status === 'running' || status === 'queued';
  }

  function isTerminal(status) {
    return status === 'success' || status === 'failed' || status === 'skipped';
  }

  function buildSummary(result) {
    if (!result) return '';
    const parts = [];
    if (result.status) parts.push(`状态：${statusLabel(result.status)}`);
    if (result.mode) parts.push(`模式：${result.mode}`);
    if (result.connected === true) parts.push('连接：成功');
    if (result.connected === false) parts.push('连接：失败');
    if (typeof result.parsedCount === 'number') parts.push(`解析：${result.parsedCount} 条`);
    if (typeof result.newArticlesCount === 'number') parts.push(`新增：${result.newArticlesCount} 条`);
    if (typeof result.durationMs === 'number') parts.push(`耗时：${Math.max(1, Math.round(result.durationMs / 1000))} 秒`);
    return parts.join(' · ');
  }

  function renderLogs(result) {
    if (!logBodyEl || !summaryEl) return;
    const logs = Array.isArray(result?.logs) ? result.logs : [];
    summaryEl.textContent = buildSummary(result) || (result?.message || '');
    logBodyEl.innerHTML = logs.length
      ? logs.map((line) => {
          const cls = levelClass(line.level);
          return `<div class="crawl-log-line ${cls}"><span class="crawl-log-time">${escapeHtml(formatLogTime(line.time))}</span><span class="crawl-log-msg">${escapeHtml(line.message)}</span></div>`;
        }).join('')
      : '<div class="crawl-log-line crawl-log-line--info"><span class="crawl-log-msg">等待后端日志…</span></div>';
    logBodyEl.scrollTop = logBodyEl.scrollHeight;

    if (panelEl) {
      panelEl.classList.toggle('crawl-log-panel--running', isInProgress(result?.status));
      panelEl.classList.toggle('crawl-log-panel--done', isTerminal(result?.status));
      panelEl.classList.toggle('crawl-log-panel--failed', result?.status === 'failed');
    }
  }

  function ensurePanel() {
    if (panelEl) return;
    panelEl = document.createElement('div');
    panelEl.className = 'crawl-log-panel hidden';
    panelEl.innerHTML = `
      <div class="crawl-log-header">
        <div class="crawl-log-header-main">
          <span class="crawl-log-status-dot" aria-hidden="true"></span>
          <h3 class="crawl-log-title">爬取日志</h3>
        </div>
        <div class="crawl-log-header-actions">
          <button type="button" class="crawl-log-minimize" aria-label="收起" title="收起">−</button>
          <button type="button" class="crawl-log-close" aria-label="关闭" title="关闭">×</button>
        </div>
      </div>
      <div class="crawl-log-summary"></div>
      <div class="crawl-log-body"></div>
      <div class="crawl-log-footer">
        <span class="crawl-log-hint">可继续浏览，爬取在后台进行</span>
        <button type="button" class="secondary-btn crawl-log-close-btn">关闭</button>
      </div>
    `;
    document.body.appendChild(panelEl);
    logBodyEl = panelEl.querySelector('.crawl-log-body');
    summaryEl = panelEl.querySelector('.crawl-log-summary');
    titleEl = panelEl.querySelector('.crawl-log-title');

    const hide = () => CrawlLogDialog.hide();
    panelEl.querySelector('.crawl-log-close')?.addEventListener('click', hide);
    panelEl.querySelector('.crawl-log-close-btn')?.addEventListener('click', hide);
    panelEl.querySelector('.crawl-log-minimize')?.addEventListener('click', () => {
      panelEl.classList.toggle('is-minimized');
      const btn = panelEl.querySelector('.crawl-log-minimize');
      if (btn) btn.textContent = panelEl.classList.contains('is-minimized') ? '+' : '−';
    });
  }

  function showPanel(title) {
    ensurePanel();
    panelEl.classList.remove('hidden', 'is-minimized');
    const minBtn = panelEl.querySelector('.crawl-log-minimize');
    if (minBtn) minBtn.textContent = '−';
    if (title && titleEl) titleEl.textContent = title;
    pollVisible = true;
  }

  function stopPoll() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    pollFeedId = null;
    pollOptions = null;
  }

  async function fetchCrawlLatest(feedId) {
    const headers = authHeadersBearer();
    if (!headers) return null;
    const res = await fetch(`${API_BASE_URL}/crawler-strategies/${feedId}/crawl-latest`, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `获取爬取状态失败：${res.status}`);
    return data.result || null;
  }

  function pollUntilDone(feedId, onUpdate) {
    const deadline = Date.now() + 300000;
    stopPoll();
    pollFeedId = feedId;

    return new Promise((resolve) => {
      async function tick() {
        if (pollFeedId !== feedId) return;
        try {
          const result = await fetchCrawlLatest(feedId);
          if (result) {
            onUpdate(result);
            if (isTerminal(result.status)) {
              stopPoll();
              resolve(result);
              return;
            }
          }
        } catch {
          /* 轮询失败时继续重试 */
        }
        if (Date.now() >= deadline) {
          stopPoll();
          const timeoutResult = {
            status: 'failed',
            mode: 'unknown',
            message: '轮询超时，任务可能仍在后台执行',
            logs: [
              { time: new Date().toISOString(), level: 'warn', message: '等待后端响应超时（5 分钟），请稍后在爬虫策略页查看最近结果' },
            ],
          };
          onUpdate(timeoutResult);
          resolve(timeoutResult);
          return;
        }
        pollTimer = setTimeout(tick, 1000);
      }
      pollTimer = setTimeout(tick, 800);
    });
  }

  async function runCrawl(feedId, options = {}) {
    const id = Number(feedId);
    if (!Number.isFinite(id) || id <= 0) {
      options.showMsg?.('Feed ID 无效', true);
      return null;
    }

    const headers = authHeadersBearer();
    if (!headers) {
      options.showMsg?.('请先登录', true);
      return null;
    }

    pollOptions = options;
    showPanel(options.title || '爬取日志');
    renderLogs({
      status: 'running',
      message: '正在触发爬取…',
      logs: [{ time: new Date().toISOString(), level: 'info', message: '正在请求后端开始爬取…' }],
    });

    try {
      const res = await fetch(`${API_BASE_URL}/crawler-strategies/${id}/crawl`, {
        method: 'POST',
        headers,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `爬取失败：${res.status}`);

      renderLogs(data);

      let finalResult = data;
      if (isInProgress(data.status)) {
        finalResult = await pollUntilDone(id, (result) => {
          renderLogs(result);
        });
      }

      const failed = finalResult.status === 'failed';
      options.showMsg?.(finalResult.message || '爬取已完成', failed);

      if (typeof options.onComplete === 'function') {
        await options.onComplete(finalResult);
      }
      return finalResult;
    } catch (error) {
      stopPoll();
      const errMsg = error?.message || String(error);
      renderLogs({
        status: 'failed',
        message: errMsg,
        connected: false,
        logs: [
          { time: new Date().toISOString(), level: 'error', message: errMsg },
        ],
      });
      options.showMsg?.(errMsg, true);
      return null;
    }
  }

  return {
    open(result, title) {
      showPanel(title || '爬取日志');
      renderLogs(result || {});
    },
    hide() {
      pollVisible = false;
      panelEl?.classList.add('hidden');
      /* 轮询继续，完成后仍会 showMsg / onComplete */
    },
    close() {
      stopPoll();
      panelEl?.classList.add('hidden');
    },
    runCrawl,
  };
})();

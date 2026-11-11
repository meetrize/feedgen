/**
 * Admin — 定时任务台
 * 依赖：config.js (API_BASE_URL)、admin.js 登录态 (feedgen_admin_token)
 */
(function () {
  const TOKEN_KEY = 'feedgen_admin_token';
  let pollTimer = null;
  let selectedKey = null;

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function authHeaders() {
    return {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
    };
  }

  function esc(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function formatDt(v) {
    if (!v) return '—';
    try {
      return new Date(v).toLocaleString('zh-CN');
    } catch {
      return String(v);
    }
  }

  function setMsg(text, isError) {
    const el = document.getElementById('system-jobs-msg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('error', 'ok');
    if (text) el.classList.add(isError ? 'error' : 'ok');
  }

  async function api(path, options) {
    const res = await fetch(`${API_BASE_URL}/admin/jobs${path}`, {
      ...options,
      headers: { ...authHeaders(), ...(options && options.headers) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }

  function statusBadge(status) {
    const s = status || '—';
    const color =
      s === 'success'
        ? '#1a7f37'
        : s === 'failed'
          ? '#cf222e'
          : s === 'running' || s === 'queued'
            ? '#0969da'
            : s === 'cancelled'
              ? '#6e7781'
              : '#57606a';
    return `<span style="color:${color};font-weight:600;">${esc(s)}</span>`;
  }

  function progressBar(run) {
    if (!run) return '—';
    const p = Math.max(0, Math.min(100, Number(run.progress) || 0));
    const text = run.progress_text ? esc(run.progress_text) : `${p}%`;
    return `<div style="min-width:140px;">
      <div style="height:6px;background:#eee;border-radius:3px;overflow:hidden;">
        <div style="height:100%;width:${p}%;background:#0969da;"></div>
      </div>
      <div style="font-size:0.75rem;color:#666;margin-top:2px;">${text}</div>
    </div>`;
  }

  async function loadJobs() {
    const data = await api('/');
    const tbody = document.querySelector('#table-system-jobs tbody');
    if (!tbody) return;
    const jobs = data.jobs || [];
    tbody.innerHTML = jobs
      .map((j) => {
        const run = j.latest_run;
        const canRun = j.runnable && !j.readonly;
        const running =
          run && (run.status === 'running' || run.status === 'queued');
        const actions = [];
        if (canRun) {
          actions.push(
            `<button type="button" class="secondary-btn sysjob-trigger" data-key="${esc(j.key)}">立即运行</button>`,
          );
          if (running) {
            actions.push(
              `<button type="button" class="secondary-btn sysjob-cancel" data-run-id="${run.id}">停止</button>`,
            );
          }
          actions.push(
            `<button type="button" class="secondary-btn sysjob-toggle" data-key="${esc(j.key)}" data-enabled="${j.enabled ? '0' : '1'}">${j.enabled ? '禁用' : '启用'}</button>`,
          );
        } else {
          actions.push('<span style="color:#999;font-size:0.8rem;">只读</span>');
        }
        actions.push(
          `<button type="button" class="secondary-btn sysjob-history" data-key="${esc(j.key)}">历史</button>`,
        );
        return `<tr>
          <td>${esc(j.name)}<div style="font-size:0.75rem;color:#888;">${esc(j.key)}</div></td>
          <td><code>${esc(j.cron)}</code></td>
          <td>${j.enabled ? '是' : '否'}</td>
          <td>${run ? statusBadge(run.status) : '—'}</td>
          <td>${progressBar(run)}</td>
          <td>${run ? formatDt(run.started_at || run.created_at) : '—'}</td>
          <td style="white-space:nowrap;">${actions.join(' ')}</td>
        </tr>`;
      })
      .join('');
  }

  async function loadRuns(key) {
    selectedKey = key;
    const title = document.getElementById('system-jobs-runs-title');
    if (title) title.textContent = `运行历史 · ${key}`;
    const data = await api(`/${encodeURIComponent(key)}/runs?limit=40`);
    const tbody = document.querySelector('#table-system-job-runs tbody');
    if (!tbody) return;
    const runs = data.runs || [];
    tbody.innerHTML = runs
      .map((r) => {
        const stats = r.stats ? esc(JSON.stringify(r.stats)) : '—';
        return `<tr>
          <td>${r.id}</td>
          <td>${statusBadge(r.status)}</td>
          <td>${esc(r.triggered_by)}</td>
          <td>${progressBar(r)}</td>
          <td>${formatDt(r.started_at)}</td>
          <td>${formatDt(r.finished_at)}</td>
          <td style="max-width:280px;font-size:0.75rem;word-break:break-all;">${r.error ? esc(r.error) : stats}</td>
        </tr>`;
      })
      .join('');
  }

  function bindOnce() {
    const root = document.getElementById('panel-system-jobs');
    if (!root || root.dataset.bound === '1') return;
    root.dataset.bound = '1';

    document.getElementById('system-jobs-refresh')?.addEventListener('click', () => {
      loadJobs().catch((e) => setMsg(e.message, true));
      if (selectedKey) loadRuns(selectedKey).catch(() => {});
    });

    root.addEventListener('click', async (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLElement)) return;
      try {
        if (t.classList.contains('sysjob-trigger')) {
          const key = t.getAttribute('data-key');
          setMsg('入队中…');
          await api(`/${encodeURIComponent(key)}/trigger`, {
            method: 'POST',
            body: JSON.stringify({ mode: 'day' }),
          });
          setMsg('已触发', false);
          await loadJobs();
          await loadRuns(key);
        } else if (t.classList.contains('sysjob-cancel')) {
          const runId = t.getAttribute('data-run-id');
          await api(`/runs/${runId}/cancel`, { method: 'POST', body: '{}' });
          setMsg('已请求停止', false);
          await loadJobs();
          if (selectedKey) await loadRuns(selectedKey);
        } else if (t.classList.contains('sysjob-toggle')) {
          const key = t.getAttribute('data-key');
          const enabled = t.getAttribute('data-enabled') === '1';
          await api(`/${encodeURIComponent(key)}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled }),
          });
          setMsg(enabled ? '已启用' : '已禁用', false);
          await loadJobs();
        } else if (t.classList.contains('sysjob-history')) {
          const key = t.getAttribute('data-key');
          await loadRuns(key);
        }
      } catch (e) {
        setMsg(e.message || String(e), true);
      }
    });
  }

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(() => {
      const panel = document.getElementById('panel-system-jobs');
      if (!panel || !panel.classList.contains('active')) return;
      loadJobs().catch(() => {});
      if (selectedKey) loadRuns(selectedKey).catch(() => {});
    }, 4000);
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  window.loadSystemJobsPanel = async function loadSystemJobsPanel() {
    bindOnce();
    setMsg('');
    await loadJobs();
    startPoll();
  };
})();

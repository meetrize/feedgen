/**
 * Admin — 定时任务台
 * 依赖：config.js (API_BASE_URL)、admin.js 登录态 (feedgen_admin_token)
 */
(function () {
  const TOKEN_KEY = 'feedgen_admin_token';
  const CALENDAR_JOB_KEY = 'calendar.future_scan';
  let pollTimer = null;
  let selectedKey = null;
  let jobsCache = [];
  let configKey = null;

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

  function fillConfigForm(job) {
    const cfg = job.config || {};
    const cronEl = document.getElementById('sysjob-cfg-cron');
    const batchEl = document.getElementById('sysjob-cfg-batch');
    const maxEventsEl = document.getElementById('sysjob-cfg-max-events');
    const maxBodyEl = document.getElementById('sysjob-cfg-max-body');
    const titleSys = document.getElementById('sysjob-cfg-title-system');
    const titleUser = document.getElementById('sysjob-cfg-title-user');
    const extractSys = document.getElementById('sysjob-cfg-extract-system');
    const extractUser = document.getElementById('sysjob-cfg-extract-user');
    const title = document.getElementById('system-jobs-config-title');
    if (title) title.textContent = `策略配置 · ${job.name || job.key}`;
    if (cronEl) cronEl.value = job.cron || '';
    if (batchEl) batchEl.value = String(cfg.batchSize ?? 40);
    if (maxEventsEl) maxEventsEl.value = String(cfg.maxEventsPerArticle ?? 8);
    if (maxBodyEl) maxBodyEl.value = String(cfg.maxBodyChars ?? 12000);
    const dedupeEn = document.getElementById('sysjob-cfg-dedupe-enabled');
    const dedupeWin = document.getElementById('sysjob-cfg-dedupe-window');
    const dedupeConf = document.getElementById('sysjob-cfg-dedupe-conf');
    if (dedupeEn) dedupeEn.checked = cfg.dedupeEnabled !== false;
    if (dedupeWin) dedupeWin.value = String(cfg.dedupeDayWindow ?? 2);
    if (dedupeConf) dedupeConf.value = String(cfg.dedupeMinConfidence ?? 0.8);
    if (titleSys) titleSys.value = cfg.titleSystemPrompt || '';
    if (titleUser) titleUser.value = cfg.titleUserPromptTemplate || '';
    if (extractSys) extractSys.value = cfg.extractSystemPrompt || '';
    if (extractUser) extractUser.value = cfg.extractUserPromptTemplate || '';
  }

  function showConfig(key) {
    const job = jobsCache.find((j) => j.key === key);
    if (!job || key !== CALENDAR_JOB_KEY) return;
    configKey = key;
    fillConfigForm(job);
    const box = document.getElementById('system-jobs-config');
    if (box) box.style.display = 'block';
  }

  function hideConfig() {
    configKey = null;
    const box = document.getElementById('system-jobs-config');
    if (box) box.style.display = 'none';
  }

  async function saveConfig() {
    if (!configKey) return;
    const config = {
      batchSize: Number(document.getElementById('sysjob-cfg-batch')?.value) || 40,
      maxEventsPerArticle:
        Number(document.getElementById('sysjob-cfg-max-events')?.value) || 8,
      maxBodyChars: Number(document.getElementById('sysjob-cfg-max-body')?.value) || 12000,
      dedupeEnabled: Boolean(document.getElementById('sysjob-cfg-dedupe-enabled')?.checked),
      dedupeDayWindow: Number(document.getElementById('sysjob-cfg-dedupe-window')?.value) || 2,
      dedupeMinConfidence: Number(document.getElementById('sysjob-cfg-dedupe-conf')?.value) || 0.8,
      titleSystemPrompt: document.getElementById('sysjob-cfg-title-system')?.value || '',
      titleUserPromptTemplate: document.getElementById('sysjob-cfg-title-user')?.value || '',
      extractSystemPrompt: document.getElementById('sysjob-cfg-extract-system')?.value || '',
      extractUserPromptTemplate:
        document.getElementById('sysjob-cfg-extract-user')?.value || '',
    };
    const cron = String(document.getElementById('sysjob-cfg-cron')?.value || '').trim();
    const body = { config };
    if (cron) body.cron = cron;
    await api(`/${encodeURIComponent(configKey)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    setMsg('配置已保存', false);
    await loadJobs();
    const job = jobsCache.find((j) => j.key === configKey);
    if (job) fillConfigForm(job);
  }

  async function resetPrompts() {
    if (!configKey) return;
    const data = await api(`/${encodeURIComponent(configKey)}/defaults`);
    const defaults = data.config || {};
    const titleSys = document.getElementById('sysjob-cfg-title-system');
    const titleUser = document.getElementById('sysjob-cfg-title-user');
    const extractSys = document.getElementById('sysjob-cfg-extract-system');
    const extractUser = document.getElementById('sysjob-cfg-extract-user');
    if (titleSys) titleSys.value = defaults.titleSystemPrompt || '';
    if (titleUser) titleUser.value = defaults.titleUserPromptTemplate || '';
    if (extractSys) extractSys.value = defaults.extractSystemPrompt || '';
    if (extractUser) extractUser.value = defaults.extractUserPromptTemplate || '';
    const batchEl = document.getElementById('sysjob-cfg-batch');
    const maxEventsEl = document.getElementById('sysjob-cfg-max-events');
    const maxBodyEl = document.getElementById('sysjob-cfg-max-body');
    if (batchEl && defaults.batchSize != null) batchEl.value = String(defaults.batchSize);
    if (maxEventsEl && defaults.maxEventsPerArticle != null) {
      maxEventsEl.value = String(defaults.maxEventsPerArticle);
    }
    if (maxBodyEl && defaults.maxBodyChars != null) {
      maxBodyEl.value = String(defaults.maxBodyChars);
    }
    const dedupeEn = document.getElementById('sysjob-cfg-dedupe-enabled');
    const dedupeWin = document.getElementById('sysjob-cfg-dedupe-window');
    const dedupeConf = document.getElementById('sysjob-cfg-dedupe-conf');
    if (dedupeEn) dedupeEn.checked = defaults.dedupeEnabled !== false;
    if (dedupeWin && defaults.dedupeDayWindow != null) {
      dedupeWin.value = String(defaults.dedupeDayWindow);
    }
    if (dedupeConf && defaults.dedupeMinConfidence != null) {
      dedupeConf.value = String(defaults.dedupeMinConfidence);
    }
    setMsg('已填入默认提示词（尚未保存）', false);
  }

  async function loadJobs() {
    const data = await api('/');
    const tbody = document.querySelector('#table-system-jobs tbody');
    if (!tbody) return;
    const jobs = data.jobs || [];
    jobsCache = jobs;
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
        if (j.key === CALENDAR_JOB_KEY && canRun) {
          actions.push(
            `<button type="button" class="secondary-btn sysjob-config" data-key="${esc(j.key)}">策略/提示词</button>`,
          );
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

    if (configKey) {
      const job = jobsCache.find((j) => j.key === configKey);
      if (job) fillConfigForm(job);
    }
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

    document.getElementById('sysjob-cfg-save')?.addEventListener('click', () => {
      saveConfig().catch((e) => setMsg(e.message || String(e), true));
    });
    document.getElementById('sysjob-cfg-reset')?.addEventListener('click', () => {
      resetPrompts().catch((e) => setMsg(e.message || String(e), true));
    });
    document.getElementById('sysjob-cfg-close')?.addEventListener('click', () => {
      hideConfig();
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
        } else if (t.classList.contains('sysjob-config')) {
          const key = t.getAttribute('data-key');
          showConfig(key);
          await loadRuns(key);
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

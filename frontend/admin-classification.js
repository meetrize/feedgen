/**
 * Admin — 新闻分类（步骤 5–15B 统计报表）
 * 依赖：config.js (API_BASE_URL)、admin.js 已登录态 (feedgen_admin_token)
 */
(function () {
  const TOKEN_KEY = 'feedgen_admin_token';
  const TRAINING_POLL_MS = 3000;
  const BATCH_POLL_MS = 3000;

  const state = {
    categories: [],
    editingId: null,
    activeTab: 'pending',
    pending: { items: [], total: 0 },
    selectedPending: new Set(),
    training: {
      activeModel: null,
      jobs: [],
      pollingJobId: null,
      pollTimer: null,
    },
    batch: {
      feeds: [],
      pollingJobId: null,
      pollTimer: null,
    },
    report: null,
  };

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function authBearerOnly() {
    return { Authorization: `Bearer ${getToken()}` };
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
    d.textContent = s;
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

  function formatConfidence(v) {
    if (v == null || Number.isNaN(Number(v))) return '—';
    return `${Math.round(Number(v) * 100)}%`;
  }

  function setFormMessage(text, isError) {
    const el = document.getElementById('classification-form-msg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('error', 'ok');
    if (text) el.classList.add(isError ? 'error' : 'ok');
  }

  function setTotalMessage(text) {
    const el = document.getElementById('classification-total');
    if (el) el.textContent = text || '';
  }

  function setPendingTotalMessage(text) {
    const el = document.getElementById('classification-pending-total');
    if (el) el.textContent = text || '';
  }

  function setTrainingMessage(text, isError) {
    const el = document.getElementById('classification-training-msg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('error', 'ok');
    if (text) el.classList.add(isError ? 'error' : 'ok');
  }

  function parseMetricsJson(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function formatMetricsSummary(metrics) {
    const m = parseMetricsJson(metrics);
    if (!m) return '—';
    const parts = [];
    if (m.accuracy != null) parts.push(`准确率 ${(Number(m.accuracy) * 100).toFixed(1)}%`);
    if (m.macro_f1 != null) parts.push(`Macro F1 ${(Number(m.macro_f1) * 100).toFixed(1)}%`);
    if (m.train_count != null) parts.push(`训练 ${m.train_count}`);
    if (m.val_count != null) parts.push(`验证 ${m.val_count}`);
    if (m.category_count != null) parts.push(`类别 ${m.category_count}`);
    return parts.length ? parts.join(' · ') : '—';
  }

  function jobStatusPill(status) {
    const map = {
      pending: '排队中',
      running: '训练中',
      completed: '已完成',
      failed: '失败',
    };
    const label = map[status] || status || '—';
    const cls = ['pending', 'running', 'completed', 'failed'].includes(status) ? status : 'pending';
    return `<span class="classification-job-status ${cls}">${esc(label)}</span>`;
  }

  function stopTrainingPoll() {
    if (state.training.pollTimer) {
      clearInterval(state.training.pollTimer);
      state.training.pollTimer = null;
    }
    state.training.pollingJobId = null;
  }

  function setTrainingProgressVisible(visible, progress, label) {
    const wrap = document.getElementById('classification-training-progress-wrap');
    const fill = document.getElementById('classification-training-progress-fill');
    const labelEl = document.getElementById('classification-training-progress-label');
    if (wrap) wrap.classList.toggle('visible', visible);
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, Number(progress) || 0))}%`;
    if (labelEl) labelEl.textContent = label || '';
  }

  function openModal(el) {
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
  }

  function closeModal(el) {
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
  }

  function parseExamplesText(text) {
    return String(text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function statusPill(status) {
    if (status === 'active') {
      return '<span class="admin-status-pill active">启用</span>';
    }
    return '<span class="admin-status-pill disabled">已禁用</span>';
  }

  function colorCell(color) {
    if (!color) return '—';
    const safe = esc(color);
    return `<span class="classification-color-swatch" style="background:${safe};"></span>${safe}`;
  }

  function activeCategories() {
    return state.categories.filter((c) => c.status === 'active');
  }

  function buildCategoryOptions(selectedId) {
    const opts = ['<option value="">选择类别…</option>'];
    for (const cat of activeCategories()) {
      const sel = selectedId === cat.id ? ' selected' : '';
      opts.push(`<option value="${cat.id}"${sel}>${esc(cat.name)} (${esc(cat.code)})</option>`);
    }
    return opts.join('');
  }

  function refreshCategoryDropdowns() {
    const batchSelect = document.getElementById('classification-pending-batch-category');
    if (batchSelect) {
      const current = batchSelect.value;
      batchSelect.innerHTML = '<option value="">批量设类…</option>' +
        activeCategories()
          .map((c) => `<option value="${c.id}">${esc(c.name)} (${esc(c.code)})</option>`)
          .join('');
      batchSelect.value = current;
    }
  }

  function switchClassificationTab(tab) {
    if (state.activeTab === 'training' && tab !== 'training') {
      stopTrainingPoll();
      setTrainingProgressVisible(false, 0, '');
    }
    state.activeTab = tab;
    document.querySelectorAll('.classification-tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-classification-tab') === tab);
    });
    document.querySelectorAll('.classification-tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `classification-tab-${tab}`);
    });
  }

  function getPendingFilters() {
    const needReviewEl = document.getElementById('classification-pending-need-review');
    const confMinEl = document.getElementById('classification-pending-conf-min');
    const confMaxEl = document.getElementById('classification-pending-conf-max');
    return {
      need_review: needReviewEl?.value !== 'false',
      conf_min: confMinEl?.value.trim() || '',
      conf_max: confMaxEl?.value.trim() || '',
    };
  }

  function filterPendingClient(items, filters) {
    let result = items;
    const min = filters.conf_min === '' ? null : Number(filters.conf_min);
    const max = filters.conf_max === '' ? null : Number(filters.conf_max);
    if (min != null && !Number.isNaN(min)) {
      result = result.filter((item) => item.confidence != null && item.confidence >= min);
    }
    if (max != null && !Number.isNaN(max)) {
      result = result.filter((item) => item.confidence != null && item.confidence <= max);
    }
    return result;
  }

  async function ensureCategoriesLoaded() {
    if (state.categories.length) return;
    const res = await fetch(`${API_BASE_URL}/admin/classification/categories`, {
      headers: authBearerOnly(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '加载类别列表失败');
    state.categories = data.categories || [];
    refreshCategoryDropdowns();
  }

  async function loadPending() {
    await ensureCategoriesLoaded();

    const filters = getPendingFilters();
    const params = new URLSearchParams({
      limit: '100',
      offset: '0',
      need_review: filters.need_review ? 'true' : 'false',
    });

    const res = await fetch(
      `${API_BASE_URL}/admin/classification/pending?${params.toString()}`,
      { headers: authBearerOnly() },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '加载待标注队列失败');

    const items = filterPendingClient(data.items || [], filters);
    state.pending.items = items;
    state.pending.total = data.total ?? items.length;
    state.selectedPending.clear();

    setPendingTotalMessage(`共 ${state.pending.total} 条待处理（当前显示 ${items.length} 条）`);

    const tbody = document.querySelector('#table-classification-pending tbody');
    const selectAll = document.getElementById('classification-pending-select-all');
    if (selectAll) selectAll.checked = false;
    if (!tbody) return;

    if (!items.length) {
      tbody.innerHTML =
        '<tr><td colspan="7" style="text-align:center;color:#999;padding:1.5rem;">暂无待标注文章</td></tr>';
      return;
    }

    tbody.innerHTML = items
      .map((item) => {
        const ai = item.ai_category;
        const aiCell = ai
          ? `${colorCell(ai.color)}${esc(ai.name)}`
          : '<span style="color:#999;">未分类</span>';
        const selectId = `pending-cat-${item.article_id}`;
        return `<tr data-article-id="${item.article_id}">
          <td><input type="checkbox" class="classification-pending-check" data-id="${item.article_id}"></td>
          <td>${esc(item.title)}</td>
          <td>${esc(item.feed_title)}</td>
          <td>${aiCell}</td>
          <td>${formatConfidence(item.confidence)}</td>
          <td>${formatDt(item.classified_at)}</td>
          <td>
            <select id="${selectId}" class="classification-pending-select pending-row-category" data-id="${item.article_id}">
              ${buildCategoryOptions(ai?.id ?? null)}
            </select>
            <button type="button" class="secondary-btn btn-tight btn-pending-annotate" data-id="${item.article_id}">标注</button>
          </td>
        </tr>`;
      })
      .join('');
  }

  async function annotateArticles(articleIds, categoryId) {
    if (!articleIds.length) {
      alert('请先选择文章');
      return;
    }
    if (!categoryId) {
      alert('请选择类别');
      return;
    }

    const res = await fetch(`${API_BASE_URL}/admin/classification/annotate`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        article_ids: articleIds,
        category_id: Number(categoryId),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '标注失败');
    await loadPending();
  }

  function setBatchMessage(text, isError) {
    const el = document.getElementById('classification-batch-msg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('error', 'ok');
    if (text) el.classList.add(isError ? 'error' : 'ok');
  }

  function setBatchProgressVisible(visible, progress, label) {
    const wrap = document.getElementById('classification-batch-progress-wrap');
    const fill = document.getElementById('classification-batch-progress-fill');
    const labelEl = document.getElementById('classification-batch-progress-label');
    if (wrap) wrap.classList.toggle('visible', visible);
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, Number(progress) || 0))}%`;
    if (labelEl) labelEl.textContent = label || '';
  }

  function stopBatchPoll() {
    if (state.batch.pollTimer) {
      clearInterval(state.batch.pollTimer);
      state.batch.pollTimer = null;
    }
    state.batch.pollingJobId = null;
  }

  async function loadBatchFeeds() {
    const select = document.getElementById('classification-batch-feed');
    if (!select) return;

    const current = select.value;
    const res = await fetch(`${API_BASE_URL}/admin/feeds?limit=200&offset=0`, {
      headers: authBearerOnly(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '加载 Feed 列表失败');

    state.batch.feeds = Array.isArray(data.feeds) ? data.feeds : [];
    const options = ['<option value="">全部 Feed</option>'];
    for (const feed of state.batch.feeds) {
      const title = feed.title || `Feed #${feed.id}`;
      options.push(`<option value="${feed.id}">${esc(title)} (#${feed.id})</option>`);
    }
    select.innerHTML = options.join('');
    select.value = current;
  }

  function startBatchPoll(jobId) {
    stopBatchPoll();
    state.batch.pollingJobId = jobId;

    const pollOnce = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/admin/classification/classify/batch/${jobId}`, {
          headers: authBearerOnly(),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '获取批量进度失败');

        const job = data.job;
        setBatchProgressVisible(
          job.status === 'waiting' || job.status === 'active' || job.status === 'queued',
          job.progress,
          `批量任务 #${job.job_id}：${job.status}（${job.processed}/${job.total}，成功 ${job.succeeded}，失败 ${job.failed}）`,
        );

        if (job.status === 'completed') {
          stopBatchPoll();
          setBatchProgressVisible(false, 100, '');
          setBatchMessage(`批量分类完成：成功 ${job.succeeded}，失败 ${job.failed}`, false);
          return;
        }

        if (job.status === 'failed') {
          stopBatchPoll();
          setBatchProgressVisible(false, job.progress, '');
          setBatchMessage(job.error || '批量分类失败', true);
        }
      } catch (e) {
        stopBatchPoll();
        setBatchProgressVisible(false, 0, '');
        setBatchMessage(e.message || String(e), true);
      }
    };

    pollOnce();
    state.batch.pollTimer = setInterval(pollOnce, BATCH_POLL_MS);
  }

  async function startBatchClassification() {
    const btn = document.getElementById('classification-batch-btn');
    const feedRaw = document.getElementById('classification-batch-feed')?.value || '';
    const sinceRaw = document.getElementById('classification-batch-since')?.value || '';
    const onlyUnclassified = document.getElementById('classification-batch-only-unclassified')?.checked !== false;

    const body = { only_unclassified: onlyUnclassified };
    if (feedRaw) {
      body.feed_id = Number(feedRaw);
    }
    if (sinceRaw) {
      body.since = sinceRaw;
    }

    if (btn) btn.disabled = true;
    setBatchMessage('正在提交批量任务…', false);

    try {
      const res = await fetch(`${API_BASE_URL}/admin/classification/classify/batch`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '批量分类入队失败');

      setBatchMessage(`已入队 ${data.total} 篇文章（任务 #${data.job_id}）`, false);
      startBatchPoll(data.job_id);
    } catch (e) {
      setBatchMessage(e.message || String(e), true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function loadCategories() {
    await loadBatchFeeds().catch((e) => {
      console.error('loadBatchFeeds failed:', e);
    });

    const res = await fetch(`${API_BASE_URL}/admin/classification/categories`, {
      headers: authBearerOnly(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '加载类别列表失败');

    state.categories = data.categories || [];
    refreshCategoryDropdowns();
    setTotalMessage(`共 ${state.categories.length} 个类别`);

    const tbody = document.querySelector('#table-classification tbody');
    if (!tbody) return;

    if (!state.categories.length) {
      tbody.innerHTML =
        '<tr><td colspan="8" style="text-align:center;color:#999;padding:1.5rem;">暂无类别，点击「新建类别」添加</td></tr>';
      return;
    }

    tbody.innerHTML = state.categories
      .map((item) => {
        const proto = item.prototype_ready ? '✓ 就绪' : '—';
        const disableBtn =
          item.status === 'active'
            ? `<button type="button" class="secondary-btn btn-tight btn-classification-disable" data-id="${item.id}">禁用</button>`
            : '';
        return `<tr>
          <td>${item.id}</td>
          <td><code>${esc(item.code)}</code></td>
          <td>${esc(item.name)}</td>
          <td>${statusPill(item.status)}</td>
          <td>${item.example_count ?? 0}</td>
          <td>${proto}</td>
          <td>${colorCell(item.color)}</td>
          <td>
            <button type="button" class="secondary-btn btn-tight btn-classification-edit" data-id="${item.id}">编辑</button>
            ${disableBtn}
          </td>
        </tr>`;
      })
      .join('');
  }

  function renderActiveModel() {
    const body = document.getElementById('classification-active-model-body');
    if (!body) return;

    const model = state.training.activeModel;
    if (!model) {
      body.innerHTML = '<span style="color:#999;">暂无已发布模型（训练完成后可发布版本）</span>';
      return;
    }

    body.innerHTML = `
      <div class="classification-training-metrics">
        <span>版本 <strong>${esc(model.version)}</strong></span>
        <span>状态 <strong style="color:#1e8449;">已发布</strong></span>
        <span>指标 ${esc(formatMetricsSummary(model.metrics))}</span>
        <span>发布时间 ${formatDt(model.created_at)}</span>
      </div>`;
  }

  function renderTrainingJobs() {
    const tbody = document.querySelector('#table-classification-training tbody');
    if (!tbody) return;

    const jobs = state.training.jobs;
    const activeVersion = state.training.activeModel?.version || null;

    if (!jobs.length) {
      tbody.innerHTML =
        '<tr><td colspan="8" style="text-align:center;color:#999;padding:1.5rem;">暂无训练记录</td></tr>';
      return;
    }

    tbody.innerHTML = jobs
      .map((job) => {
        const metricsText = formatMetricsSummary(job.metrics_json);
        const canPublish =
          job.status === 'completed' &&
          job.model_version &&
          job.model_version !== activeVersion;
        const publishBtn = canPublish
          ? `<button type="button" class="primary-btn btn-tight btn-training-publish" data-version="${esc(job.model_version)}">发布版本</button>`
          : job.model_version && job.model_version === activeVersion
            ? '<span style="color:#1e8449;font-size:0.75rem;">当前线上</span>'
            : '';
        const errorHint =
          job.status === 'failed' && job.error_msg
            ? `<div style="color:#c0392b;font-size:0.72rem;margin-top:0.2rem;">${esc(job.error_msg)}</div>`
            : '';
        return `<tr data-job-id="${job.id}">
          <td>${job.id}</td>
          <td>${jobStatusPill(job.status)}${errorHint}</td>
          <td>${job.progress ?? 0}%${job.stage ? `<div style="font-size:0.72rem;color:#888;">${esc(job.stage)}</div>` : ''}</td>
          <td>${esc(job.trigger_reason || '—')}</td>
          <td>${job.model_version ? `<code>${esc(job.model_version)}</code>` : '—'}</td>
          <td>${esc(metricsText)}</td>
          <td>${formatDt(job.finished_at || job.started_at)}</td>
          <td>${publishBtn}</td>
        </tr>`;
      })
      .join('');
  }

  async function loadActiveModel() {
    const res = await fetch(`${API_BASE_URL}/admin/classification/models/active`, {
      headers: authBearerOnly(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '加载当前模型失败');
    state.training.activeModel = data.model || null;
    renderActiveModel();
  }

  async function loadTrainingJobs() {
    const res = await fetch(`${API_BASE_URL}/admin/classification/training/jobs?limit=30`, {
      headers: authBearerOnly(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '加载训练历史失败');
    state.training.jobs = data.jobs || [];
    renderTrainingJobs();
  }

  async function fetchTrainingJob(jobId) {
    const res = await fetch(`${API_BASE_URL}/admin/classification/training/jobs/${jobId}`, {
      headers: authBearerOnly(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '获取训练进度失败');
    return data.job;
  }

  function updateJobInList(job) {
    const idx = state.training.jobs.findIndex((item) => item.id === job.id);
    if (idx >= 0) {
      state.training.jobs[idx] = job;
    } else {
      state.training.jobs.unshift(job);
    }
    renderTrainingJobs();
  }

  function startTrainingPoll(jobId) {
    stopTrainingPoll();
    state.training.pollingJobId = jobId;

    const pollOnce = async () => {
      try {
        const job = await fetchTrainingJob(jobId);
        updateJobInList(job);

        const stageLabel = job.stage ? ` — ${job.stage}` : '';
        setTrainingProgressVisible(
          job.status === 'pending' || job.status === 'running',
          job.progress,
          `任务 #${job.id}：${job.status}${stageLabel}（${job.progress ?? 0}%）`,
        );

        if (job.status === 'completed') {
          stopTrainingPoll();
          setTrainingProgressVisible(false, 100, '');
          setTrainingMessage(`训练完成，模型版本 ${job.model_version || '—'}`, false);
          await loadActiveModel();
          return;
        }

        if (job.status === 'failed') {
          stopTrainingPoll();
          setTrainingProgressVisible(false, job.progress, '');
          setTrainingMessage(job.error_msg || '训练失败', true);
        }
      } catch (e) {
        stopTrainingPoll();
        setTrainingProgressVisible(false, 0, '');
        setTrainingMessage(e.message || String(e), true);
      }
    };

    pollOnce();
    state.training.pollTimer = setInterval(pollOnce, TRAINING_POLL_MS);
  }

  async function startTraining() {
    const btn = document.getElementById('classification-training-start-btn');
    if (btn) btn.disabled = true;
    setTrainingMessage('正在启动训练…', false);

    try {
      const res = await fetch(`${API_BASE_URL}/admin/classification/training/start`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ trigger_reason: 'manual' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '启动训练失败');

      const job = data.job;
      updateJobInList(job);
      setTrainingMessage(`训练任务 #${job.id} 已入队`, false);
      startTrainingPoll(job.id);
    } catch (e) {
      setTrainingMessage(e.message || String(e), true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function publishModelVersion(version) {
    if (!version) return;
    if (!confirm(`确定发布模型版本「${version}」为线上模型？`)) return;

    setTrainingMessage(`正在发布 ${version}…`, false);
    try {
      const res = await fetch(`${API_BASE_URL}/admin/classification/models/active`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ version }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '发布失败');

      state.training.activeModel = data.model || null;
      renderActiveModel();
      renderTrainingJobs();
      setTrainingMessage(`已发布模型版本 ${version}`, false);
    } catch (e) {
      setTrainingMessage(e.message || String(e), true);
    }
  }

  function formatRate(value) {
    if (value == null || Number.isNaN(Number(value))) return '—';
    return `${(Number(value) * 100).toFixed(1)}%`;
  }

  function setReportsMessage(text, isError) {
    const el = document.getElementById('classification-reports-msg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('error', 'ok');
    if (text) el.classList.add(isError ? 'error' : 'ok');
  }

  function renderClassificationReport(report) {
    state.report = report;
    const overviewBody = document.getElementById('classification-reports-overview-body');
    const accuracySummary = document.getElementById('classification-reports-accuracy-summary');
    const articleTbody = document.querySelector('#table-classification-article-counts tbody');
    const sampleTbody = document.querySelector('#table-classification-accuracy-sample tbody');

    if (!report) {
      if (overviewBody) overviewBody.textContent = '暂无数据';
      return;
    }

    const ov = report.overview || {};
    if (overviewBody) {
      overviewBody.innerHTML = `
        <div class="classification-training-metrics">
          <span>文章总数 <strong>${ov.total_articles ?? 0}</strong></span>
          <span>已 AI 分类 <strong>${ov.total_classified ?? 0}</strong></span>
          <span>未分类 <strong>${ov.unclassified_count ?? 0}</strong></span>
          <span>待审核 <strong>${ov.pending_review_count ?? 0}</strong></span>
          <span>人工标注 <strong>${ov.annotated_total ?? 0}</strong>（今日 ${ov.annotated_today ?? 0}）</span>
          <span>线上模型 <strong>${esc(ov.active_model_version || '—')}</strong></span>
          <span>模型准确率 <strong>${formatRate(ov.active_model_accuracy)}</strong></span>
          <span>Macro F1 <strong>${formatRate(ov.active_model_macro_f1)}</strong></span>
        </div>`;
    }

    const annotationMap = new Map(
      (report.annotation_by_category || []).map((row) => [row.category_id, row.annotation_count]),
    );

    if (articleTbody) {
      const rows = report.article_counts || [];
      if (!rows.length) {
        articleTbody.innerHTML =
          '<tr><td colspan="5" style="text-align:center;color:#999;padding:1.5rem;">暂无分类数据</td></tr>';
      } else {
        articleTbody.innerHTML = rows
          .map((row) => {
            const ann = row.category_id == null ? '—' : annotationMap.get(row.category_id) ?? 0;
            return `<tr>
              <td>${row.category_id == null ? esc(row.name) : `${colorCell(row.color)}${esc(row.name)}`}</td>
              <td>${row.code ? `<code>${esc(row.code)}</code>` : '—'}</td>
              <td>${row.article_count ?? 0}</td>
              <td>${row.need_review_count ?? 0}</td>
              <td>${ann}</td>
            </tr>`;
          })
          .join('');
      }
    }

    const sample = report.accuracy_sample || {};
    if (accuracySummary) {
      accuracySummary.textContent =
        sample.sample_size > 0
          ? `抽样 ${sample.sample_size} 条：一致 ${sample.agreement_count}，纠错 ${sample.corrected_count}，一致率 ${formatRate(sample.agreement_rate)}（source≠corrected 视为 AI 与人工一致）`
          : '暂无标注数据，无法抽样评估';
    }

    if (sampleTbody) {
      const items = sample.items || [];
      if (!items.length) {
        sampleTbody.innerHTML =
          '<tr><td colspan="7" style="text-align:center;color:#999;padding:1.5rem;">暂无抽样数据</td></tr>';
      } else {
        sampleTbody.innerHTML = items
          .map((item) => {
            const matchText = item.ai_match
              ? '<span style="color:#1e8449;">是</span>'
              : '<span style="color:#c0392b;">否</span>';
            const aiName = item.ai_category_name || '—';
            return `<tr>
              <td>${esc(item.title)}</td>
              <td>${esc(item.human_category_name)}</td>
              <td>${esc(aiName)}</td>
              <td>${formatConfidence(item.confidence)}</td>
              <td>${matchText}</td>
              <td><code>${esc(item.annotation_source || '—')}</code></td>
              <td>${formatDt(item.annotated_at)}</td>
            </tr>`;
          })
          .join('');
      }
    }
  }

  async function loadReportsPanel() {
    const sampleSizeRaw = document.getElementById('classification-reports-sample-size')?.value || '50';
    const sampleSize = Number(sampleSizeRaw);
    const params = new URLSearchParams();
    if (Number.isFinite(sampleSize) && sampleSize > 0) {
      params.set('sample_size', String(sampleSize));
    }

    setReportsMessage('加载中…', false);
    try {
      const res = await fetch(
        `${API_BASE_URL}/admin/classification/reports/classification?${params.toString()}`,
        { headers: authBearerOnly() },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '加载统计报表失败');
      renderClassificationReport(data.report);
      setReportsMessage('已刷新', false);
    } catch (e) {
      renderClassificationReport(null);
      setReportsMessage(e.message || String(e), true);
    }
  }

  async function loadTrainingPanel() {
    await Promise.all([loadActiveModel(), loadTrainingJobs()]);

    const runningJob = state.training.jobs.find(
      (job) => job.status === 'pending' || job.status === 'running',
    );
    if (runningJob && state.training.pollingJobId !== runningJob.id) {
      startTrainingPoll(runningJob.id);
    } else if (!runningJob) {
      stopTrainingPoll();
      setTrainingProgressVisible(false, 0, '');
    }
  }

  async function loadClassificationPanel() {
    switchClassificationTab(state.activeTab);
    if (state.activeTab === 'pending') {
      await loadPending();
    } else if (state.activeTab === 'training') {
      await loadTrainingPanel();
    } else if (state.activeTab === 'reports') {
      await loadReportsPanel();
    } else {
      await loadCategories();
    }
  }

  function openCreateModal() {
    state.editingId = null;
    document.getElementById('classification-modal-title').textContent = '新建类别';
    document.getElementById('classification-edit-id').value = '';
    document.getElementById('classification-edit-code').value = '';
    document.getElementById('classification-edit-code').disabled = false;
    document.getElementById('classification-edit-name').value = '';
    document.getElementById('classification-edit-description').value = '';
    document.getElementById('classification-edit-color').value = '';
    document.getElementById('classification-edit-examples').value = '';
    setFormMessage('');
    openModal(document.getElementById('classification-edit-modal'));
  }

  function openEditModal(id) {
    const item = state.categories.find((c) => c.id === id);
    if (!item) return;

    state.editingId = id;
    document.getElementById('classification-modal-title').textContent = `编辑类别 — ${item.name}`;
    document.getElementById('classification-edit-id').value = String(id);
    document.getElementById('classification-edit-code').value = item.code || '';
    document.getElementById('classification-edit-code').disabled = false;
    document.getElementById('classification-edit-name').value = item.name || '';
    document.getElementById('classification-edit-description').value = item.description || '';
    document.getElementById('classification-edit-color').value = item.color || '';
    document.getElementById('classification-edit-examples').value = '';
    setFormMessage('示例标题需重新填写才会替换；留空则保留现有示例。');
    openModal(document.getElementById('classification-edit-modal'));
  }

  async function saveCategory() {
    const code = document.getElementById('classification-edit-code').value.trim();
    const name = document.getElementById('classification-edit-name').value.trim();
    const description = document.getElementById('classification-edit-description').value.trim();
    const color = document.getElementById('classification-edit-color').value.trim();
    const examplesText = document.getElementById('classification-edit-examples').value;
    const examples = parseExamplesText(examplesText);

    if (!code || !name) {
      setFormMessage('Code 与名称为必填项', true);
      return;
    }

    setFormMessage('保存中…', false);

    try {
      if (state.editingId == null) {
        const body = { code, name };
        if (description) body.description = description;
        if (color) body.color = color;
        if (examples.length) body.examples = examples;

        const res = await fetch(`${API_BASE_URL}/admin/classification/categories`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '创建失败');
      } else {
        const body = { code, name };
        body.description = description || null;
        body.color = color || null;
        if (examples.length) body.examples = examples;

        const res = await fetch(
          `${API_BASE_URL}/admin/classification/categories/${state.editingId}`,
          {
            method: 'PATCH',
            headers: authHeaders(),
            body: JSON.stringify(body),
          },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '更新失败');
      }

      closeModal(document.getElementById('classification-edit-modal'));
      await loadCategories();
      await ensureCategoriesLoaded();
    } catch (e) {
      setFormMessage(e.message || String(e), true);
    }
  }

  async function disableCategory(id) {
    const item = state.categories.find((c) => c.id === id);
    if (!item) return;
    if (!confirm(`确定禁用类别「${item.name}」(${item.code})？`)) return;

    const res = await fetch(`${API_BASE_URL}/admin/classification/categories/${id}`, {
      method: 'DELETE',
      headers: authBearerOnly(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '禁用失败');
    await loadCategories();
    await ensureCategoriesLoaded();
  }

  function bindEvents() {
    document.querySelectorAll('.classification-tab-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tab = btn.getAttribute('data-classification-tab') || 'pending';
        state.activeTab = tab;
        switchClassificationTab(tab);
        try {
          if (tab === 'pending') await loadPending();
          else if (tab === 'training') await loadTrainingPanel();
          else if (tab === 'reports') await loadReportsPanel();
          else await loadCategories();
        } catch (e) {
          alert(e.message || String(e));
        }
      });
    });

    document.getElementById('classification-training-start-btn')?.addEventListener('click', async () => {
      try {
        await startTraining();
      } catch (e) {
        alert(e.message || String(e));
      }
    });

    document.getElementById('classification-training-refresh-btn')?.addEventListener('click', async () => {
      try {
        await loadTrainingPanel();
        setTrainingMessage('已刷新', false);
      } catch (e) {
        alert(e.message || String(e));
      }
    });

    document.querySelector('#table-classification-training tbody')?.addEventListener('click', async (e) => {
      const publishBtn = e.target.closest('.btn-training-publish');
      if (!publishBtn) return;
      try {
        await publishModelVersion(publishBtn.getAttribute('data-version'));
      } catch (err) {
        alert(err.message || String(err));
      }
    });

    document.getElementById('classification-pending-refresh-btn')?.addEventListener('click', async () => {
      try {
        await loadPending();
      } catch (e) {
        alert(e.message || String(e));
      }
    });

    ['classification-pending-need-review', 'classification-pending-conf-min', 'classification-pending-conf-max'].forEach(
      (id) => {
        document.getElementById(id)?.addEventListener('change', async () => {
          try {
            await loadPending();
          } catch (e) {
            alert(e.message || String(e));
          }
        });
      },
    );

    document.getElementById('classification-pending-select-all')?.addEventListener('change', (e) => {
      const checked = e.target.checked;
      document.querySelectorAll('.classification-pending-check').forEach((cb) => {
        cb.checked = checked;
        const id = Number(cb.getAttribute('data-id'));
        if (checked) state.selectedPending.add(id);
        else state.selectedPending.delete(id);
      });
    });

    document.querySelector('#table-classification-pending tbody')?.addEventListener('change', (e) => {
      const cb = e.target.closest('.classification-pending-check');
      if (!cb) return;
      const id = Number(cb.getAttribute('data-id'));
      if (cb.checked) state.selectedPending.add(id);
      else state.selectedPending.delete(id);
    });

    document.querySelector('#table-classification-pending tbody')?.addEventListener('click', async (e) => {
      const annotateBtn = e.target.closest('.btn-pending-annotate');
      if (!annotateBtn) return;
      const articleId = Number(annotateBtn.getAttribute('data-id'));
      const select = document.querySelector(`.pending-row-category[data-id="${articleId}"]`);
      const categoryId = select?.value;
      try {
        await annotateArticles([articleId], categoryId);
      } catch (err) {
        alert(err.message || String(err));
      }
    });

    document.getElementById('classification-pending-batch-btn')?.addEventListener('click', async () => {
      const categoryId = document.getElementById('classification-pending-batch-category')?.value;
      const checkedIds = [...document.querySelectorAll('.classification-pending-check:checked')].map((cb) =>
        Number(cb.getAttribute('data-id')),
      );
      const ids = checkedIds.length ? checkedIds : [...state.selectedPending];
      try {
        await annotateArticles(ids, categoryId);
      } catch (err) {
        alert(err.message || String(err));
      }
    });

    document.getElementById('classification-create-btn')?.addEventListener('click', openCreateModal);
    document.getElementById('classification-refresh-btn')?.addEventListener('click', async () => {
      try {
        await loadCategories();
      } catch (e) {
        alert(e.message || String(e));
      }
    });

    document.getElementById('classification-reports-refresh-btn')?.addEventListener('click', async () => {
      try {
        await loadReportsPanel();
      } catch (e) {
        alert(e.message || String(e));
      }
    });

    document.getElementById('classification-batch-btn')?.addEventListener('click', async () => {
      if (!confirm('确定提交批量分类补跑任务？大量文章可能耗时较长。')) return;
      try {
        await startBatchClassification();
      } catch (e) {
        alert(e.message || String(e));
      }
    });

    document.getElementById('classification-edit-save')?.addEventListener('click', saveCategory);
    document.getElementById('classification-edit-cancel')?.addEventListener('click', () => {
      closeModal(document.getElementById('classification-edit-modal'));
    });
    document.getElementById('classification-edit-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'classification-edit-modal') {
        closeModal(document.getElementById('classification-edit-modal'));
      }
    });

    document.querySelector('#table-classification tbody')?.addEventListener('click', async (e) => {
      const editBtn = e.target.closest('.btn-classification-edit');
      const disableBtn = e.target.closest('.btn-classification-disable');
      if (editBtn) {
        openEditModal(Number(editBtn.getAttribute('data-id')));
        return;
      }
      if (disableBtn) {
        try {
          await disableCategory(Number(disableBtn.getAttribute('data-id')));
        } catch (err) {
          alert(err.message || String(err));
        }
      }
    });
  }

  window.loadClassificationCategories = loadCategories;
  window.loadClassificationPanel = loadClassificationPanel;

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
  });
})();

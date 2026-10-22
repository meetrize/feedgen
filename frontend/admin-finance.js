/**
 * Admin — 金融产品词典
 * 依赖：config.js (API_BASE_URL)、admin.js 登录态 (feedgen_admin_token)
 */
(function () {
  const TOKEN_KEY = 'feedgen_admin_token';
  const PAGE_SIZE = 50;

  const state = {
    offset: 0,
    total: 0,
    aliasInstrumentId: null,
  };

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

  function setMsg(text, isError) {
    const el = document.getElementById('finance-action-msg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('error', 'ok');
    if (text) el.classList.add(isError ? 'error' : 'ok');
  }

  async function api(path, options) {
    const res = await fetch(`${API_BASE_URL}/admin/finance${path}`, {
      ...options,
      headers: { ...authHeaders(), ...(options && options.headers) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }

  async function loadOverview() {
    const data = await api('/overview');
    const el = document.getElementById('finance-overview');
    if (!el) return;
    const markets = (data.by_market || [])
      .map((m) => `${m.market}:${m.count}`)
      .join(' · ');
    const last = data.last_job
      ? `${data.last_job.status} @ ${formatDt(data.last_job.finished_at || data.last_job.created_at)}`
      : '尚无同步';
    el.innerHTML = `
      <span>产品 <strong>${data.instrument_count ?? 0}</strong></span>
      <span>启用别名 <strong>${data.alias_count ?? 0}</strong></span>
      <span>${esc(markets)}</span>
      <span>最近同步：${esc(last)}</span>
      <span>匹配 ${data.match_enabled ? '开' : '关'} / 定时同步 ${data.sync_enabled ? '开' : '关'}</span>
    `;
  }

  async function loadInstruments() {
    const q = document.getElementById('finance-search-q')?.value.trim() || '';
    const market = document.getElementById('finance-filter-market')?.value || '';
    const status = document.getElementById('finance-filter-status')?.value || '';
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(state.offset),
    });
    if (q) params.set('q', q);
    if (market) params.set('market', market);
    if (status) params.set('status', status);

    const data = await api(`/instruments?${params}`);
    state.total = data.total || 0;
    const tbody = document.querySelector('#table-finance-instruments tbody');
    if (!tbody) return;
    tbody.innerHTML = (data.instruments || [])
      .map((it) => {
        return `<tr>
          <td>${it.id}</td>
          <td>${esc(it.name)}</td>
          <td><code>${esc(it.symbol)}</code></td>
          <td><code>${esc(it.chart_symbol)}</code></td>
          <td>${esc(it.market)}</td>
          <td>${esc(it.asset_type)}</td>
          <td>${esc(it.status)}</td>
          <td>${it.alias_count ?? 0}</td>
          <td style="white-space:nowrap;">
            <button type="button" class="secondary-btn finance-edit-btn" data-id="${it.id}" style="font-size:0.75rem;padding:0.2rem 0.4rem;">编辑</button>
            <button type="button" class="secondary-btn finance-alias-btn" data-id="${it.id}" data-name="${esc(it.name)}" style="font-size:0.75rem;padding:0.2rem 0.4rem;">别名</button>
            <button type="button" class="secondary-btn finance-toggle-btn" data-id="${it.id}" data-status="${esc(it.status)}" style="font-size:0.75rem;padding:0.2rem 0.4rem;">${it.status === 'active' ? '禁用' : '启用'}</button>
          </td>
        </tr>`;
      })
      .join('');

    const info = document.getElementById('finance-page-info');
    if (info) {
      info.textContent = `共 ${state.total} 条，当前 ${state.offset + 1}-${Math.min(state.offset + PAGE_SIZE, state.total)}`;
    }

    tbody.querySelectorAll('.finance-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => openEdit(Number(btn.dataset.id), data.instruments));
    });
    tbody.querySelectorAll('.finance-alias-btn').forEach((btn) => {
      btn.addEventListener('click', () => openAliases(Number(btn.dataset.id), btn.dataset.name));
    });
    tbody.querySelectorAll('.finance-toggle-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.id);
        const next = btn.dataset.status === 'active' ? 'disabled' : 'active';
        try {
          await api(`/instruments/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: next }),
          });
          await loadInstruments();
          await loadOverview();
        } catch (e) {
          alert(e.message);
        }
      });
    });
  }

  async function loadJobs() {
    const data = await api('/sync/jobs?limit=15');
    const tbody = document.querySelector('#table-finance-jobs tbody');
    if (!tbody) return;
    tbody.innerHTML = (data.jobs || [])
      .map((j) => {
        return `<tr>
          <td>${j.id}</td>
          <td>${esc(j.status)}</td>
          <td>${esc(j.mode)}</td>
          <td>${esc(j.trigger)}</td>
          <td>${esc(j.source || '')}</td>
          <td>${j.fetched_count}/${j.created_count}/${j.updated_count}</td>
          <td>${formatDt(j.finished_at || j.created_at)}</td>
          <td>${esc((j.error_msg || '').slice(0, 80))}</td>
        </tr>`;
      })
      .join('');
  }

  async function loadSettings() {
    const data = await api('/settings');
    const s = data.settings || {};
    const t = document.getElementById('finance-setting-template');
    const p = document.getElementById('finance-setting-period');
    const m = document.getElementById('finance-setting-max-chips');
    if (t) t.value = s.kline_url_template || '';
    if (p) p.value = s.kline_default_period || '1d';
    if (m) m.value = s.max_chips ?? 5;
  }

  function openEdit(id, list) {
    const modal = document.getElementById('finance-edit-modal');
    const it = (list || []).find((x) => x.id === id);
    document.getElementById('finance-edit-title').textContent = id ? '编辑产品' : '新建产品';
    document.getElementById('finance-edit-id').value = id || '';
    document.getElementById('finance-edit-name').value = it?.name || '';
    document.getElementById('finance-edit-symbol').value = it?.symbol || '';
    document.getElementById('finance-edit-symbol').disabled = !!id;
    document.getElementById('finance-edit-chart').value = it?.chart_symbol || '';
    document.getElementById('finance-edit-market').value = it?.market || 'cn';
    document.getElementById('finance-edit-market').disabled = !!id;
    document.getElementById('finance-edit-asset').value = it?.asset_type || 'stock';
    document.getElementById('finance-edit-status').value = it?.status || 'active';
    document.getElementById('finance-edit-priority').value = it?.priority ?? 100;
    document.getElementById('finance-edit-msg').textContent = '';
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeEdit() {
    const modal = document.getElementById('finance-edit-modal');
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  async function openAliases(instrumentId, name) {
    state.aliasInstrumentId = instrumentId;
    document.getElementById('finance-alias-title').textContent = `别名 — ${name || instrumentId}`;
    document.getElementById('finance-alias-msg').textContent = '';
    await refreshAliases();
    const modal = document.getElementById('finance-alias-modal');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  }

  async function refreshAliases() {
    const id = state.aliasInstrumentId;
    if (!id) return;
    const data = await api(`/instruments/${id}/aliases`);
    const tbody = document.querySelector('#table-finance-aliases tbody');
    tbody.innerHTML = (data.aliases || [])
      .map((a) => {
        return `<tr>
          <td>${esc(a.keyword)}</td>
          <td>${esc(a.kind)}</td>
          <td>${a.enabled ? '是' : '否'}</td>
          <td>${esc(a.source)}</td>
          <td>
            <button type="button" class="secondary-btn finance-alias-toggle" data-id="${a.id}" data-enabled="${a.enabled}" style="font-size:0.75rem;padding:0.2rem 0.4rem;">${a.enabled ? '禁用' : '启用'}</button>
            <button type="button" class="secondary-btn finance-alias-del" data-id="${a.id}" style="font-size:0.75rem;padding:0.2rem 0.4rem;">删除</button>
          </td>
        </tr>`;
      })
      .join('');

    tbody.querySelectorAll('.finance-alias-toggle').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/instruments/${id}/aliases/${btn.dataset.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: btn.dataset.enabled !== 'true' }),
          });
          await refreshAliases();
        } catch (e) {
          alert(e.message);
        }
      });
    });
    tbody.querySelectorAll('.finance-alias-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('确定删除该别名？')) return;
        try {
          await api(`/instruments/${id}/aliases/${btn.dataset.id}`, { method: 'DELETE' });
          await refreshAliases();
        } catch (e) {
          alert(e.message);
        }
      });
    });
  }

  function closeAliases() {
    const modal = document.getElementById('finance-alias-modal');
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    state.aliasInstrumentId = null;
  }

  async function loadFinancePanel() {
    await Promise.all([loadOverview(), loadInstruments(), loadJobs(), loadSettings()]);
  }

  window.loadFinancePanel = loadFinancePanel;

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('finance-refresh-btn')?.addEventListener('click', () => {
      loadFinancePanel().catch((e) => setMsg(e.message, true));
    });
    document.getElementById('finance-search-btn')?.addEventListener('click', () => {
      state.offset = 0;
      loadInstruments().catch((e) => setMsg(e.message, true));
    });
    document.getElementById('finance-prev')?.addEventListener('click', () => {
      state.offset = Math.max(0, state.offset - PAGE_SIZE);
      loadInstruments().catch((e) => setMsg(e.message, true));
    });
    document.getElementById('finance-next')?.addEventListener('click', () => {
      if (state.offset + PAGE_SIZE < state.total) {
        state.offset += PAGE_SIZE;
        loadInstruments().catch((e) => setMsg(e.message, true));
      }
    });
    document.getElementById('finance-sync-btn')?.addEventListener('click', async () => {
      try {
        setMsg('同步已入队…');
        await api('/sync', {
          method: 'POST',
          body: JSON.stringify({ mode: 'full', include_funds: false, rematch_days: 3 }),
        });
        setMsg('同步任务已提交，稍后刷新查看日志', false);
        setTimeout(() => loadJobs().catch(() => {}), 2000);
      } catch (e) {
        setMsg(e.message, true);
      }
    });
    document.getElementById('finance-init-btn')?.addEventListener('click', async () => {
      if (!confirm('将同步 A/港/美股 + 基金（可能较久），确定？')) return;
      try {
        setMsg('初始化同步已入队…');
        await api('/sync', {
          method: 'POST',
          body: JSON.stringify({ mode: 'full', include_funds: true, rematch_days: 7 }),
        });
        setMsg('初始化任务已提交', false);
      } catch (e) {
        setMsg(e.message, true);
      }
    });
    document.getElementById('finance-reload-index-btn')?.addEventListener('click', async () => {
      try {
        const r = await api('/match/reload-index', { method: 'POST', body: '{}' });
        setMsg(`索引已重载，patterns=${r.patterns}`, false);
      } catch (e) {
        setMsg(e.message, true);
      }
    });
    document.getElementById('finance-backfill-btn')?.addEventListener('click', async () => {
      try {
        setMsg('重匹配中…');
        const since = new Date(Date.now() - 7 * 86400000).toISOString();
        const r = await api('/match/backfill', {
          method: 'POST',
          body: JSON.stringify({ since, limit: 2000 }),
        });
        setMsg(`已处理 ${r.processed} 篇，命中 ${r.matched_articles} 篇`, false);
      } catch (e) {
        setMsg(e.message, true);
      }
    });
    document.getElementById('finance-create-btn')?.addEventListener('click', () => openEdit(0, []));
    document.getElementById('finance-edit-cancel')?.addEventListener('click', closeEdit);
    document.getElementById('finance-edit-save')?.addEventListener('click', async () => {
      const id = document.getElementById('finance-edit-id').value;
      const body = {
        name: document.getElementById('finance-edit-name').value.trim(),
        chart_symbol: document.getElementById('finance-edit-chart').value.trim(),
        asset_type: document.getElementById('finance-edit-asset').value,
        status: document.getElementById('finance-edit-status').value,
        priority: Number(document.getElementById('finance-edit-priority').value) || 100,
      };
      try {
        if (id) {
          await api(`/instruments/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
        } else {
          await api('/instruments', {
            method: 'POST',
            body: JSON.stringify({
              ...body,
              symbol: document.getElementById('finance-edit-symbol').value.trim(),
              market: document.getElementById('finance-edit-market').value,
            }),
          });
        }
        closeEdit();
        await loadInstruments();
        await loadOverview();
      } catch (e) {
        const msg = document.getElementById('finance-edit-msg');
        if (msg) {
          msg.textContent = e.message;
          msg.classList.add('error');
        }
      }
    });
    document.getElementById('finance-alias-close')?.addEventListener('click', closeAliases);
    document.getElementById('finance-alias-add')?.addEventListener('click', async () => {
      const id = state.aliasInstrumentId;
      const keyword = document.getElementById('finance-alias-keyword').value.trim();
      const kind = document.getElementById('finance-alias-kind').value;
      if (!id || !keyword) return;
      try {
        await api(`/instruments/${id}/aliases`, {
          method: 'POST',
          body: JSON.stringify({ keyword, kind }),
        });
        document.getElementById('finance-alias-keyword').value = '';
        await refreshAliases();
      } catch (e) {
        const msg = document.getElementById('finance-alias-msg');
        if (msg) {
          msg.textContent = e.message;
          msg.classList.add('error');
        }
      }
    });
    document.getElementById('finance-settings-save')?.addEventListener('click', async () => {
      try {
        await api('/settings', {
          method: 'PUT',
          body: JSON.stringify({
            kline_url_template: document.getElementById('finance-setting-template').value.trim(),
            kline_default_period: document.getElementById('finance-setting-period').value.trim(),
            max_chips: Number(document.getElementById('finance-setting-max-chips').value) || 5,
          }),
        });
        setMsg('设置已保存', false);
      } catch (e) {
        setMsg(e.message, true);
      }
    });
  });
})();

let strategyItems = [];

function authHeaders() {
  const token = localStorage.getItem('anonymousUserToken');
  if (!token) return null;
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function authBearerOnly() {
  const token = localStorage.getItem('anonymousUserToken');
  if (!token) return null;
  return { Authorization: `Bearer ${token}` };
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function formatSeconds(seconds) {
  const n = Number(seconds || 0);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 3600) return `${Math.round(n / 60)} 分钟`;
  if (n < 86400) return `${Math.round(n / 3600)} 小时`;
  return `${Math.round(n / 86400)} 天`;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
}

function showMsg(text, isError) {
  const el = document.getElementById('strategy-msg');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
  el.classList.toggle('ok', !isError && !!text);
}

function statusBadge(item) {
  const status = item.stats?.last_status || '—';
  const anti = item.anti_bot_status || 'normal';
  const failureMessage = item.stats?.last_failure_message || '';
  const failureReason = item.stats?.last_failure_reason || '';
  const tipText = failureMessage || (failureReason && failureReason !== '—' ? failureReason : '');

  let badgeHtml;
  let showTip = false;
  if (anti !== 'normal') {
    badgeHtml = `<span class="strategy-badge strategy-badge--warn">${escapeHtml(anti)}</span>`;
    showTip = !!tipText;
  } else if (status === 'success') {
    badgeHtml = '<span class="strategy-badge strategy-badge--ok">成功</span>';
  } else if (status === 'failed') {
    badgeHtml = '<span class="strategy-badge strategy-badge--bad">失败</span>';
    showTip = !!tipText;
  } else {
    badgeHtml = '<span class="strategy-badge">—</span>';
  }

  if (showTip) {
    return `<span class="strategy-status-tip" data-failure-tip="${escapeHtml(tipText)}" tabindex="0">${badgeHtml}</span>`;
  }
  return badgeHtml;
}

function isCooldown(item) {
  const raw = item.strategy?.cooldown_until;
  return raw && new Date(raw).getTime() > Date.now();
}

function filteredItems() {
  const filter = document.getElementById('strategy-filter')?.value || 'all';
  return strategyItems.filter((item) => {
    if (filter === 'risk') return item.anti_bot_status !== 'normal' || item.stats?.failed_count > 0;
    if (filter === 'cooldown') return isCooldown(item);
    if (filter === 'parsed') return item.source_type === 'parsed';
    if (filter === 'native') return item.source_type === 'native';
    return true;
  });
}

function updateKpis() {
  const total = strategyItems.length;
  const risk = strategyItems.filter((item) => item.anti_bot_status !== 'normal' || isCooldown(item)).length;
  const rates = strategyItems.map((item) => item.stats?.success_rate).filter((n) => typeof n === 'number');
  const avg = rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : null;
  document.getElementById('kpi-total').textContent = String(total);
  document.getElementById('kpi-risk').textContent = String(risk);
  document.getElementById('kpi-success').textContent = avg == null ? '—' : `${avg}%`;
}

function renderTable() {
  const tbody = document.getElementById('strategy-tbody');
  const empty = document.getElementById('strategy-empty');
  if (!tbody || !empty) return;
  const items = filteredItems();
  empty.classList.toggle('hidden', items.length > 0);
  tbody.innerHTML = items.map((item) => {
    const recommended = item.strategy?.recommended_interval || item.stats?.recommended_interval || item.current_interval;
    const cooldown = item.strategy?.cooldown_until;
    const cooldownValue = cooldown ? new Date(cooldown).toISOString().slice(0, 16) : '';
    return `
      <tr data-feed-id="${item.id}">
        <td>
          <div class="strategy-cell-inline">
            <span class="strategy-feed-title">${escapeHtml(item.title || `Feed ${item.id}`)}</span>
            <span class="strategy-feed-url">${escapeHtml(item.url || '')}</span>
          </div>
        </td>
        <td>${item.source_type === 'parsed' ? '可视化' : '原生 RSS'}</td>
        <td>
          <div class="strategy-cell-inline">
            <input class="my-feeds-input strategy-interval-input" type="number" min="60" max="604800" step="60" value="${Number(item.current_interval || 1800)}">
            <span class="strategy-hint">${formatSeconds(item.current_interval)}</span>
          </div>
        </td>
        <td>
          <div class="strategy-cell-inline">
            <strong>${formatSeconds(recommended)}</strong>
            <span class="strategy-hint">${recommended} 秒</span>
          </div>
        </td>
        <td>
          <div class="strategy-cell-inline">
            <span>${item.stats?.success_rate == null ? '—' : `${item.stats.success_rate}%`}</span>
            <span class="strategy-hint">${item.stats?.success_count || 0}/${item.stats?.total_runs || 0}</span>
          </div>
        </td>
        <td>
          <div class="strategy-cell-inline">
            ${statusBadge(item)}
            <span class="strategy-hint">${formatDate(item.stats?.last_finished_at)}</span>
          </div>
        </td>
        <td>
          <div class="strategy-cell-inline">
            <input class="my-feeds-input strategy-cooldown-input" type="datetime-local" value="${cooldownValue}">
            <span class="strategy-hint">${isCooldown(item) ? '冷却中' : '未冷却'}</span>
          </div>
        </td>
        <td class="strategy-actions">
          <button type="button" class="strategy-btn strategy-crawl" data-id="${item.id}">爬取</button>
          <button type="button" class="strategy-btn strategy-apply-recommended" data-id="${item.id}" data-recommended="${recommended}">推荐</button>
          <button type="button" class="strategy-btn strategy-btn--primary strategy-save" data-id="${item.id}">保存</button>
          <button type="button" class="strategy-btn strategy-cookie-btn" data-id="${item.id}" data-url="${escapeHtml(item.url || '')}" data-title="${escapeHtml(item.title || '')}">Cookie</button>
          <button type="button" class="strategy-btn edit-feed-btn" data-id="${item.id}">编辑</button>
          <button type="button" class="strategy-btn strategy-btn--danger del-feed-btn" data-id="${item.id}">删除</button>
        </td>
      </tr>
    `;
  }).join('');

  // 直接绑定 cookie 按钮事件
  tbody.querySelectorAll('.strategy-cookie-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      const url = btn.dataset.url || btn.getAttribute('data-url') || '';
      const title = btn.dataset.title || btn.getAttribute('data-title') || '';
      openCookieModal(id, url, title);
    });
  });

  tbody.querySelectorAll('.edit-feed-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      const feed = FeedEdit.findFeed(id);
      if (feed) FeedEdit.open(feed);
      else showMsg('未找到 Feed 详情，请刷新后重试', true);
    });
  });

  tbody.querySelectorAll('.del-feed-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      await FeedEdit.deleteFeed(id);
    });
  });
}

async function loadStrategies() {
  const headers = authHeaders();
  const authMsg = document.getElementById('strategy-auth-msg');
  if (!headers) {
    authMsg?.classList.remove('hidden');
    strategyItems = [];
    updateKpis();
    renderTable();
    return;
  }
  authMsg?.classList.add('hidden');
  showMsg('加载中...');
  try {
    const headers = authHeaders();
    const [res] = await Promise.all([
      fetch(`${API_BASE_URL}/crawler-strategies`, { headers }),
      FeedEdit.loadData().catch(() => null),
    ]);
    if (!res.ok) throw new Error(`加载失败：${res.status}`);
    const data = await res.json();
    strategyItems = data.items || [];
    updateKpis();
    renderTable();
    showMsg(`已加载 ${strategyItems.length} 个 Feed 策略`);
  } catch (error) {
    showMsg(error.message || String(error), true);
  }
}

async function saveStrategy(feedId, applyRecommended) {
  const row = document.querySelector(`tr[data-feed-id="${feedId}"]`);
  if (!row) return;
  const headers = authHeaders();
  if (!headers) return showMsg('请先登录', true);
  const intervalInput = row.querySelector('.strategy-interval-input');
  const cooldownInput = row.querySelector('.strategy-cooldown-input');
  const body = {
    update_interval: Number(intervalInput.value),
    strategy_mode: cooldownInput.value ? 'cooldown' : 'manual',
    cooldown_until: cooldownInput.value ? new Date(cooldownInput.value).toISOString() : null,
  };
  if (applyRecommended) {
    body.recommended_interval = Number(row.querySelector('.strategy-apply-recommended').dataset.recommended);
    body.apply_recommended = true;
  }
  try {
    const res = await fetch(`${API_BASE_URL}/crawler-strategies/${feedId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `保存失败：${res.status}`);
    showMsg('保存成功');
    await loadStrategies();
  } catch (error) {
    showMsg(error.message || String(error), true);
  }
}

async function triggerCrawl(feedId) {
  const headers = authBearerOnly();
  if (!headers) return showMsg('请先登录', true);
  const btn = document.querySelector(`.strategy-crawl[data-id="${feedId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '爬取中…'; }
  try {
    const res = await fetch(`${API_BASE_URL}/crawler-strategies/${feedId}/crawl`, {
      method: 'POST',
      headers,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `爬取失败：${res.status}`);
    showMsg(`爬取已触发（模式：${data.mode}）`);
    await loadStrategies();
  } catch (error) {
    showMsg(error.message || String(error), true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '爬取'; }
  }
}

let cookieModalFeedId = null;

function openCookieModal(feedId, url, title) {
  cookieModalFeedId = feedId;
  document.getElementById('cookie-modal-feed').textContent = title ? `${title} · Feed #${feedId}` : `Feed #${feedId}`;
  document.getElementById('cookie-modal-url').textContent = url || '—';
  document.getElementById('cookie-input').value = (strategyItems.find((it) => it.id === feedId)?.auth_cookie) || '';
  document.getElementById('cookie-modal-msg').textContent = '';
  document.getElementById('cookie-modal').classList.add('open');
  document.getElementById('cookie-modal').setAttribute('aria-hidden', 'false');
}

function closeCookieModal() {
  document.getElementById('cookie-modal').classList.remove('open');
  document.getElementById('cookie-modal').setAttribute('aria-hidden', 'true');
  cookieModalFeedId = null;
}

async function saveCookie() {
  const cookie = document.getElementById('cookie-input').value.trim();
  const headers = authHeaders();
  if (!headers) return;

  const msgEl = document.getElementById('cookie-modal-msg');
  msgEl.textContent = '保存中…';
  msgEl.style.color = '#666';

  try {
    const res = await fetch(`${API_BASE_URL}/crawler-strategies/${cookieModalFeedId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ auth_cookie: cookie || null }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '保存失败');

    const item = strategyItems.find((it) => it.id === cookieModalFeedId);
    if (item) item.auth_cookie = cookie || null;

    msgEl.textContent = cookie ? 'Cookie 已保存' : 'Cookie 已清除';
    msgEl.style.color = '#27ae60';
    setTimeout(closeCookieModal, 800);
    renderTable();
  } catch (err) {
    msgEl.textContent = err.message || String(err);
    msgEl.style.color = '#c0392b';
  }
}

async function clearCookie() {
  document.getElementById('cookie-input').value = '';
  await saveCookie();
}

let failureTipEl = null;
let failureTipHideTimer = null;
let failureTipCopyText = '';

function ensureFailureTipElement() {
  if (failureTipEl) return failureTipEl;
  failureTipEl = document.createElement('div');
  failureTipEl.className = 'strategy-failure-tip';
  failureTipEl.setAttribute('role', 'tooltip');
  failureTipEl.style.display = 'none';
  failureTipEl.addEventListener('mouseenter', () => {
    if (failureTipHideTimer) {
      clearTimeout(failureTipHideTimer);
      failureTipHideTimer = null;
    }
  });
  failureTipEl.addEventListener('mouseleave', hideFailureTip);
  failureTipEl.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!failureTipCopyText) return;
    try {
      await navigator.clipboard.writeText(failureTipCopyText);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = failureTipCopyText;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    failureTipEl.classList.add('strategy-failure-tip--copied');
    setTimeout(() => failureTipEl.classList.remove('strategy-failure-tip--copied'), 1200);
  });
  document.body.appendChild(failureTipEl);
  return failureTipEl;
}

function showFailureTip(anchor, text) {
  if (failureTipHideTimer) {
    clearTimeout(failureTipHideTimer);
    failureTipHideTimer = null;
  }
  const tip = ensureFailureTipElement();
  failureTipCopyText = text;
  tip.textContent = text;
  tip.classList.remove('strategy-failure-tip--copied');
  tip.style.display = 'block';
  tip.style.visibility = 'hidden';
  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxW = Math.min(420, vw - 16);
  tip.style.maxWidth = `${maxW}px`;
  const r = anchor.getBoundingClientRect();
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(pad, Math.min(left, vw - tw - pad));
  let top = r.bottom + 6;
  if (top + th > vh - pad && r.top > th + 12) {
    top = r.top - th - 6;
  }
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tip.style.visibility = 'visible';
}

function hideFailureTip() {
  failureTipHideTimer = setTimeout(() => {
    if (failureTipEl) {
      failureTipEl.style.display = 'none';
      failureTipEl.textContent = '';
      failureTipEl.classList.remove('strategy-failure-tip--copied');
    }
    failureTipCopyText = '';
    failureTipHideTimer = null;
  }, 120);
}

function initFailureTipDelegation() {
  const tbody = document.getElementById('strategy-tbody');
  if (!tbody || tbody.dataset.failureTipDelegation === '1') return;
  tbody.dataset.failureTipDelegation = '1';

  tbody.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('.strategy-status-tip[data-failure-tip]');
    if (!el || !tbody.contains(el)) return;
    const from = e.relatedTarget;
    if (from instanceof Node && el.contains(from)) return;
    const text = el.getAttribute('data-failure-tip');
    if (text) showFailureTip(el, text);
  });

  tbody.addEventListener('mouseout', (e) => {
    const el = e.target.closest?.('.strategy-status-tip[data-failure-tip]');
    if (!el || !tbody.contains(el)) return;
    const to = e.relatedTarget;
    if (to instanceof Node && (el.contains(to) || failureTipEl?.contains(to))) return;
    hideFailureTip();
  });

  window.addEventListener('scroll', hideFailureTip, true);
  window.addEventListener('resize', hideFailureTip);
}

document.addEventListener('DOMContentLoaded', () => {
  FeedEdit.init({ showMsg, onSaved: loadStrategies, onDeleted: loadStrategies });
  document.getElementById('strategy-refresh')?.addEventListener('click', loadStrategies);
  document.getElementById('strategy-filter')?.addEventListener('change', renderTable);
  document.getElementById('strategy-tbody')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.classList.contains('strategy-crawl')) triggerCrawl(id);
    if (btn.classList.contains('strategy-apply-recommended')) saveStrategy(id, true);
    if (btn.classList.contains('strategy-save')) saveStrategy(id, false);
  });
  loadStrategies();

  document.getElementById('cookie-save-btn')?.addEventListener('click', saveCookie);
  document.getElementById('cookie-clear-btn')?.addEventListener('click', clearCookie);
  document.getElementById('cookie-close-btn')?.addEventListener('click', closeCookieModal);
  document.getElementById('cookie-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'cookie-modal') closeCookieModal();
  });
  initFailureTipDelegation();
});

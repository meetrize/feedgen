const ADMIN_TOKEN_KEY = 'feedgen_admin_token';
const ADMIN_PANEL_KEY = 'feedgen_admin_last_panel';
const PAGE_SIZE = 50;

let adminToken = localStorage.getItem(ADMIN_TOKEN_KEY) || '';

const state = {
  feeds: { offset: 0, total: 0 },
  articles: { offset: 0, total: 0, feedFilter: '' },
  users: { offset: 0, total: 0 },
  membership: { plans: [] },
  tasks: { limit: 100, raw: null, historyOffset: 0, historyLimit: 50 },
  captcha: { tickets: [] },
};

let captchaWs = null;
let captchaReconnectTimer = null;
const captchaTickets = new Map();

/** 仅 Authorization，用于 GET / DELETE（无 body）；避免 Fastify 对空 JSON body 报错 */
function authBearerOnly() {
  return {
    Authorization: `Bearer ${adminToken}`,
  };
}

/** 带 JSON Content-Type，用于 POST / PUT 等有 body 的请求 */
function authHeaders() {
  return {
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  };
}

function showLogin() {
  document.getElementById('admin-login').classList.remove('hidden');
  document.getElementById('admin-app').classList.add('hidden');
}

function showApp() {
  document.getElementById('admin-login').classList.add('hidden');
  document.getElementById('admin-app').classList.remove('hidden');
}

function setLoginMessage(text, isError) {
  const el = document.getElementById('admin-login-msg');
  el.textContent = text || '';
  el.classList.remove('error', 'ok');
  if (text) el.classList.add(isError ? 'error' : 'ok');
}

async function tryRestoreSession() {
  if (!adminToken) {
    showLogin();
    return;
  }
  try {
    const res = await fetch(`${API_BASE_URL}/admin/feeds?limit=1&offset=0`, {
      headers: authBearerOnly(),
    });
    if (res.ok) {
      showApp();
      connectCaptchaWebSocket();
      let panel = 'feeds';
      try {
        panel = sessionStorage.getItem(ADMIN_PANEL_KEY) || 'feeds';
      } catch (e) {
        panel = 'feeds';
      }
      const valid = ['feeds', 'articles', 'users', 'membership', 'tasks', 'classification', 'captcha'];
      if (valid.indexOf(panel) === -1) panel = 'feeds';
      switchPanel(panel);
      if (panel === 'feeds') await loadFeeds();
      else if (panel === 'articles') await loadArticles();
      else if (panel === 'users') await loadUsers();
      else if (panel === 'membership') await loadMembership();
      else if (panel === 'tasks') await loadTasks();
      else if (panel === 'classification' && typeof loadClassificationPanel === 'function') await loadClassificationPanel();
      else if (panel === 'classification' && typeof loadClassificationCategories === 'function') await loadClassificationCategories();
      else if (panel === 'captcha') await loadCaptchaTickets();
    } else if (res.status === 401 || res.status === 403) {
      adminToken = '';
      localStorage.removeItem(ADMIN_TOKEN_KEY);
      showLogin();
      setLoginMessage('令牌已失效，请重新登录', true);
    } else {
      const data = await res.json().catch(() => ({}));
      showLogin();
      setLoginMessage(data.error || `无法连接管理接口 (${res.status})`, true);
    }
  } catch (e) {
    showLogin();
    setLoginMessage('网络错误：请确认后端已启动', true);
  }
}

function formatDt(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('zh-CN');
  } catch {
    return String(v);
  }
}

function esc(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function fmtJsonPretty(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

function dateInputValue(isoOrDate) {
  if (!isoOrDate) return '';
  const x = new Date(isoOrDate);
  if (Number.isNaN(x.getTime())) return '';
  return x.toISOString().slice(0, 10);
}

function formatStorage(mb) {
  const n = Number(mb) || 0;
  if (n >= 1024) {
    const gb = n / 1024;
    return Number.isInteger(gb) ? `${gb} GB` : `${gb.toFixed(1)} GB`;
  }
  return `${n} MB`;
}

function openModal(el) {
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
}

function closeModal(el) {
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
}

async function loadFeeds() {
  const { offset } = state.feeds;
  const res = await fetch(
    `${API_BASE_URL}/admin/feeds?limit=${PAGE_SIZE}&offset=${offset}`,
    { headers: authBearerOnly() }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '加载 Feeds 失败');

  state.feeds.total = data.total;
  document.getElementById('feeds-total').textContent = `共 ${data.total} 条`;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  document.getElementById('feeds-page-info').textContent = `第 ${page} / ${pages} 页`;

  const tbody = document.querySelector('#table-feeds tbody');
  tbody.innerHTML = (data.feeds || [])
    .map((f) => {
      const u = f.users;
      const userCell = u
        ? `#${u.id} ${esc(u.username)}${u.is_anonymous ? ' (游客)' : ''}`
        : '—';
      return `<tr>
        <td>${f.id}</td>
        <td>${userCell}</td>
        <td>${esc(f.title)}</td>
        <td>${esc(f.url)}</td>
        <td>${esc(f.feed_type)}</td>
        <td>${f.is_active ? '是' : '否'}</td>
        <td>${formatDt(f.created_at)}</td>
        <td>
          <button type="button" class="secondary-btn btn-tight btn-feed-crawl" data-id="${f.id}" title="忽略调度间隔立即爬取">爬取</button>
          <button type="button" class="secondary-btn btn-tight btn-feed-edit" data-id="${f.id}">编辑</button>
          <button type="button" class="secondary-btn btn-tight btn-feed-del" data-id="${f.id}">删除</button>
        </td>
      </tr>`;
    })
    .join('');
}

async function loadArticles() {
  const { offset, feedFilter } = state.articles;
  let url = `${API_BASE_URL}/admin/articles?limit=${PAGE_SIZE}&offset=${offset}`;
  if (feedFilter) url += `&feed_id=${encodeURIComponent(feedFilter)}`;

  const res = await fetch(url, { headers: authBearerOnly() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '加载文章失败');

  state.articles.total = data.total;
  document.getElementById('articles-total').textContent = `共 ${data.total} 条`;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  document.getElementById('articles-page-info').textContent = `第 ${page} / ${pages} 页`;

  const tbody = document.querySelector('#table-articles tbody');
  tbody.innerHTML = (data.articles || [])
    .map((a) => {
      const feedTitle = a.feeds ? `[#${a.feeds.id}] ${esc(a.feeds.title)}` : `#${a.feed_id}`;
      return `<tr>
        <td><input type="checkbox" class="article-cb" data-id="${a.id}"></td>
        <td>${a.id}</td>
        <td>${feedTitle}</td>
        <td>${esc(a.title)}</td>
        <td>${esc(a.url)}</td>
        <td>${esc(a.author)}</td>
        <td>${formatDt(a.pub_date)}</td>
        <td>
          <button type="button" class="secondary-btn btn-tight btn-article-detail" data-id="${a.id}">查看正文</button>
          <button type="button" class="secondary-btn btn-tight btn-article-del" data-id="${a.id}">删除</button>
        </td>
      </tr>`;
    })
    .join('');

  const selAll = document.getElementById('articles-select-all');
  if (selAll) selAll.checked = false;
}

async function openArticleDetail(id) {
  const modal = document.getElementById('article-detail-modal');
  const res = await fetch(`${API_BASE_URL}/admin/articles/${id}`, { headers: authBearerOnly() });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || '加载详情失败');
    return;
  }
  const a = data.article;
  document.getElementById('article-detail-title').textContent = a.title || '';
  document.getElementById('article-detail-meta').textContent = [
    `ID: ${a.id}`,
    a.feeds ? `Feed: ${a.feeds.title} (#${a.feed_id})` : `Feed ID: ${a.feed_id}`,
    a.url ? `链接: ${a.url}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  document.getElementById('article-detail-content').textContent = a.content || '(无正文)';
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeArticleDetail() {
  const modal = document.getElementById('article-detail-modal');
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

async function loadUsers() {
  const { offset } = state.users;
  const res = await fetch(
    `${API_BASE_URL}/admin/users?limit=${PAGE_SIZE}&offset=${offset}`,
    { headers: authBearerOnly() }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '加载用户失败');

  state.users.total = data.total;
  document.getElementById('users-total').textContent = `共 ${data.total} 条`;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  document.getElementById('users-page-info').textContent = `第 ${page} / ${pages} 页`;

  const plans = state.membership.planMap || new Map();
  const tbody = document.querySelector('#table-users tbody');
  tbody.innerHTML = (data.users || [])
    .map((u) => {
      const pid = u.current_plan_id == null ? null : Number(u.current_plan_id);
      const plan = pid != null && plans.has(pid) ? plans.get(pid) : null;
      const planText = plan
        ? `${esc(plan.name)} · ${Number(plan.max_feeds ?? 0)} Feeds`
        : (pid != null ? `#${pid}` : '—');
      return `<tr>
        <td>${u.id}</td>
        <td>${esc(u.username)}</td>
        <td>${esc(u.email)}</td>
        <td>${planText}</td>
        <td>${u.is_admin ? '是' : '否'}</td>
        <td>${u.is_anonymous ? '是' : '否'}</td>
        <td>${u.feed_count_used ?? '—'}</td>
        <td>${formatDt(u.created_at)}</td>
        <td>
          <button type="button" class="secondary-btn btn-tight btn-user-edit" data-id="${u.id}">编辑</button>
          <button type="button" class="secondary-btn btn-tight btn-user-del" data-id="${u.id}">删除</button>
        </td>
      </tr>`;
    })
    .join('');
}

function normalizeMembershipPlans(plans) {
  const defaults = [
    { id: 1, name: '免费版', price_label: '免费', price_suffix: '/年', description: '适合轻度使用，个人日常阅读。', max_feeds: 30, min_fetch_interval: 1800, history_days: 30, storage_mb: 500, highlight: false, sort_order: 1 },
    { id: 2, name: '普通会员', price_label: '¥98', price_suffix: '/年', description: '适合深度用户，提升信息覆盖范围。', max_feeds: 200, min_fetch_interval: 600, history_days: 180, storage_mb: 5120, highlight: true, sort_order: 2 },
    { id: 3, name: '超级会员', price_label: '¥580', price_suffix: '/年', description: '适合团队/重度监控，高频抓取与长期沉淀。', max_feeds: 1000, min_fetch_interval: 60, history_days: 1095, storage_mb: 51200, highlight: false, sort_order: 3 },
  ];
  const map = new Map((plans || []).map((p) => [p.id, p]));
  return defaults.map((d) => ({ ...d, ...(map.get(d.id) || {}) }));
}

function renderMembershipPlans() {
  const tbody = document.querySelector('#table-membership tbody');
  if (!tbody) return;
  const plans = normalizeMembershipPlans(state.membership.plans);
  state.membership.planMap = new Map(plans.map((p) => [Number(p.id), p]));
  tbody.innerHTML = plans.map((p) => `
    <tr data-plan-id="${p.id}">
      <td>#${p.id}</td>
      <td>
        <input type="text" class="membership-name" value="${esc(p.name)}">
        <div style="margin-top:4px;"><input type="text" class="membership-desc" value="${esc(p.description || '')}" placeholder="描述" style="width:100%;"></div>
      </td>
      <td><input type="text" class="membership-price" value="${esc(p.price_label || '')}"><div style="margin-top:4px;"><input type="text" class="membership-suffix" value="${esc(p.price_suffix || '/年')}" style="width:72px;"></div></td>
      <td><input type="number" class="membership-max-feeds" min="0" value="${Number(p.max_feeds ?? 0)}"></td>
      <td><input type="number" class="membership-min-interval" min="0" value="${Number(p.min_fetch_interval ?? 0)}"></td>
      <td><input type="number" class="membership-history-days" min="0" value="${Number(p.history_days ?? 0)}"></td>
      <td><input type="number" class="membership-storage-mb" min="0" value="${Number(p.storage_mb ?? 0)}"></td>
      <td style="text-align:center;"><input type="checkbox" class="membership-highlight" ${p.highlight ? 'checked' : ''}></td>
    </tr>
  `).join('');
}

async function loadMembership() {
  const msg = document.getElementById('membership-msg');
  if (msg) msg.textContent = '';
  const res = await fetch(`${API_BASE_URL}/membership/plans`, { headers: authBearerOnly() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '加载会员配置失败');
  state.membership.plans = data.plans || [];
  renderMembershipPlans();
  renderUserPlanOptions();
}

async function saveMembership() {
  const msg = document.getElementById('membership-msg');
  const rows = [...document.querySelectorAll('#table-membership tbody tr')];
  const plans = rows.map((row) => ({
    id: Number(row.getAttribute('data-plan-id')),
    name: row.querySelector('.membership-name').value.trim(),
    description: row.querySelector('.membership-desc').value.trim(),
    price_label: row.querySelector('.membership-price').value.trim(),
    price_suffix: row.querySelector('.membership-suffix').value.trim() || '/年',
    max_feeds: parseInt(row.querySelector('.membership-max-feeds').value, 10) || 0,
    min_fetch_interval: parseInt(row.querySelector('.membership-min-interval').value, 10) || 0,
    history_days: parseInt(row.querySelector('.membership-history-days').value, 10) || 0,
    storage_mb: parseInt(row.querySelector('.membership-storage-mb').value, 10) || 0,
    highlight: row.querySelector('.membership-highlight').checked,
    sort_order: Number(row.getAttribute('data-plan-id')) || 0,
  }));
  const res = await fetch(`${API_BASE_URL}/membership/plans`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ plans }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '保存会员配置失败');
  state.membership.plans = data.plans || plans;
  renderMembershipPlans();
  if (msg) msg.textContent = '保存成功';
}

async function loadTasks() {
  const limitInput = document.getElementById('tasks-limit');
  const limitRaw = limitInput ? parseInt(limitInput.value, 10) : 100;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 300) : 100;
  state.tasks.limit = limit;
  if (limitInput) limitInput.value = String(limit);

  const histLimitInput = document.getElementById('tasks-history-limit');
  const histLimitRaw = histLimitInput ? parseInt(histLimitInput.value, 10) : 50;
  const historyLimit = Number.isFinite(histLimitRaw) ? Math.min(Math.max(histLimitRaw, 1), 200) : 50;
  state.tasks.historyLimit = historyLimit;
  if (histLimitInput) histLimitInput.value = String(historyLimit);

  const { historyOffset } = state.tasks;
  const res = await fetch(
    `${API_BASE_URL}/admin/crawl-tasks?limit=${limit}&historyLimit=${historyLimit}&historyOffset=${historyOffset}`,
    {
      headers: authBearerOnly(),
    }
  );
  let data;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : {};
  } catch (parseErr) {
    throw new Error(`接口返回非 JSON（HTTP ${res.status}），请确认后端已启动且地址为 ${API_BASE_URL}`);
  }
  if (!res.ok) throw new Error(data.error || `加载任务失败（HTTP ${res.status}）`);
  state.tasks.raw = data;

  const genAt = document.getElementById('tasks-generated-at');
  if (genAt) {
    let line = `更新时间：${formatDt(data.generatedAt)}`;
    if (data.history && data.history.warning) {
      line += ` · ${String(data.history.warning).slice(0, 160)}`;
    }
    genAt.textContent = line;
  }

  const counts = (data.queue && data.queue.counts) || {};
  const queueCounters = document.getElementById('tasks-queue-counters');
  if (queueCounters) {
    queueCounters.innerHTML = [
      `Redis: ${data.queue?.redisAvailable ? '可用' : '不可用'}`,
      `等待 ${counts.waiting || 0}`,
      `执行中 ${counts.active || 0}`,
      `延迟 ${counts.delayed || 0}`,
      `失败 ${counts.failed || 0}`,
      `完成 ${counts.completed || 0}`,
      `暂停 ${counts.paused || 0}`,
    ]
      .map((x) => `<span class="admin-task-pill">${esc(x)}</span>`)
      .join('');
  }

  const jobsBody = document.querySelector('#table-tasks-jobs tbody');
  if (jobsBody) {
    jobsBody.innerHTML = (data.queue?.jobs || [])
    .map((job) => {
      const feedId = job.data?.feedId ?? '—';
      const url = job.data?.url || '';
      return `<tr>
        <td>${esc(String(job.id ?? '—'))}</td>
        <td>${esc(job.state || 'unknown')}</td>
        <td>${esc(String(feedId))}</td>
        <td>${esc(url)}</td>
        <td>${esc(String(job.attemptsMade || 0))} / ${esc(String(job.opts?.attempts || 0))}</td>
        <td>${esc(String(job.progress ?? 0))}</td>
        <td>${formatDt(job.timestamp)}</td>
        <td>${formatDt(job.processedOn)}</td>
        <td>${formatDt(job.finishedOn)}</td>
        <td><button type="button" class="secondary-btn btn-tight btn-task-job-detail" data-job-id="${esc(String(job.id ?? ''))}">详情</button></td>
      </tr>`;
    })
    .join('');
  }

  if (data.history && data.history.warning) {
    console.warn('[admin tasks]', data.history.warning);
  }

  const hist = data.history || {};
  const histTotal = hist.total != null ? hist.total : 0;
  const histTotalEl = document.getElementById('tasks-history-total');
  if (histTotalEl) histTotalEl.textContent = `共 ${histTotal} 条`;
  const histPages = Math.max(1, Math.ceil(histTotal / historyLimit) || 1);
  const histPage = Math.min(histPages, Math.floor(historyOffset / historyLimit) + 1);
  const histPageEl = document.getElementById('tasks-history-page-info');
  if (histPageEl) histPageEl.textContent = `第 ${histPage} / ${histPages} 页`;

  const historyBody = document.querySelector('#table-tasks-history tbody');
  if (historyBody) {
    historyBody.innerHTML = (hist.items || [])
    .map((h) => {
      const feedCell = `[#${h.feed_id}] ${esc(h.feed_title || '')}`;
      return `<tr>
        <td>${h.id}</td>
        <td title="${esc(h.feed_url || '')}">${feedCell}</td>
        <td>${esc(h.mode || '')}</td>
        <td>${esc(h.status || '')}</td>
        <td>${h.new_articles_count != null ? esc(String(h.new_articles_count)) : '—'}</td>
        <td>${h.duration_ms != null ? esc(String(h.duration_ms)) : '—'}</td>
        <td>${formatDt(h.started_at)}</td>
        <td>${formatDt(h.finished_at)}</td>
        <td><button type="button" class="secondary-btn btn-tight btn-task-history-detail" data-history-id="${h.id}">详情</button></td>
      </tr>`;
    })
    .join('');
  }

  state.tasks.historyItems = hist.items || [];

  const schedulesBody = document.querySelector('#table-tasks-schedules tbody');
  if (schedulesBody) {
    schedulesBody.innerHTML = (data.schedules || [])
    .map((s) => {
      const userText = s.user ? `#${s.user.id} ${s.user.username}${s.user.is_anonymous ? ' (游客)' : ''}` : '—';
      const overdueText = s.isOverdue ? `是（${s.overdueSec}秒）` : '否';
      return `<tr>
        <td>${s.feedId}</td>
        <td>${esc(s.feedTitle || '')}</td>
        <td>${esc(s.mode || '')}</td>
        <td>${esc(userText)}</td>
        <td>${esc(String(s.intervalSec || 0))}</td>
        <td>${formatDt(s.lastFetchedAt)}</td>
        <td>${formatDt(s.nextRunAt)}</td>
        <td>${esc(overdueText)}</td>
        <td><button type="button" class="secondary-btn btn-tight btn-task-schedule-detail" data-feed-id="${s.feedId}">详情</button></td>
      </tr>`;
    })
    .join('');
  }
}

function renderUserPlanOptions() {
  const select = document.getElementById('user-edit-plan-select');
  if (!select) return;
  const plans = normalizeMembershipPlans(state.membership.plans);
  if (!plans.length) {
    select.innerHTML = '<option value="">暂无可选套餐</option>';
    return;
  }
  select.innerHTML = ['<option value="">无/未设置</option>']
    .concat(plans.map((p) => `<option value="${p.id}">#${p.id} ${esc(p.name)}（${esc(p.price_label || '免费')}）</option>`))
    .join('');
}

function openTaskDetail(payload) {
  const pre = document.getElementById('task-detail-content');
  pre.textContent = fmtJsonPretty(payload);
  openModal(document.getElementById('task-detail-modal'));
}

async function openFeedEdit(id) {
  const res = await fetch(`${API_BASE_URL}/admin/feeds/${id}`, { headers: authBearerOnly() });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || '加载 Feed 失败');
    return;
  }
  const f = data.feed;
  document.getElementById('feed-edit-id').value = String(f.id);
  document.getElementById('feed-edit-title').value = f.title || '';
  document.getElementById('feed-edit-url').value = f.url || '';
  document.getElementById('feed-edit-description').value = f.description || '';
  document.getElementById('feed-edit-type').value = f.feed_type || 'rss';
  document.getElementById('feed-edit-user-id').value =
    f.user_id != null ? String(f.user_id) : '';
  document.getElementById('feed-edit-interval').value =
    f.update_interval != null ? String(f.update_interval) : '1800';
  document.getElementById('feed-edit-active').checked = !!f.is_active;
  let selText = '';
  try {
    selText =
      f.selector_rules == null ? '' : JSON.stringify(f.selector_rules, null, 2);
  } catch {
    selText = String(f.selector_rules);
  }
  document.getElementById('feed-edit-selector').value = selText;
  openModal(document.getElementById('feed-edit-modal'));
}

async function saveFeedEdit() {
  const id = document.getElementById('feed-edit-id').value;
  const title = document.getElementById('feed-edit-title').value.trim();
  if (!title) {
    alert('标题不能为空');
    return;
  }
  const uidRaw = document.getElementById('feed-edit-user-id').value.trim();
  let selector_rules;
  const selRaw = document.getElementById('feed-edit-selector').value.trim();
  if (selRaw === '') {
    selector_rules = null;
  } else {
    try {
      selector_rules = JSON.parse(selRaw);
    } catch {
      alert('selector_rules 不是合法 JSON');
      return;
    }
  }
  const body = {
    title,
    url: document.getElementById('feed-edit-url').value.trim() || null,
    description: document.getElementById('feed-edit-description').value,
    feed_type: document.getElementById('feed-edit-type').value.trim() || 'rss',
    is_active: document.getElementById('feed-edit-active').checked,
    update_interval: parseInt(document.getElementById('feed-edit-interval').value, 10) || 0,
    user_id: uidRaw === '' ? null : parseInt(uidRaw, 10),
    selector_rules,
  };
  if (body.user_id !== null && Number.isNaN(body.user_id)) {
    alert('用户 ID 须为数字或留空');
    return;
  }
  const res = await fetch(`${API_BASE_URL}/admin/feeds/${id}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || '保存失败');
    return;
  }
  closeModal(document.getElementById('feed-edit-modal'));
  await loadFeeds();
}

async function deleteFeed(id) {
  if (!confirm(`确定删除 Feed #${id}？其下文章将一并删除。`)) return;
  const res = await fetch(`${API_BASE_URL}/admin/feeds/${id}`, {
    method: 'DELETE',
    headers: authBearerOnly(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || '删除失败');
    return;
  }
  await loadFeeds();
}

async function openUserEdit(id) {
  const res = await fetch(`${API_BASE_URL}/admin/users/${id}`, { headers: authBearerOnly() });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || '加载用户失败');
    return;
  }
  const u = data.user;
  document.getElementById('user-edit-id').value = String(u.id);
  document.getElementById('user-edit-username').value = u.username || '';
  document.getElementById('user-edit-email').value = u.email || '';
  document.getElementById('user-edit-password').value = '';
  document.getElementById('user-edit-plan-select').value =
    u.current_plan_id != null ? String(u.current_plan_id) : '';
  document.getElementById('user-edit-plan-start').value = dateInputValue(u.plan_start_date);
  document.getElementById('user-edit-plan-end').value = dateInputValue(u.plan_end_date);
  document.getElementById('user-edit-feed-used').value =
    u.feed_count_used != null ? String(u.feed_count_used) : '0';
  document.getElementById('user-edit-admin').checked = !!u.is_admin;
  document.getElementById('user-edit-anon').checked = !!u.is_anonymous;
  renderUserPlanOptions();
  document.getElementById('user-edit-plan-select').value =
    u.current_plan_id != null ? String(u.current_plan_id) : '';
  openModal(document.getElementById('user-edit-modal'));
}

async function saveUserEdit() {
  const id = document.getElementById('user-edit-id').value;
  const planRaw = document.getElementById('user-edit-plan-select').value.trim();
  const pwd = document.getElementById('user-edit-password').value;
  const username = document.getElementById('user-edit-username').value.trim();
  const email = document.getElementById('user-edit-email').value.trim();
  if (!username || !email) {
    alert('用户名与邮箱不能为空');
    return;
  }
  const fcu = parseInt(document.getElementById('user-edit-feed-used').value, 10);
  if (Number.isNaN(fcu) || fcu < 0) {
    alert('已用 Feed 数须为非负整数');
    return;
  }
  const body = {
    username,
    email,
    is_admin: document.getElementById('user-edit-admin').checked,
    is_anonymous: document.getElementById('user-edit-anon').checked,
    feed_count_used: fcu,
    current_plan_id: planRaw === '' ? null : parseInt(planRaw, 10),
    plan_start_date: document.getElementById('user-edit-plan-start').value || null,
    plan_end_date: document.getElementById('user-edit-plan-end').value || null,
  };
  if (body.current_plan_id !== null && Number.isNaN(body.current_plan_id)) {
    alert('套餐等级须从下拉列表选择');
    return;
  }
  if (pwd) body.password = pwd;
  const res = await fetch(`${API_BASE_URL}/admin/users/${id}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || '保存失败');
    return;
  }
  closeModal(document.getElementById('user-edit-modal'));
  await loadUsers();
}

async function deleteUser(id) {
  if (!confirm(`确定删除用户 #${id}？其 Feeds 与关联数据将级联删除。`)) return;
  const res = await fetch(`${API_BASE_URL}/admin/users/${id}`, {
    method: 'DELETE',
    headers: authBearerOnly(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || '删除失败');
    return;
  }
  await loadUsers();
}

async function deleteArticle(id) {
  if (!confirm(`确定删除文章 #${id}？`)) return;
  const res = await fetch(`${API_BASE_URL}/admin/articles/${id}`, {
    method: 'DELETE',
    headers: authBearerOnly(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || '删除失败');
    return;
  }
  await loadArticles();
}

async function batchDeleteArticles() {
  const ids = [
    ...document.querySelectorAll('#table-articles tbody .article-cb:checked'),
  ].map((cb) => Number(cb.getAttribute('data-id')));
  if (ids.length === 0) {
    alert('请先勾选要删除的文章');
    return;
  }
  if (!confirm(`确定批量删除 ${ids.length} 篇文章？`)) return;
  const res = await fetch(`${API_BASE_URL}/admin/articles/batch-delete`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ ids }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || '批量删除失败');
    return;
  }
  alert(`已删除 ${data.deleted ?? 0} 条`);
  await loadArticles();
}

function switchPanel(name) {
  try {
    sessionStorage.setItem(ADMIN_PANEL_KEY, name);
  } catch (e) {
    /* ignore */
  }
  document.querySelectorAll('.admin-menu-btn').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-panel') === name);
  });
  document.querySelectorAll('.admin-panel').forEach((p) => {
    p.classList.toggle('active', p.id === `panel-${name}`);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const usernameInput = document.getElementById('admin-username-input');
  const passwordInput = document.getElementById('admin-password-input');
  const loginBtn = document.getElementById('admin-login-btn');

  if (!usernameInput || !passwordInput || !loginBtn) {
    const msg = document.getElementById('admin-login-msg');
    if (msg) {
      msg.textContent =
        '页面脚本与 HTML 不匹配或缓存了旧版 admin.js，请强制刷新（Safari：开发-清空缓存 或 Shift+点刷新）后重试。';
      msg.classList.add('error');
    }
    return;
  }

  loginBtn.addEventListener('click', async () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) {
      setLoginMessage('请输入用户名和密码', true);
      return;
    }

    setLoginMessage('登录中…', false);
    try {
      const loginRes = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const loginData = await loginRes.json().catch(() => ({}));
      if (!loginRes.ok) {
        setLoginMessage(loginData.error || '登录失败', true);
        return;
      }
      if (!loginData.user?.is_admin) {
        setLoginMessage('该账号不是管理员', true);
        return;
      }
      adminToken = loginData.token;
      localStorage.setItem(ADMIN_TOKEN_KEY, adminToken);
      setLoginMessage('');
      showApp();
      connectCaptchaWebSocket();
      state.feeds.offset = 0;
      let panel = 'feeds';
      try {
        panel = sessionStorage.getItem(ADMIN_PANEL_KEY) || 'feeds';
      } catch (e) {
        panel = 'feeds';
      }
      const valid = ['feeds', 'articles', 'users', 'membership', 'tasks', 'classification', 'captcha'];
      if (valid.indexOf(panel) === -1) panel = 'feeds';
      switchPanel(panel);
      if (panel === 'feeds') await loadFeeds();
      else if (panel === 'articles') await loadArticles();
      else if (panel === 'users') await loadUsers();
      else if (panel === 'membership') await loadMembership();
      else if (panel === 'tasks') await loadTasks();
      else if (panel === 'classification' && typeof loadClassificationPanel === 'function') await loadClassificationPanel();
      else if (panel === 'classification' && typeof loadClassificationCategories === 'function') await loadClassificationCategories();
      else if (panel === 'captcha') await loadCaptchaTickets();
    } catch (e) {
      setLoginMessage('网络错误', true);
    }
  });

  document.querySelectorAll('.admin-menu-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const panel = btn.getAttribute('data-panel');
      switchPanel(panel);
      try {
        if (panel === 'feeds') await loadFeeds();
        if (panel === 'articles') await loadArticles();
        if (panel === 'users') await loadUsers();
        if (panel === 'membership') await loadMembership();
        if (panel === 'tasks') await loadTasks();
        if (panel === 'classification' && typeof loadClassificationPanel === 'function') await loadClassificationPanel();
        else if (panel === 'classification' && typeof loadClassificationCategories === 'function') await loadClassificationCategories();
        if (panel === 'captcha') await loadCaptchaTickets();
      } catch (e) {
        alert(e.message || String(e));
      }
    });
  });

  document.getElementById('refresh-feeds').addEventListener('click', async () => {
    try {
      await loadFeeds();
    } catch (e) {
      alert(e.message);
    }
  });
  document.getElementById('feeds-prev').addEventListener('click', async () => {
    state.feeds.offset = Math.max(0, state.feeds.offset - PAGE_SIZE);
    try {
      await loadFeeds();
    } catch (e) {
      alert(e.message);
    }
  });
  document.getElementById('feeds-next').addEventListener('click', async () => {
    if (state.feeds.offset + PAGE_SIZE < state.feeds.total) {
      state.feeds.offset += PAGE_SIZE;
      try {
        await loadFeeds();
      } catch (e) {
        alert(e.message);
      }
    }
  });

  document.getElementById('refresh-articles').addEventListener('click', async () => {
    state.articles.feedFilter = document.getElementById('articles-feed-filter').value.trim();
    state.articles.offset = 0;
    try {
      await loadArticles();
    } catch (e) {
      alert(e.message);
    }
  });
  document.getElementById('articles-clear-filter').addEventListener('click', async () => {
    document.getElementById('articles-feed-filter').value = '';
    state.articles.feedFilter = '';
    state.articles.offset = 0;
    try {
      await loadArticles();
    } catch (e) {
      alert(e.message);
    }
  });
  document.getElementById('articles-prev').addEventListener('click', async () => {
    state.articles.offset = Math.max(0, state.articles.offset - PAGE_SIZE);
    try {
      await loadArticles();
    } catch (e) {
      alert(e.message);
    }
  });
  document.getElementById('articles-next').addEventListener('click', async () => {
    if (state.articles.offset + PAGE_SIZE < state.articles.total) {
      state.articles.offset += PAGE_SIZE;
      try {
        await loadArticles();
      } catch (e) {
        alert(e.message);
      }
    }
  });

  document.getElementById('refresh-users').addEventListener('click', async () => {
    try {
      await loadUsers();
    } catch (e) {
      alert(e.message);
    }
  });

  const refreshMembership = document.getElementById('refresh-membership');
  if (refreshMembership) {
    refreshMembership.addEventListener('click', async () => {
      try {
        await loadMembership();
      } catch (e) {
        alert(e.message || String(e));
      }
    });
  }
  const saveMembershipBtn = document.getElementById('save-membership');
  if (saveMembershipBtn) {
    saveMembershipBtn.addEventListener('click', async () => {
      try {
        await saveMembership();
      } catch (e) {
        alert(e.message || String(e));
      }
    });
  }

  const refreshTasks = document.getElementById('refresh-tasks');
  if (refreshTasks) {
    refreshTasks.addEventListener('click', async () => {
      try {
        await loadTasks();
      } catch (e) {
        alert(e.message || String(e));
      }
    });
  }

  const tasksHistoryPrev = document.getElementById('tasks-history-prev');
  const tasksHistoryNext = document.getElementById('tasks-history-next');
  if (tasksHistoryPrev && tasksHistoryNext) {
    tasksHistoryPrev.addEventListener('click', async () => {
      state.tasks.historyOffset = Math.max(0, state.tasks.historyOffset - state.tasks.historyLimit);
      try {
        await loadTasks();
      } catch (e) {
        alert(e.message || String(e));
      }
    });
    tasksHistoryNext.addEventListener('click', async () => {
      const total = state.tasks.raw?.history?.total ?? 0;
      const lim = state.tasks.historyLimit || 50;
      if (state.tasks.historyOffset + lim < total) {
        state.tasks.historyOffset += lim;
        try {
          await loadTasks();
        } catch (e) {
          alert(e.message || String(e));
        }
      }
    });
  }

  const tableTasksHistory = document.querySelector('#table-tasks-history tbody');
  if (tableTasksHistory) {
    tableTasksHistory.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || !btn.classList.contains('btn-task-history-detail')) return;
      const hid = btn.getAttribute('data-history-id');
      const items = state.tasks.historyItems || [];
      const target = items.find((x) => String(x.id) === String(hid));
      if (target) openTaskDetail(target);
    });
  }
  document.getElementById('users-prev').addEventListener('click', async () => {
    state.users.offset = Math.max(0, state.users.offset - PAGE_SIZE);
    try {
      await loadUsers();
    } catch (e) {
      alert(e.message);
    }
  });
  document.getElementById('users-next').addEventListener('click', async () => {
    if (state.users.offset + PAGE_SIZE < state.users.total) {
      state.users.offset += PAGE_SIZE;
      try {
        await loadUsers();
      } catch (e) {
        alert(e.message);
      }
    }
  });

  document.getElementById('article-detail-close').addEventListener('click', closeArticleDetail);
  document.getElementById('article-detail-modal').addEventListener('click', (ev) => {
    if (ev.target.id === 'article-detail-modal') closeArticleDetail();
  });

  document.querySelector('#table-feeds tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = Number(btn.getAttribute('data-id'));
    if (btn.classList.contains('btn-feed-edit')) {
      try {
        await openFeedEdit(id);
      } catch (err) {
        alert(err.message || String(err));
      }
    } else if (btn.classList.contains('btn-feed-del')) {
      try {
        await deleteFeed(id);
      } catch (err) {
        alert(err.message || String(err));
      }
    } else if (btn.classList.contains('btn-feed-crawl')) {
      try {
        btn.disabled = true;
        const res = await fetch(`${API_BASE_URL}/admin/feeds/${id}/crawl`, {
          method: 'POST',
          headers: authBearerOnly(),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '爬取失败');
        alert(data.message || '爬取已触发');
      } catch (err) {
        alert(err.message || String(err));
      } finally {
        btn.disabled = false;
      }
    }
  });

  document.querySelector('#table-users tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = Number(btn.getAttribute('data-id'));
    if (btn.classList.contains('btn-user-edit')) {
      try {
        await openUserEdit(id);
      } catch (err) {
        alert(err.message || String(err));
      }
    } else if (btn.classList.contains('btn-user-del')) {
      try {
        await deleteUser(id);
      } catch (err) {
        alert(err.message || String(err));
      }
    }
  });

  document.querySelector('#table-articles tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = Number(btn.getAttribute('data-id'));
    if (btn.classList.contains('btn-article-detail')) {
      openArticleDetail(id);
    } else if (btn.classList.contains('btn-article-del')) {
      try {
        await deleteArticle(id);
      } catch (err) {
        alert(err.message || String(err));
      }
    }
  });

  document.getElementById('articles-select-all').addEventListener('change', (e) => {
    const on = e.target.checked;
    document.querySelectorAll('#table-articles tbody .article-cb').forEach((cb) => {
      cb.checked = on;
    });
  });

  document.getElementById('articles-batch-delete').addEventListener('click', async () => {
    try {
      await batchDeleteArticles();
    } catch (err) {
      alert(err.message || String(err));
    }
  });

  document.getElementById('feed-edit-save').addEventListener('click', async () => {
    try {
      await saveFeedEdit();
    } catch (err) {
      alert(err.message || String(err));
    }
  });
  document.getElementById('feed-edit-cancel').addEventListener('click', () => {
    closeModal(document.getElementById('feed-edit-modal'));
  });
  document.getElementById('feed-edit-modal').addEventListener('click', (e) => {
    if (e.target.id === 'feed-edit-modal') closeModal(document.getElementById('feed-edit-modal'));
  });

  document.getElementById('user-edit-save').addEventListener('click', async () => {
    try {
      await saveUserEdit();
    } catch (err) {
      alert(err.message || String(err));
    }
  });
  document.getElementById('user-edit-cancel').addEventListener('click', () => {
    closeModal(document.getElementById('user-edit-modal'));
  });
  document.getElementById('user-edit-modal').addEventListener('click', (e) => {
    if (e.target.id === 'user-edit-modal') closeModal(document.getElementById('user-edit-modal'));
  });

  document.querySelector('#table-tasks-jobs tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !btn.classList.contains('btn-task-job-detail')) return;
    const jobId = btn.getAttribute('data-job-id');
    const jobs = state.tasks.raw?.queue?.jobs || [];
    const target = jobs.find((j) => String(j.id) === String(jobId));
    if (target) openTaskDetail(target);
  });

  document.querySelector('#table-tasks-schedules tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !btn.classList.contains('btn-task-schedule-detail')) return;
    const feedId = btn.getAttribute('data-feed-id');
    const schedules = state.tasks.raw?.schedules || [];
    const target = schedules.find((s) => String(s.feedId) === String(feedId));
    if (target) openTaskDetail(target);
  });

  document.getElementById('task-detail-close').addEventListener('click', () => {
    closeModal(document.getElementById('task-detail-modal'));
  });
  document.getElementById('task-detail-modal').addEventListener('click', (e) => {
    if (e.target.id === 'task-detail-modal') closeModal(document.getElementById('task-detail-modal'));
  });

  // ── 验证码处理 ──
  window.addEventListener('beforeunload', () => {
    if (captchaWs) captchaWs.close();
  });

  document.getElementById('captcha-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('.captcha-action');
    if (!btn) return;

    const action = btn.getAttribute('data-action');
    const captchaId = btn.getAttribute('data-id');

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '处理中…';

    try {
      if (action === 'cookie') {
        const textarea = document.querySelector(`.captcha-cookie-input[data-id="${captchaId}"]`);
        const cookie = textarea ? textarea.value.trim() : '';
        if (!cookie) { alert('请先粘贴 Cookie'); btn.disabled = false; btn.textContent = originalText; return; }

        const res = await fetch(`${API_BASE_URL}/captcha-relay/tickets/${encodeURIComponent(captchaId)}/submit-cookie`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ cookie }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '提交失败');
        onCaptchaResolved({ captchaId });
      } else if (action === 'solve') {
        const input = document.querySelector(`.captcha-answer-input[data-id="${captchaId}"]`);
        const answer = input ? input.value.trim() : '';
        if (!answer) { alert('请输入验证码答案'); btn.disabled = false; btn.textContent = originalText; return; }

        const res = await fetch(`${API_BASE_URL}/captcha-relay/tickets/${encodeURIComponent(captchaId)}/solve`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ answer }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '提交失败');

        if (input) input.value = '';
        btn.textContent = '已发送，等待结果…';
        setTimeout(() => { btn.textContent = '▶ 提交答案'; btn.disabled = false; }, 5000);
        return;
      } else if (action === 'remote') {
        openRemoteModal(captchaId);
        btn.disabled = false;
        btn.textContent = originalText;
        return;
      } else if (action === 'mark-processed' || action === 'dismiss') {
        const endpoint = action === 'dismiss' ? 'dismiss' : 'mark-processed';
        const res = await fetch(`${API_BASE_URL}/captcha-relay/tickets/${encodeURIComponent(captchaId)}/${endpoint}`, {
          method: 'POST',
          headers: authHeaders(),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '操作失败');
        onCaptchaResolved({ captchaId });
        return;
      } else {
        const endpoint = { retry: 'retry', disable: 'disable' }[action];
        const res = await fetch(`${API_BASE_URL}/captcha-relay/tickets/${encodeURIComponent(captchaId)}/${endpoint}`, {
          method: 'POST',
          headers: authHeaders(),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '操作失败');
        onCaptchaResolved({ captchaId });
      }
    } catch (err) {
      alert(err.message || String(err));
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  document.getElementById('captcha-mark-all-btn').addEventListener('click', async () => {
    const pending = Array.from(captchaTickets.values()).filter((t) => !t.resolvedAt);
    if (pending.length === 0) {
      alert('当前没有待处理的验证码');
      return;
    }
    if (!confirm(`确定将 ${pending.length} 条待处理验证码全部标记为已处理？标记后将不再显示。`)) return;

    const btn = document.getElementById('captcha-mark-all-btn');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '处理中…';
    try {
      const res = await fetch(`${API_BASE_URL}/captcha-relay/tickets/mark-all-processed`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '操作失败');
      pending.forEach((t) => onCaptchaResolved({ captchaId: t.captchaId }));
    } catch (err) {
      alert(err.message || String(err));
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
});

// ── 验证码 WebSocket 与 UI ──

function connectCaptchaWebSocket() {
  if (captchaWs && captchaWs.readyState === WebSocket.OPEN) return;
  if (!adminToken) return;

  const apiUrl = new URL(API_BASE_URL);
  const wsProto = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProto}//${apiUrl.host}/api/captcha-relay/ws?token=${encodeURIComponent(adminToken)}`;

  captchaWs = new WebSocket(wsUrl);

  captchaWs.onopen = () => {
    console.log('[captcha] WebSocket 已连接');
    if (captchaReconnectTimer) { clearTimeout(captchaReconnectTimer); captchaReconnectTimer = null; }
  };

  captchaWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'captcha_detected') {
        onCaptchaDetected(msg.payload);
      } else if (msg.type === 'captcha_resolved') {
        onCaptchaResolved(msg.payload);
      } else if (msg.type === 'remote_screenshot') {
        onRemoteScreenshot(msg.payload);
      }
    } catch (e) {}
  };

  captchaWs.onclose = () => {
    console.log('[captcha] WebSocket 断开，10 秒后重连');
    captchaReconnectTimer = setTimeout(connectCaptchaWebSocket, 10000);
  };

  captchaWs.onerror = () => {
    captchaWs.close();
  };
}

function onCaptchaDetected(ticket) {
  captchaTickets.set(ticket.captchaId, ticket);
  updateCaptchaBadge();
  renderCaptchaPanel();
}

function onCaptchaResolved(payload) {
  captchaTickets.delete(payload.captchaId);
  updateCaptchaBadge();

  if (remoteCaptchaId === payload.captchaId) {
    closeRemoteModal();
  }

  // 面板中的对应卡片即时移除
  const card = document.querySelector(`.captcha-card[data-id="${payload.captchaId}"]`);
  if (card) {
    card.style.transition = 'opacity 0.3s';
    card.style.opacity = '0';
    setTimeout(() => card.remove(), 300);
  }

  const remaining = document.querySelectorAll('.captcha-card').length;
  if (remaining <= 1) {
    setTimeout(renderCaptchaPanel, 350);
  }
}

function updateCaptchaBadge() {
  const count = captchaTickets.size;
  const badge = document.getElementById('captcha-badge');
  if (!badge) return;
  badge.textContent = String(count);
  badge.style.display = count > 0 ? 'inline-block' : 'none';
}

async function loadCaptchaTickets() {
  try {
    const res = await fetch(`${API_BASE_URL}/captcha-relay/tickets`, {
      headers: authBearerOnly(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '加载失败');

    captchaTickets.clear();
    (data.tickets || []).forEach((t) => captchaTickets.set(t.captchaId, t));
    updateCaptchaBadge();
    renderCaptchaPanel();
  } catch (e) {
    console.error('[captcha] 加载 tickets 失败:', e);
  }
}

function renderCaptchaPanel() {
  const list = document.getElementById('captcha-list');
  const empty = document.getElementById('captcha-empty');
  if (!list || !empty) return;

  const tickets = Array.from(captchaTickets.values())
    .filter((t) => !t.resolvedAt)
    .sort((a, b) => b.detectedAt - a.detectedAt);

  if (tickets.length === 0) {
    empty.style.display = 'block';
    list.innerHTML = '';
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = tickets.map((t) => renderCaptchaCard(t)).join('');
}

function renderCaptchaCard(t) {
  const detectedAt = new Date(t.detectedAt).toLocaleString('zh-CN');
  const typeLabel = { cloudflare: 'Cloudflare 盾', recaptcha: 'reCAPTCHA', hcaptcha: 'hCaptcha', geetest: '极验', captcha: '验证码', unknown: '未知类型' }[t.captchaType] || '验证码';

  return `<div class="captcha-card" data-id="${esc(t.captchaId)}" style="background:#fff;border:2px solid #fde2e2;border-radius:8px;padding:1rem;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:0.5rem;">
      <div>
        <strong style="color:#c0392b;">⚠️ ${esc(typeLabel)}</strong>
        <span style="color:#555;margin-left:0.75rem;">${esc(t.feedTitle)} · Feed #${t.feedId}</span>
      </div>
      <span style="color:#999;font-size:0.8rem;">${detectedAt}</span>
    </div>
    <div style="margin-top:0.5rem;font-size:0.85rem;color:#666;">
      <div>目标 URL: <a href="${esc(t.targetUrl)}" target="_blank" rel="noopener" style="color:#3498db;">${esc(t.targetUrl)}</a></div>
      ${t.pageUrl && t.pageUrl !== t.targetUrl ? `<div>跳转 URL: <span style="color:#e67e22;">${esc(t.pageUrl)}</span></div>` : ''}
      <div>命中信号: ${(t.signals || []).map((s) => `<code style="background:#fef0f0;padding:1px 5px;border-radius:3px;">${esc(s)}</code>`).join(' ')}</div>
    </div>
    ${t.screenshotBase64 ? `<div style="margin-top:0.75rem;">
      <img src="data:image/jpeg;base64,${t.screenshotBase64}" alt="验证码截图" style="max-width:100%;max-height:300px;border:1px solid #eee;border-radius:4px;" loading="lazy">
    </div>` : ''}
    <div style="margin-top:0.75rem;padding:0.5rem 0.75rem;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;">
      <div style="font-size:0.85rem;color:#1e40af;font-weight:600;margin-bottom:0.35rem;">🖱️ 远程交互 — 在下方弹窗中直接操作服务端页面</div>
      <button type="button" class="primary-btn captcha-action" data-action="remote" data-id="${esc(t.captchaId)}" data-feed="${t.feedId}" style="font-size:0.82rem;">▶ 开始远程交互</button>
      <span style="font-size:0.78rem;color:#6b7280;margin-left:0.5rem;">点击/拖拽/输入，实时操作服务器浏览器</span>
    </div>
    <div style="margin-top:0.75rem;display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;">
      <button type="button" class="primary-btn captcha-action" data-action="mark-processed" data-id="${esc(t.captchaId)}" data-feed="${t.feedId}" style="font-size:0.82rem;background:#16a34a;">✓ 标记已处理</button>
      <span style="font-size:0.78rem;color:#6b7280;">不再显示此条验证码</span>
    </div>
    <div style="margin-top:0.5rem;display:flex;flex-wrap:wrap;gap:0.35rem;align-items:center;">
      <span style="font-size:0.78rem;color:#9ca3af;">备用方案：</span>
      <button type="button" class="secondary-btn captcha-action" data-action="cookie" data-id="${esc(t.captchaId)}" data-feed="${t.feedId}" style="font-size:0.78rem;">📋 Cookie</button>
      <button type="button" class="secondary-btn captcha-action" data-action="retry" data-id="${esc(t.captchaId)}" data-feed="${t.feedId}" style="font-size:0.78rem;">⏳ 重试</button>
      <button type="button" class="secondary-btn captcha-action" data-action="disable" data-id="${esc(t.captchaId)}" data-feed="${t.feedId}" style="font-size:0.78rem;color:#c0392b;">🚫 禁用</button>
    </div>
  </div>`;
}

// ── 远程交互 ──

let remoteCaptchaId = null;
let dragStartPos = null;

async function openRemoteModal(captchaId) {
  remoteCaptchaId = captchaId;
  document.getElementById('remote-placeholder').style.display = 'flex';
  document.getElementById('remote-screenshot').style.display = 'none';
  document.getElementById('remote-msg').textContent = '正在启动远程浏览器...';
  document.getElementById('remote-modal').classList.add('open');
  document.getElementById('remote-modal').setAttribute('aria-hidden', 'false');

  // 主动调起服务端远程会话
  try {
    const res = await fetch(`${API_BASE_URL}/captcha-relay/tickets/${encodeURIComponent(captchaId)}/start-remote`, {
      method: 'POST',
      headers: authBearerOnly(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '启动失败');
    document.getElementById('remote-msg').textContent = `浏览器已启动 (${data.url || ''})，等待截图...`;
  } catch (e) {
    document.getElementById('remote-msg').textContent = `启动失败: ${e.message}`;
    document.getElementById('remote-placeholder').style.display = 'none';
  }
}

function closeRemoteModal() {
  remoteCaptchaId = null;
  dragStartPos = null;
  document.getElementById('remote-modal').classList.remove('open');
  document.getElementById('remote-modal').setAttribute('aria-hidden', 'true');
  document.getElementById('remote-msg').textContent = '';
}

function onRemoteScreenshot(payload) {
  if (payload.captchaId !== remoteCaptchaId) return;
  const img = document.getElementById('remote-screenshot');
  img.src = 'data:image/jpeg;base64,' + payload.screenshotBase64;
  img.style.display = 'block';
  document.getElementById('remote-placeholder').style.display = 'none';
  document.getElementById('remote-msg').textContent = '截图已更新，可以操作';
}

function getRemoteCoordinates(e) {
  const img = document.getElementById('remote-screenshot');
  const rect = img.getBoundingClientRect();
  const scaleX = img.naturalWidth / rect.width;
  const scaleY = img.naturalHeight / rect.height;
  return {
    x: Math.round((e.clientX - rect.left) * scaleX),
    y: Math.round((e.clientY - rect.top) * scaleY),
  };
}

function sendRemoteInput(msg) {
  if (!captchaWs || captchaWs.readyState !== WebSocket.OPEN || !remoteCaptchaId) return;
  captchaWs.send(JSON.stringify({
    type: 'remote_input',
    payload: { captchaId: remoteCaptchaId, ...msg },
  }));
}

document.getElementById('remote-viewport').addEventListener('click', (e) => {
  if (!remoteCaptchaId) return;
  const mode = document.querySelector('input[name="remote-mode"]:checked')?.value;
  if (mode === 'drag') {
    if (!dragStartPos) {
      dragStartPos = getRemoteCoordinates(e);
      document.getElementById('remote-start-coords').textContent = `${dragStartPos.x},${dragStartPos.y}`;
      document.getElementById('remote-drag-start').style.display = 'inline';
      document.getElementById('remote-msg').textContent = `拖动起点: ${dragStartPos.x},${dragStartPos.y} — 请点击终点`;
    } else {
      const endPos = getRemoteCoordinates(e);
      sendRemoteInput({ action: 'drag', startX: dragStartPos.x, startY: dragStartPos.y, endX: endPos.x, endY: endPos.y, steps: 30 });
      dragStartPos = null;
      document.getElementById('remote-drag-start').style.display = 'none';
      document.getElementById('remote-msg').textContent = `拖动: (${dragStartPos?.x ?? 0},${dragStartPos?.y ?? 0}) → (${endPos.x},${endPos.y}) 已发送`;
    }
  } else {
    const pos = getRemoteCoordinates(e);
    sendRemoteInput({ action: 'click', x: pos.x, y: pos.y });
    document.getElementById('remote-msg').textContent = `点击: ${pos.x},${pos.y} 已发送`;
  }
  document.getElementById('remote-coords').textContent = `${getRemoteCoordinates(e).x},${getRemoteCoordinates(e).y}`;
});

document.getElementById('remote-viewport').addEventListener('mousemove', (e) => {
  if (!remoteCaptchaId) return;
  const pos = getRemoteCoordinates(e);
  document.getElementById('remote-coords').textContent = `${pos.x},${pos.y}`;
});

document.getElementById('remote-refresh-btn').addEventListener('click', () => {
  if (!remoteCaptchaId) return;
  sendRemoteInput({ action: 'click', x: 0, y: 0 });
  document.getElementById('remote-msg').textContent = '刷新中...';
});

document.getElementById('remote-done-btn').addEventListener('click', () => {
  if (!remoteCaptchaId) return;
  sendRemoteInput({ action: 'done' });
  document.getElementById('remote-msg').textContent = '已发送完成信号，等待服务端检查...';
  setTimeout(closeRemoteModal, 3000);
});

document.getElementById('remote-skip-btn').addEventListener('click', () => {
  if (!remoteCaptchaId) return;
  sendRemoteInput({ action: 'skip' });
  document.getElementById('remote-msg').textContent = '已忽略验证码检测，继续爬取...';
  setTimeout(closeRemoteModal, 3000);
});

document.getElementById('remote-close-btn').addEventListener('click', closeRemoteModal);
document.getElementById('remote-modal').addEventListener('click', (e) => {
  if (e.target.id === 'remote-modal') closeRemoteModal();
});

document.querySelectorAll('input[name="remote-mode"]').forEach((r) => {
  r.addEventListener('change', () => {
    const mode = r.value;
    document.getElementById('remote-type-area').style.display = mode === 'type' ? 'block' : 'none';
    dragStartPos = null;
    document.getElementById('remote-drag-start').style.display = 'none';
  });
});

document.getElementById('remote-type-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const text = e.target.value.trim();
    if (text) { sendRemoteInput({ action: 'type', text }); e.target.value = ''; document.getElementById('remote-msg').textContent = `输入: "${text}" 已发送`; }
  }
});

tryRestoreSession();

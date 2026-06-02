/** 当前页全部 Feed缓存，用于编辑弹窗按 id 查找 */
let allFeedsCache = [];
/** 当前用户分组缓存，用于编辑弹窗下拉渲染 */
let feedGroupsCache = [];

function isParsedSourceFeed(feed) {
  return feed && feed.source_type === 'parsed';
}

function authHeaders() {
  const token = localStorage.getItem('anonymousUserToken');
  if (!token) return null;
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function apiOrigin() {
  return API_BASE_URL.replace(/\/?api\/?$/i, '') || window.location.origin;
}

function rssUrlForFeedId(id) {
  return `${apiOrigin()}/api/feeds/${id}/rss`;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

/** API 字段 last_crawl_finished_at：该 Feed 最近一次爬虫任务已记录的结束时间 */
function formatLastCrawlFinished(iso) {
  if (iso == null || iso === '') return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'medium' });
}

function showMsg(text, isError) {
  const el = document.getElementById('article-list-msg');
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
  el.classList.toggle('ok', !isError && !!text);
}

function updateTopNavUserInfo() {
  const userInfoEl = document.getElementById('user-info');
  if (!userInfoEl) return;
  const token = localStorage.getItem('anonymousUserToken');
  const userId = localStorage.getItem('anonymousUserId');
  const username = (localStorage.getItem('anonymousUsername') || '').trim();

  if (!token || !userId) {
    userInfoEl.innerHTML = `
      <a href="register.html" id="register-link" class="user-nav-lucide" title="注册" aria-label="注册"><span class="nav-icon"><i data-lucide="user-plus"></i></span></a>
      <a href="login.html" id="login-link" class="user-nav-lucide" title="登录" aria-label="登录"><span class="nav-icon"><i data-lucide="user"></i></span></a>
    `;
    if (typeof window.refreshLucideIcons === 'function') window.refreshLucideIcons();
    return;
  }

  const safeName = escapeHtml(username || '已登录用户');
  userInfoEl.innerHTML = `<span class="guest-nav-label">当前用户（<a href="profile.html" class="guest-username guest-username-link">${safeName}</a>）</span><a href="profile.html" class="user-nav-lucide" title="个人中心" aria-label="个人中心"><span class="nav-icon"><i data-lucide="user"></i></span></a><a href="#" id="logout-link" class="user-nav-lucide" title="注销" aria-label="注销"><span class="nav-icon"><i data-lucide="log-out"></i></span></a>`;
  const logoutLink = document.getElementById('logout-link');
  if (logoutLink) {
    logoutLink.addEventListener('click', (e) => {
      e.preventDefault();
      localStorage.removeItem('anonymousUserToken');
      localStorage.removeItem('anonymousUserId');
      localStorage.removeItem('anonymousUsername');
      localStorage.removeItem('feedgen_auto_login');
      window.location.href = 'login.html';
    });
  }
  if (typeof window.refreshLucideIcons === 'function') window.refreshLucideIcons();
}

function ensureEditGroupField() {
  const form = document.getElementById('feed-edit-form');
  if (!form || document.getElementById('feed-edit-group')) return;
  const activeRow = document.querySelector('label.my-feeds-check-row');
  if (!activeRow) return;

  const label = document.createElement('label');
  label.setAttribute('for', 'feed-edit-group');
  label.textContent = '分组';

  const select = document.createElement('select');
  select.id = 'feed-edit-group';
  select.className = 'my-feeds-input';
  select.innerHTML = '<option value="">未分组</option>';

  form.insertBefore(label, activeRow);
  form.insertBefore(select, activeRow);
}

function renderEditGroupOptions(groups) {
  ensureEditGroupField();
  const select = document.getElementById('feed-edit-group');
  if (!select) return;
  select.innerHTML = '<option value="">未分组</option>';
  (groups || []).forEach((group) => {
    const opt = document.createElement('option');
    opt.value = String(group.id);
    opt.textContent = group.name;
    select.appendChild(opt);
  });
}

function setFeedCountEl(elId, n) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = n > 0 ? `共 ${n} 个` : '';
}

function faviconUrlFromSite(feedUrl) {
  const raw = String(feedUrl || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return `${u.origin}/favicon.ico`;
  } catch {
    return '';
  }
}

function buildFaviconMarkup(feed) {
  const customText = String(feed?.favicon_custom_text || '').trim().slice(0, 2);
  const customBg = String(feed?.favicon_custom_bg || '').trim() || '#2874a6';
  const url = String(feed?.favicon_url || '').trim() || faviconUrlFromSite(feed?.url || '');
  if (url) {
    return `<span class="my-feeds-favicon-cell"><img src="${escapeHtml(url)}" alt="favicon" loading="lazy" referrerpolicy="no-referrer"></span>`;
  }
  const fallbackText = escapeHtml((customText || String(feed?.title || 'F').trim().slice(0, 1) || 'F').toUpperCase());
  return `<span class="my-feeds-favicon-cell" style="background:${escapeHtml(customBg)};color:#fff;">${fallbackText}</span>`;
}

function buildAntiBotStatusMarkup(feed) {
  const status = String(feed?.anti_bot_status || 'normal').trim();
  const detectedAt = formatLastCrawlFinished(feed?.anti_bot_detected_at);
  const message = String(feed?.anti_bot_message || '').trim();
  const titleParts = [`时间：${detectedAt}`];
  if (message) titleParts.push(`原因：${message}`);
  const title = escapeHtml(titleParts.join('\n'));

  if (status === 'detected') {
    return `<span class="my-feeds-pill my-feeds-pill--warn" title="${title}">反爬</span>`;
  }
  if (status === 'failed') {
    return `<span class="my-feeds-pill my-feeds-pill--error" title="${title}">抓取失败</span>`;
  }
  return '<span class="my-feeds-pill my-feeds-pill--muted">正常</span>';
}

function resolveGroupName(groupId) {
  if (groupId == null || groupId === '') return '未分组';
  const gid = Number(groupId);
  const hit = feedGroupsCache.find((g) => Number(g.id) === gid);
  return hit && hit.name ? hit.name : '未分组';
}

function updateEditFaviconPreview() {
  const preview = document.getElementById('feed-favicon-preview');
  const faviconUrlInput = document.getElementById('feed-edit-favicon-url');
  const faviconTextInput = document.getElementById('feed-edit-favicon-text');
  const faviconBgInput = document.getElementById('feed-edit-favicon-bg');
  if (!preview || !faviconUrlInput || !faviconTextInput || !faviconBgInput) return;
  const url = String(faviconUrlInput.value || '').trim();
  const text = String(faviconTextInput.value || '').trim().slice(0, 2);
  const bg = String(faviconBgInput.value || '#2874a6').trim() || '#2874a6';
  if (url) {
    preview.style.background = '#fff';
    preview.innerHTML = `<img src="${escapeHtml(url)}" alt="favicon预览" loading="lazy" referrerpolicy="no-referrer">`;
    return;
  }
  preview.style.background = bg;
  preview.innerHTML = escapeHtml((text || 'F').slice(0, 2));
}

function renderFeedTable(tbodyId, emptyId, countElId, feeds) {
  const tbody = document.getElementById(tbodyId);
  const emptyEl = document.getElementById(emptyId);
  const list = Array.isArray(feeds) ? feeds : [];

  setFeedCountEl(countElId, list.length);

  if (!list.length) {
    tbody.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  tbody.innerHTML = list
    .map((feed) => {
      const url = feed.url || '';
      const shortUrl = url.length > 48 ? `${url.slice(0, 45)}...` : url;
      const rssUrl = rssUrlForFeedId(feed.id);
      return `
        <tr data-feed-id="${feed.id}">
          <td class="my-feeds-td-favicon">${buildFaviconMarkup(feed)}</td>
          <td class="my-feeds-td-title">${escapeHtml(feed.title || '未命名 Feed')}</td>
          <td class="my-feeds-td-url">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(shortUrl)}</a>` : '—'}</td>
          <td>${escapeHtml(resolveGroupName(feed.group_id))}</td>
          <td>${escapeHtml(feed.feed_type || 'rss')}</td>
          <td>${feed.is_active === false ? '<span class="my-feeds-pill my-feeds-pill--off">停用</span>' : '<span class="my-feeds-pill my-feeds-pill--on">启用</span>'}</td>
          <td>${buildAntiBotStatusMarkup(feed)}</td>
          <td>${feed.update_interval != null ? `${feed.update_interval}s` : '—'}</td>
          <td>${escapeHtml(formatLastCrawlFinished(feed.last_crawl_finished_at))}</td>
          <td><button class="secondary-btn my-feeds-btn-tiny copy-rss-btn" data-rss="${escapeHtml(rssUrl)}">复制</button></td>
          <td class="my-feeds-td-actions">
            <button type="button" class="secondary-btn my-feeds-btn-tiny edit-feed-btn" data-id="${feed.id}">编辑</button>
            <button type="button" class="secondary-btn my-feeds-btn-tiny my-feeds-btn-danger del-feed-btn" data-id="${feed.id}">删除</button>
          </td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('.copy-rss-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rss = btn.getAttribute('data-rss');
      if (!rss) return;
      navigator.clipboard.writeText(rss).then(
        () => showMsg('RSS 地址已复制', false),
        () => showMsg('复制失败，请手动复制', true)
      );
    });
  });

  tbody.querySelectorAll('.edit-feed-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.getAttribute('data-id'), 10);
      const feed = allFeedsCache.find((x) => x.id === id);
      if (feed) openEditModal(feed);
    });
  });

  tbody.querySelectorAll('.del-feed-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const headers = authHeaders();
      if (!headers) return;
      const id = parseInt(btn.getAttribute('data-id'), 10);
      if (!confirm(`确定删除 Feed #${id}？此操作不可恢复。`)) return;
      const res = await fetch(`${API_BASE_URL}/feeds/${id}`, {
        method: 'DELETE',
        headers: { Authorization: headers.Authorization },
      });
      const data = await res.json();
      if (!res.ok) {
        showMsg(data.error || '删除失败', true);
        return;
      }
      showMsg('已删除', false);
      loadAll();
    });
  });
}

async function loadAll() {
  const headers = authHeaders();
  const authEl = document.getElementById('article-list-auth-msg');
  if (!headers) {
    authEl.classList.remove('hidden');
    return;
  }
  authEl.classList.add('hidden');

  try {
    const [subRes, myFeedRes] = await Promise.all([
      fetch(`${API_BASE_URL}/feed-subscriptions`, { headers }),
      fetch(`${API_BASE_URL}/feeds`, { headers }),
    ]);

    const subData = await subRes.json();
    const myFeedData = await myFeedRes.json();

    if (!subRes.ok) throw new Error(subData.error || '加载订阅失败');
    if (!myFeedRes.ok) throw new Error(myFeedData.error || '加载我的 feeds 失败');

    const feeds = myFeedData.feeds || [];
    allFeedsCache = feeds;
    feedGroupsCache = subData.groups || [];
    const nativeFeeds = feeds.filter((f) => !isParsedSourceFeed(f));
    const parsedFeeds = feeds.filter(isParsedSourceFeed);

    renderEditGroupOptions(feedGroupsCache);
    renderFeedTable('article-list-tbody', 'article-list-empty', 'native-feeds-count', nativeFeeds);
    renderFeedTable('parsed-feeds-tbody', 'parsed-feeds-empty', 'parsed-feeds-count', parsedFeeds);
  } catch (e) {
    showMsg(e.message || '加载失败', true);
  }
}

function openEditModal(feed) {
  const modal = document.getElementById('feed-edit-modal');
  ensureEditGroupField();
  renderEditGroupOptions(feedGroupsCache);
  document.getElementById('feed-edit-id').value = String(feed.id);
  document.getElementById('feed-edit-title-input').value = feed.title || '';
  document.getElementById('feed-edit-url').value = feed.url || '';
  document.getElementById('feed-edit-desc').value = feed.description || '';
  document.getElementById('feed-edit-type').value = feed.feed_type || 'rss';
  document.getElementById('feed-edit-interval').value = feed.update_interval != null ? String(feed.update_interval) : '1800';
  document.getElementById('feed-edit-group').value = feed.group_id != null ? String(feed.group_id) : '';
  document.getElementById('feed-edit-favicon-url').value = feed.favicon_url || '';
  document.getElementById('feed-edit-favicon-text').value = feed.favicon_custom_text || '';
  document.getElementById('feed-edit-favicon-bg').value = /^#[0-9a-fA-F]{6}$/.test(String(feed.favicon_custom_bg || '')) ? String(feed.favicon_custom_bg) : '#2874a6';
  document.getElementById('feed-edit-active').checked = feed.is_active !== false;
  document.getElementById('feed-edit-selectors').value = feed.selector_rules != null ? JSON.stringify(feed.selector_rules, null, 2) : '';
  updateEditFaviconPreview();
  const msgEl = document.getElementById('feed-edit-msg');
  msgEl.textContent = '';
  msgEl.classList.remove('error', 'ok');
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeEditModal() {
  const modal = document.getElementById('feed-edit-modal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

document.addEventListener('DOMContentLoaded', () => {
  updateTopNavUserInfo();
  loadAll();
  document.getElementById('article-list-refresh').addEventListener('click', loadAll);
  document.getElementById('parsed-feeds-refresh').addEventListener('click', loadAll);
  document.getElementById('feed-edit-backdrop').addEventListener('click', closeEditModal);
  document.getElementById('feed-edit-cancel').addEventListener('click', closeEditModal);
  document.getElementById('feed-edit-favicon-url').addEventListener('input', updateEditFaviconPreview);
  document.getElementById('feed-edit-favicon-text').addEventListener('input', updateEditFaviconPreview);
  document.getElementById('feed-edit-favicon-bg').addEventListener('input', updateEditFaviconPreview);
  document.getElementById('feed-favicon-fetch-btn').addEventListener('click', () => {
    const sourceUrl = String(document.getElementById('feed-edit-url').value || '').trim();
    const autoUrl = faviconUrlFromSite(sourceUrl);
    if (!autoUrl) {
      const msgEl = document.getElementById('feed-edit-msg');
      msgEl.textContent = '请先填写合法的源站 URL，再拉取 favicon';
      msgEl.classList.add('error');
      return;
    }
    document.getElementById('feed-edit-favicon-url').value = autoUrl;
    updateEditFaviconPreview();
  });
  document.getElementById('feed-edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msgEl = document.getElementById('feed-edit-msg');
    msgEl.textContent = '';
    msgEl.classList.remove('error', 'ok');

    const headers = authHeaders();
    if (!headers) {
      msgEl.textContent = '未登录';
      msgEl.classList.add('error');
      return;
    }

    const id = parseInt(document.getElementById('feed-edit-id').value, 10);
    const title = document.getElementById('feed-edit-title-input').value.trim();
    const urlRaw = document.getElementById('feed-edit-url').value.trim();
    const description = document.getElementById('feed-edit-desc').value;
    const feedType = document.getElementById('feed-edit-type').value.trim() || 'rss';
    const intervalVal = document.getElementById('feed-edit-interval').value;
    const groupVal = document.getElementById('feed-edit-group').value.trim();
    const isActive = document.getElementById('feed-edit-active').checked;
    const selectorText = document.getElementById('feed-edit-selectors').value.trim();
    const faviconUrl = document.getElementById('feed-edit-favicon-url').value.trim();
    const faviconCustomText = document.getElementById('feed-edit-favicon-text').value.trim().slice(0, 2);
    const faviconCustomBg = document.getElementById('feed-edit-favicon-bg').value.trim();

    if (!title) {
      msgEl.textContent = '请填写标题';
      msgEl.classList.add('error');
      return;
    }

    let selectorRules = null;
    if (selectorText) {
      try {
        selectorRules = JSON.parse(selectorText);
        if (selectorRules !== null && typeof selectorRules !== 'object') {
          throw new Error('selector_rules must be object');
        }
      } catch {
        msgEl.textContent = '选择器规则不是合法 JSON';
        msgEl.classList.add('error');
        return;
      }
    }

    const body = {
      name: title,
      targetUrl: urlRaw || null,
      description,
      feed_type: feedType,
      is_active: isActive,
      update_interval: parseInt(intervalVal, 10),
      group_id: groupVal ? parseInt(groupVal, 10) : null,
      selector_rules: selectorRules,
      favicon_url: faviconUrl || null,
      favicon_custom_text: faviconCustomText || null,
      favicon_custom_bg: /^#[0-9a-fA-F]{6}$/.test(faviconCustomBg) ? faviconCustomBg : null,
    };

    if (!Number.isFinite(body.update_interval) || body.update_interval < 60) {
      msgEl.textContent = '更新间隔须为不小于 60 的整数';
      msgEl.classList.add('error');
      return;
    }

    const res = await fetch(`${API_BASE_URL}/feeds/${id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      msgEl.textContent = data.error || '保存失败';
      msgEl.classList.add('error');
      return;
    }

    closeEditModal();
    showMsg('Feed 已更新', false);
    loadAll();
  });
});

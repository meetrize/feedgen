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
      if (feed) FeedEdit.open(feed);
    });
  });

  tbody.querySelectorAll('.del-feed-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.getAttribute('data-id'), 10);
      await FeedEdit.deleteFeed(id);
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
    FeedEdit.setFeeds(feeds);
    FeedEdit.setGroups(feedGroupsCache);
    const nativeFeeds = feeds.filter((f) => !isParsedSourceFeed(f));
    const parsedFeeds = feeds.filter(isParsedSourceFeed);

    renderFeedTable('article-list-tbody', 'article-list-empty', 'native-feeds-count', nativeFeeds);
    renderFeedTable('parsed-feeds-tbody', 'parsed-feeds-empty', 'parsed-feeds-count', parsedFeeds);
  } catch (e) {
    showMsg(e.message || '加载失败', true);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  FeedEdit.init({ showMsg, onSaved: loadAll, onDeleted: loadAll });
  updateTopNavUserInfo();
  loadAll();
  document.getElementById('article-list-refresh').addEventListener('click', loadAll);
  document.getElementById('parsed-feeds-refresh').addEventListener('click', loadAll);
});

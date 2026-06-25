(function () {
  const apiBase =
    typeof API_BASE_URL !== 'undefined'
      ? API_BASE_URL
      : (window.API_BASE_URL || '/api');
  const LIMIT = 24;
  let page = 1;
  let total = 0;
  let activeFilter = '';
  let searchQuery = '';
  let sort = 'subscriber_count';
  let searchTimer = null;

  function authHeaders() {
    const token = localStorage.getItem('anonymousUserToken');
    if (!token) return null;
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatRelativeTime(iso) {
    if (!iso) return '暂无更新';
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return '暂无更新';
    const diff = Date.now() - then.getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚更新';
    if (min < 60) return `${min} 分钟前更新`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour} 小时前更新`;
    const day = Math.floor(hour / 24);
    return `${day} 天前更新`;
  }

  function formatDomain(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url || '';
    }
  }

  function formatSubscribers(count) {
    const n = Number(count) || 0;
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k 订阅`;
    return `${n} 订阅`;
  }

  function buildCard(feed) {
    const suspended = feed.status === 'suspended';
    const subscribed = !!feed.already_subscribed;
    const contributor = feed.contributor
      ? `@${feed.contributor.display_name || feed.contributor.username} 贡献`
      : feed.contributor_label || '平台维护';
    const favicon = window.FeedFavicon
      ? window.FeedFavicon.buildFeedFaviconMarkup(feed, { cellClass: 'my-feeds-favicon-cell' })
      : '';
    const badges = [
      feed.verified ? '<span class="public-feed-badge verified">官方认证</span>' : '',
      feed.source_type === 'parsed'
        ? '<span class="public-feed-badge">解析源</span>'
        : '<span class="public-feed-badge">RSS</span>',
      feed.requires_auth ? '<span class="public-feed-badge">需自备 Cookie</span>' : '',
    ].join('');
    const action = suspended
      ? '<span class="public-feed-badge">暂不可用</span>'
      : `<button type="button" class="${subscribed ? 'is-subscribed' : ''}" data-subscribe-id="${feed.id}" data-subscribed="${subscribed ? '1' : '0'}">${subscribed ? '已订阅 ✓' : '订阅'}</button>`;

    return `<article class="public-feed-card${suspended ? ' is-suspended' : ''}" data-feed-id="${feed.id}">
      <div class="public-feed-card-head">
        ${favicon}
        <div style="min-width:0;flex:1;">
          <div class="public-feed-card-title">${escapeHtml(feed.title)}</div>
          <div class="public-feed-card-domain">${escapeHtml(formatDomain(feed.url))}</div>
          <div class="public-feed-card-badges">${badges}</div>
        </div>
      </div>
      <div class="public-feed-card-desc">${escapeHtml(feed.description || '暂无描述')}</div>
      <div class="public-feed-card-meta">👤 ${escapeHtml(contributor)}</div>
      <div class="public-feed-card-meta">${escapeHtml(formatSubscribers(feed.subscriber_count))} · ${escapeHtml(formatRelativeTime(feed.last_fetched_at))}</div>
      <div class="public-feed-card-actions">${action}</div>
    </article>`;
  }

  async function loadFeeds() {
    const grid = document.getElementById('public-feeds-grid');
    const totalEl = document.getElementById('public-feeds-total');
    if (!grid) return;
    grid.innerHTML = '<div class="public-feeds-loading">加载中…</div>';

    const params = new URLSearchParams({
      page: String(page),
      limit: String(LIMIT),
      sort,
    });
    if (searchQuery) params.set('q', searchQuery);
    if (activeFilter) {
      activeFilter.split('&').forEach((pair) => {
        const [k, v] = pair.split('=');
        if (k && v) params.set(k, v);
      });
    }

    const headers = authHeaders() || {};
    const res = await fetch(`${apiBase}/public-feeds?${params}`, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      grid.innerHTML = `<div class="public-feeds-empty">${escapeHtml(data.error || '加载失败')}</div>`;
      return;
    }

    total = Number(data.total) || 0;
    if (totalEl) totalEl.textContent = `共 ${total} 个源`;
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
      grid.innerHTML = '<div class="public-feeds-empty">无匹配结果，换个关键词或分类试试</div>';
    } else {
      grid.innerHTML = items.map(buildCard).join('');
    }
    renderPagination();
    bindSubscribeButtons();
  }

  function renderPagination() {
    const nav = document.getElementById('public-feeds-pagination');
    if (!nav) return;
    const totalPages = Math.max(1, Math.ceil(total / LIMIT));
    nav.innerHTML = `
      <button type="button" id="public-feeds-prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <span style="align-self:center;color:#7a8794;font-size:13px;">${page} / ${totalPages}</span>
      <button type="button" id="public-feeds-next" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
    `;
    const prev = document.getElementById('public-feeds-prev');
    const next = document.getElementById('public-feeds-next');
    if (prev) prev.addEventListener('click', () => { if (page > 1) { page -= 1; loadFeeds(); } });
    if (next) next.addEventListener('click', () => {
      const totalPages = Math.max(1, Math.ceil(total / LIMIT));
      if (page < totalPages) { page += 1; loadFeeds(); }
    });
  }

  function showToast(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1e3a4c;color:#fff;padding:10px 16px;border-radius:8px;z-index:9999;font-size:14px;';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

  function bindSubscribeButtons() {
    document.querySelectorAll('[data-subscribe-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const headers = authHeaders();
        if (!headers) {
          window.location.href = `login.html?redirect=${encodeURIComponent('public-feeds.html')}`;
          return;
        }
        const feedId = Number(btn.getAttribute('data-subscribe-id'));
        const subscribed = btn.getAttribute('data-subscribed') === '1';
        if (subscribed) {
          showToast('请在阅读器订阅列表中管理公开订阅');
          return;
        }
        const card = document.querySelector(`.public-feed-card[data-feed-id="${feedId}"]`);
        const requiresAuth = card && card.textContent.includes('需自备 Cookie');
        if (requiresAuth && !window.confirm('该源可能需要登录态，订阅后请自行配置 Cookie。是否继续？')) {
          return;
        }
        btn.disabled = true;
        try {
          const res = await fetch(`${apiBase}/public-subscriptions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ public_feed_id: feedId }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || '订阅失败');
          btn.textContent = '已订阅 ✓';
          btn.classList.add('is-subscribed');
          btn.setAttribute('data-subscribed', '1');
          showToast('已加入订阅列表');
        } catch (error) {
          showToast(error.message || '订阅失败');
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  function bindToolbar() {
    const searchInput = document.getElementById('public-feeds-search');
    const clearBtn = document.getElementById('public-feeds-search-clear');
    const sortSelect = document.getElementById('public-feeds-sort');
    const chips = document.getElementById('public-feeds-chips');

    if (searchInput) {
      searchInput.addEventListener('input', () => {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          searchQuery = searchInput.value.trim();
          page = 1;
          loadFeeds();
        }, 300);
      });
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          if (searchTimer) clearTimeout(searchTimer);
          searchQuery = searchInput.value.trim();
          page = 1;
          loadFeeds();
        }
      });
    }
    if (clearBtn && searchInput) {
      clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        searchQuery = '';
        page = 1;
        loadFeeds();
      });
    }
    if (sortSelect) {
      sortSelect.addEventListener('change', () => {
        sort = sortSelect.value;
        page = 1;
        loadFeeds();
      });
    }
    if (chips) {
      chips.addEventListener('click', (e) => {
        const btn = e.target.closest('.public-feeds-chip');
        if (!btn) return;
        chips.querySelectorAll('.public-feeds-chip').forEach((el) => el.classList.remove('active'));
        btn.classList.add('active');
        activeFilter = btn.getAttribute('data-filter') || '';
        page = 1;
        loadFeeds();
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindToolbar();
    loadFeeds();
  });
})();

/**
 * Feed 编辑/删除弹窗（my-feeds.html、crawler-strategy.html 等页面共用）
 */
const FeedEdit = (function () {
  let groupsCache = [];
  let feedsCache = [];
  let onSaved = null;
  let onDeleted = null;
  let showMsgFn = null;
  let inited = false;

  function authHeaders() {
    const token = localStorage.getItem('anonymousUserToken');
    if (!token) return null;
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
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

  function open(feed) {
    const modal = document.getElementById('feed-edit-modal');
    if (!modal || !feed) return;
    ensureEditGroupField();
    renderEditGroupOptions(groupsCache);
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
    const useProxyYes = document.getElementById('feed-edit-use-proxy-yes');
    const useProxyNo = document.getElementById('feed-edit-use-proxy-no');
    if (useProxyYes instanceof HTMLInputElement && useProxyNo instanceof HTMLInputElement) {
      useProxyYes.checked = feed.use_proxy === true;
      useProxyNo.checked = feed.use_proxy !== true;
    }
    const needsTranslationEl = document.getElementById('feed-edit-needs-translation');
    if (needsTranslationEl instanceof HTMLInputElement) {
      needsTranslationEl.checked = feed.needs_translation === true;
    }
    document.getElementById('feed-edit-selectors').value = feed.selector_rules != null ? JSON.stringify(feed.selector_rules, null, 2) : '';
    updateEditFaviconPreview();
    const msgEl = document.getElementById('feed-edit-msg');
    msgEl.textContent = '';
    msgEl.classList.remove('error', 'ok');
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
  }

  function close() {
    const modal = document.getElementById('feed-edit-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  async function deleteFeed(id) {
    const headers = authHeaders();
    if (!headers) return false;
    if (!confirm(`确定删除 Feed #${id}？此操作不可恢复。`)) return false;
    const res = await fetch(`${API_BASE_URL}/feeds/${id}`, {
      method: 'DELETE',
      headers: { Authorization: headers.Authorization },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showMsgFn?.(data.error || '删除失败', true);
      return false;
    }
    feedsCache = feedsCache.filter((f) => f.id !== id);
    showMsgFn?.('已删除', false);
    if (typeof onDeleted === 'function') await onDeleted(id);
    return true;
  }

  async function loadData() {
    const headers = authHeaders();
    if (!headers) {
      groupsCache = [];
      feedsCache = [];
      return { feeds: [], groups: [] };
    }
    const [subRes, feedRes] = await Promise.all([
      fetch(`${API_BASE_URL}/feed-subscriptions`, { headers }),
      fetch(`${API_BASE_URL}/feeds`, { headers }),
    ]);
    const subData = await subRes.json().catch(() => ({}));
    const feedData = await feedRes.json().catch(() => ({}));
    if (!subRes.ok) throw new Error(subData.error || '加载订阅失败');
    if (!feedRes.ok) throw new Error(feedData.error || '加载 feeds 失败');
    groupsCache = subData.groups || [];
    feedsCache = feedData.feeds || [];
    renderEditGroupOptions(groupsCache);
    return { feeds: feedsCache, groups: groupsCache };
  }

  function findFeed(id) {
    return feedsCache.find((x) => x.id === id);
  }

  function init(options = {}) {
    if (inited) return;
    inited = true;
    onSaved = options.onSaved || null;
    onDeleted = options.onDeleted || null;
    showMsgFn = options.showMsg || null;

    document.getElementById('feed-edit-backdrop')?.addEventListener('click', close);
    document.getElementById('feed-edit-cancel')?.addEventListener('click', close);
    document.getElementById('feed-edit-favicon-url')?.addEventListener('input', updateEditFaviconPreview);
    document.getElementById('feed-edit-favicon-text')?.addEventListener('input', updateEditFaviconPreview);
    document.getElementById('feed-edit-favicon-bg')?.addEventListener('input', updateEditFaviconPreview);
    document.getElementById('feed-favicon-fetch-btn')?.addEventListener('click', () => {
      const sourceUrl = String(document.getElementById('feed-edit-url')?.value || '').trim();
      const autoUrl = faviconUrlFromSite(sourceUrl);
      if (!autoUrl) {
        const msgEl = document.getElementById('feed-edit-msg');
        if (msgEl) {
          msgEl.textContent = '请先填写合法的源站 URL，再拉取 favicon';
          msgEl.classList.add('error');
        }
        return;
      }
      document.getElementById('feed-edit-favicon-url').value = autoUrl;
      updateEditFaviconPreview();
    });
    document.getElementById('feed-edit-form')?.addEventListener('submit', async (e) => {
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
      const useProxyYes = document.getElementById('feed-edit-use-proxy-yes');
      const useProxy = useProxyYes instanceof HTMLInputElement && useProxyYes.checked;
      const needsTranslationEl = document.getElementById('feed-edit-needs-translation');
      const needsTranslation = needsTranslationEl instanceof HTMLInputElement && needsTranslationEl.checked;
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
        use_proxy: useProxy,
        needs_translation: needsTranslation,
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
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        msgEl.textContent = data.error || '保存失败';
        msgEl.classList.add('error');
        return;
      }

      close();
      showMsgFn?.('Feed 已更新', false);
      if (typeof onSaved === 'function') await onSaved(id);
    });
  }

  return {
    init,
    open,
    close,
    deleteFeed,
    loadData,
    findFeed,
    setFeeds(feeds) { feedsCache = feeds || []; },
    setGroups(groups) { groupsCache = groups || []; renderEditGroupOptions(groupsCache); },
    getFeeds() { return feedsCache; },
    getGroups() { return groupsCache; },
  };
})();

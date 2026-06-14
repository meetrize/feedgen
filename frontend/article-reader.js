const ALL_FEED_ID = '__all__';
const ARTICLE_READER_SELECTION_STORAGE_KEY = 'article_reader_last_selection_v1';
const ARTICLE_READER_GROUP_COLLAPSE_STORAGE_KEY = 'article_reader_group_collapsed_v1';
const ARTICLE_READER_PAGE_SIZE_KEY = 'article_reader_page_size_v1';
const ARTICLE_READER_PAGINATION_POS_KEY = 'article_reader_pagination_pos_v1';
let activeFeedId = null;
let activeGroupId = null;
let activeFeedTitle = '';
let activeScope = 'all';
let activeTagId = null;
let activeCategoryId = null;
let activeUnreadOnly = false;
const ARTICLE_READER_TAGS_COLLAPSE_STORAGE_KEY = 'article_reader_tags_collapsed_v1';
const ARTICLE_READER_CATEGORIES_COLLAPSE_STORAGE_KEY = 'article_reader_categories_collapsed_v1';
let sidebarTagsCollapsed = false;
let sidebarCategoriesCollapsed = false;
let sidebarTagsState = [];
let sidebarCategoriesState = [];
let contextMenuTag = null;
let menuState = [];
let currentArticles = [];
let activeArticleIndex = -1;
/** 列表页码（从 1 开始） */
let articleListPage = 1;
/** 每页条数 */
let articlePageSize = 20;
/** 当前筛选条件下的文章总数（用于分页） */
let articleTotalCount = 0;
let loadArticlesDepth = 0;
let contextMenuGroup = null;
let contextMenuFeed = null;
let articleActionMenuState = { index: null };
let categoryAnnotateMenuState = { index: null };
let feedTitleAutoFillController = null;
let feedTitleAutoFillTimer = null;
const FEED_SHOW_ORIGINAL_STORAGE_KEY = 'feedgen_feed_show_original_v1';
let feedShowOriginalIds = new Set();

function loadFeedShowOriginalIds() {
  try {
    const raw = localStorage.getItem(FEED_SHOW_ORIGINAL_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((id) => Number(id)).filter((id) => Number.isFinite(id)));
  } catch {
    return new Set();
  }
}

function saveFeedShowOriginalIds() {
  localStorage.setItem(
    FEED_SHOW_ORIGINAL_STORAGE_KEY,
    JSON.stringify(Array.from(feedShowOriginalIds)),
  );
}

function isFeedShowingOriginal(feedId) {
  const id = Number(feedId);
  return Number.isFinite(id) && feedShowOriginalIds.has(id);
}

function setFeedShowingOriginal(feedId, showOriginal) {
  const id = Number(feedId);
  if (!Number.isFinite(id)) return;
  if (showOriginal) feedShowOriginalIds.add(id);
  else feedShowOriginalIds.delete(id);
  saveFeedShowOriginalIds();
}

feedShowOriginalIds = loadFeedShowOriginalIds();

function redirectToLogin() {
  localStorage.removeItem('anonymousUserToken');
  localStorage.removeItem('anonymousUserId');
  localStorage.removeItem('anonymousUsername');
  window.location.href = 'login.html';
}

function saveSidebarSelection() {
  const payload = {
    activeScope: String(activeScope || 'all'),
    activeTagId: activeTagId == null ? null : Number(activeTagId),
    activeCategoryId: activeCategoryId == null ? null : Number(activeCategoryId),
    activeUnreadOnly: !!activeUnreadOnly,
    activeFeedId: activeFeedId == null ? null : String(activeFeedId),
    activeGroupId: activeGroupId == null ? null : String(activeGroupId),
    activeFeedTitle: String(activeFeedTitle || ''),
  };
  try {
    localStorage.setItem(ARTICLE_READER_SELECTION_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.error('saveSidebarSelection failed:', error);
  }
}

function readGroupCollapsedMap() {
  try {
    const raw = localStorage.getItem(ARTICLE_READER_GROUP_COLLAPSE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const result = {};
    Object.keys(parsed).forEach((key) => {
      if (parsed[key]) result[String(key)] = true;
    });
    return result;
  } catch (error) {
    console.error('readGroupCollapsedMap failed:', error);
    return {};
  }
}

function saveGroupCollapsedState() {
  const collapsedMap = {};
  (menuState || []).forEach((group) => {
    if (group?.id == null) return;
    if (group.collapsed) collapsedMap[String(group.id)] = true;
  });
  try {
    localStorage.setItem(ARTICLE_READER_GROUP_COLLAPSE_STORAGE_KEY, JSON.stringify(collapsedMap));
  } catch (error) {
    console.error('saveGroupCollapsedState failed:', error);
  }
}

function applyGroupCollapsedFromStorage() {
  const collapsedMap = readGroupCollapsedMap();
  (menuState || []).forEach((group) => {
    if (group?.id == null) return;
    group.collapsed = !!collapsedMap[String(group.id)];
  });
}

function readSidebarSelection() {
  try {
    const raw = localStorage.getItem(ARTICLE_READER_SELECTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const scope = String(parsed.activeScope || 'all');
    const tagIdRaw = parsed.activeTagId == null ? null : Number(parsed.activeTagId);
    const categoryIdRaw = parsed.activeCategoryId == null ? null : Number(parsed.activeCategoryId);
    return {
      activeScope: scope,
      activeTagId: Number.isFinite(tagIdRaw) ? tagIdRaw : null,
      activeCategoryId: Number.isFinite(categoryIdRaw) ? categoryIdRaw : null,
      activeUnreadOnly: !!parsed.activeUnreadOnly,
      activeFeedId: parsed.activeFeedId == null ? null : String(parsed.activeFeedId),
      activeGroupId: parsed.activeGroupId == null ? null : String(parsed.activeGroupId),
      activeFeedTitle: String(parsed.activeFeedTitle || ''),
    };
  } catch (error) {
    console.error('readSidebarSelection failed:', error);
    return null;
  }
}

function setSelectionToAllAndPersist() {
  activeScope = 'all';
  activeTagId = null;
  activeCategoryId = null;
  activeUnreadOnly = false;
  activeGroupId = null;
  activeFeedId = ALL_FEED_ID;
  activeFeedTitle = '全部文章';
  updateCurrentFeedTitle('全部文章');
  syncTagFilterChrome();
  saveSidebarSelection();
}

function applyRestoredSidebarSelection() {
  const restored = readSidebarSelection();
  if (!restored) return;
  if (restored.activeScope === 'category' && restored.activeCategoryId != null) {
    activeScope = 'category';
    activeCategoryId = restored.activeCategoryId;
    activeTagId = null;
  } else if (restored.activeScope === 'tag' && restored.activeTagId != null) {
    activeScope = 'tag';
    activeTagId = restored.activeTagId;
    activeCategoryId = null;
  } else if (restored.activeScope === 'today' || restored.activeScope === 'liked') {
    activeScope = restored.activeScope;
    activeTagId = null;
    activeCategoryId = null;
  } else {
    activeScope = 'all';
    activeTagId = null;
    activeCategoryId = null;
  }
  activeUnreadOnly = !!restored.activeUnreadOnly && activeScope === 'today';
  activeFeedId = restored.activeFeedId;
  activeGroupId = restored.activeGroupId;
  activeFeedTitle = restored.activeFeedTitle || '';
  try {
    sidebarTagsCollapsed = localStorage.getItem(ARTICLE_READER_TAGS_COLLAPSE_STORAGE_KEY) === '1';
    sidebarCategoriesCollapsed = localStorage.getItem(ARTICLE_READER_CATEGORIES_COLLAPSE_STORAGE_KEY) === '1';
  } catch (error) {
    sidebarTagsCollapsed = false;
    sidebarCategoriesCollapsed = false;
  }
}

function clearActiveScopeFilter() {
  const hadTag = activeScope === 'tag' && activeTagId != null;
  const hadCategory = activeScope === 'category' && activeCategoryId != null;
  if (!hadTag && !hadCategory) return;
  activeTagId = null;
  activeCategoryId = null;
  activeScope = 'all';
  activeFeedId = activeFeedId || ALL_FEED_ID;
  syncTagFilterChrome();
  saveSidebarSelection();
}

function clearActiveTagFilter() {
  clearActiveScopeFilter();
}

function getActiveTagMeta() {
  if (activeTagId == null) return null;
  return (
    sidebarTagsState.find((tag) => Number(tag.id) === Number(activeTagId)) ||
    userTagsVocabularyCache.find((tag) => Number(tag.id) === Number(activeTagId)) ||
    null
  );
}

function getActiveCategoryMeta() {
  if (activeCategoryId == null) return null;
  return (
    sidebarCategoriesState.find((cat) => Number(cat.id) === Number(activeCategoryId)) || null
  );
}

function syncTagFilterChrome() {
  const clearBtn = document.getElementById('article-reader-clear-tag-filter');
  const inTagScope = activeScope === 'tag' && activeTagId != null;
  const inCategoryScope = activeScope === 'category' && activeCategoryId != null;
  if (clearBtn) clearBtn.classList.toggle('hidden', !inTagScope && !inCategoryScope);
  if (inCategoryScope) {
    const cat = getActiveCategoryMeta();
    updateCurrentFeedTitle(`主题：${cat?.name || activeCategoryId}`);
  } else if (inTagScope) {
    const tag = getActiveTagMeta();
    updateCurrentFeedTitle(`标签：${tag?.name || activeTagId}`);
  }
  syncQuickScopeButtons();
  renderSidebarCategories();
  renderSidebarTags();
}

async function selectCategoryFilter(categoryId, categoryName) {
  const id = Number(categoryId);
  if (!Number.isFinite(id)) return;
  resetArticleListPage();
  activeCategoryId = id;
  activeScope = 'category';
  activeTagId = null;
  activeUnreadOnly = false;
  activeFeedTitle = `主题：${categoryName || id}`;
  syncTagFilterChrome();
  saveSidebarSelection();
  await loadArticles();
}

async function selectTagFilter(tagId, tagName) {
  const id = Number(tagId);
  if (!Number.isFinite(id)) return;
  resetArticleListPage();
  activeTagId = id;
  activeCategoryId = null;
  activeScope = 'tag';
  activeUnreadOnly = false;
  activeFeedTitle = `标签：${tagName || id}`;
  syncTagFilterChrome();
  saveSidebarSelection();
  await loadArticles();
}

function readSidebarTagsCollapsed() {
  try {
    return localStorage.getItem(ARTICLE_READER_TAGS_COLLAPSE_STORAGE_KEY) === '1';
  } catch (error) {
    return false;
  }
}

function saveSidebarTagsCollapsed() {
  try {
    localStorage.setItem(ARTICLE_READER_TAGS_COLLAPSE_STORAGE_KEY, sidebarTagsCollapsed ? '1' : '0');
  } catch (error) {
    console.error('saveSidebarTagsCollapsed failed:', error);
  }
}

function renderSidebarTags() {
  const listEl = document.getElementById('article-reader-tags-list');
  const section = document.getElementById('article-reader-tags-section');
  const chevron = document.getElementById('article-reader-tags-chevron');
  if (!listEl || !section) return;

  section.classList.toggle('is-collapsed', !!sidebarTagsCollapsed);
  if (chevron) {
    const icon = chevron.querySelector('[data-lucide]');
    if (icon) icon.setAttribute('data-lucide', sidebarTagsCollapsed ? 'chevron-right' : 'chevron-down');
    chevron.setAttribute('aria-expanded', sidebarTagsCollapsed ? 'false' : 'true');
    chevron.setAttribute('aria-label', sidebarTagsCollapsed ? '展开标签列表' : '折叠标签列表');
    chevron.setAttribute('title', sidebarTagsCollapsed ? '展开标签列表' : '折叠标签列表');
  }

  const tags = Array.isArray(sidebarTagsState) ? sidebarTagsState : [];
  if (!tags.length) {
    listEl.innerHTML = '<div class="article-reader-tags-empty">暂无标签</div>';
    if (typeof window.refreshLucideIcons === 'function') window.refreshLucideIcons();
    return;
  }

  listEl.innerHTML = tags
    .map((tag) => {
      const tagId = Number(tag.id);
      const activeClass = activeScope === 'tag' && Number(activeTagId) === tagId ? ' active' : '';
      const dotStyle = tagChipInlineStyle(tag.color) || 'background:#adb5bd;';
      const count = Number.isFinite(Number(tag.article_count)) ? Math.max(0, Number(tag.article_count)) : 0;
      return `<div class="article-reader-tag-row">
        <button type="button" class="article-reader-tag-btn${activeClass}" data-tag-select-id="${tagId}" data-tag-name="${escapeHtml(String(tag.name || ''))}">
          <span class="article-reader-tag-dot" style="${dotStyle}"></span>
          <span class="article-reader-tag-name">${escapeHtml(String(tag.name || ''))}</span>
          <span class="article-reader-tag-count">${escapeHtml(String(count))}</span>
        </button>
        <button type="button" class="article-reader-tag-more-btn" data-tag-menu-id="${tagId}" aria-label="标签操作" title="标签操作">⋮</button>
      </div>`;
    })
    .join('');

  if (typeof window.refreshLucideIcons === 'function') window.refreshLucideIcons();

  listEl.querySelectorAll('[data-tag-select-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tagId = Number(btn.getAttribute('data-tag-select-id'));
      const tagName = btn.getAttribute('data-tag-name') || '';
      if (!Number.isFinite(tagId)) return;
      await selectTagFilter(tagId, tagName);
    });
  });

  listEl.querySelectorAll('[data-tag-menu-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const tagId = Number(btn.getAttribute('data-tag-menu-id'));
      const tag = sidebarTagsState.find((item) => Number(item.id) === tagId);
      if (!tag) return;
      const rect = btn.getBoundingClientRect();
      openTagContextMenu(rect.right, rect.bottom + 4, tag);
    });
    btn.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const tagId = Number(btn.getAttribute('data-tag-menu-id'));
      const tag = sidebarTagsState.find((item) => Number(item.id) === tagId);
      if (!tag) return;
      openTagContextMenu(event.clientX, event.clientY, tag);
    });
  });

  listEl.querySelectorAll('[data-tag-select-id]').forEach((btn) => {
    btn.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const tagId = Number(btn.getAttribute('data-tag-select-id'));
      const tag = sidebarTagsState.find((item) => Number(item.id) === tagId);
      if (!tag) return;
      openTagContextMenu(event.clientX, event.clientY, tag);
    });
  });
}

async function loadSidebarTags() {
  const headers = authHeaders();
  const listEl = document.getElementById('article-reader-tags-list');
  if (!listEl) return;
  if (!headers) {
    sidebarTagsState = [];
    listEl.innerHTML = '<div class="article-reader-tags-empty">登录后可用</div>';
    return;
  }
  try {
    const res = await fetch(`${API_BASE_URL}/feed-subscriptions/tags`, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '加载标签失败');
    sidebarTagsState = Array.isArray(data.tags) ? data.tags : [];
    userTagsVocabularyCache = sidebarTagsState;
    if (activeScope === 'tag' && activeTagId != null) {
      const exists = sidebarTagsState.some((tag) => Number(tag.id) === Number(activeTagId));
      if (!exists) {
        clearActiveScopeFilter();
        await loadArticles();
      }
    }
    renderSidebarTags();
  } catch (error) {
    console.error('loadSidebarTags failed:', error);
    listEl.innerHTML = '<div class="article-reader-tags-empty">标签加载失败</div>';
  }
}

function readSidebarCategoriesCollapsed() {
  try {
    return localStorage.getItem(ARTICLE_READER_CATEGORIES_COLLAPSE_STORAGE_KEY) === '1';
  } catch (error) {
    return false;
  }
}

function saveSidebarCategoriesCollapsed() {
  try {
    localStorage.setItem(ARTICLE_READER_CATEGORIES_COLLAPSE_STORAGE_KEY, sidebarCategoriesCollapsed ? '1' : '0');
  } catch (error) {
    console.error('saveSidebarCategoriesCollapsed failed:', error);
  }
}

function renderSidebarCategories() {
  const listEl = document.getElementById('article-reader-categories-list');
  const section = document.getElementById('article-reader-categories-section');
  const chevron = document.getElementById('article-reader-categories-chevron');
  if (!listEl || !section) return;

  section.classList.toggle('is-collapsed', !!sidebarCategoriesCollapsed);
  if (chevron) {
    const icon = chevron.querySelector('[data-lucide]');
    if (icon) icon.setAttribute('data-lucide', sidebarCategoriesCollapsed ? 'chevron-right' : 'chevron-down');
    chevron.setAttribute('aria-expanded', sidebarCategoriesCollapsed ? 'false' : 'true');
    chevron.setAttribute('aria-label', sidebarCategoriesCollapsed ? '展开主题分类列表' : '折叠主题分类列表');
    chevron.setAttribute('title', sidebarCategoriesCollapsed ? '展开主题分类列表' : '折叠主题分类列表');
  }

  const categories = Array.isArray(sidebarCategoriesState) ? sidebarCategoriesState : [];
  if (!categories.length) {
    listEl.innerHTML = '<div class="article-reader-categories-empty">暂无主题分类</div>';
    if (typeof window.refreshLucideIcons === 'function') window.refreshLucideIcons();
    return;
  }

  listEl.innerHTML = categories
    .map((cat) => {
      const categoryId = Number(cat.id);
      const activeClass =
        activeScope === 'category' && Number(activeCategoryId) === categoryId ? ' active' : '';
      const dotStyle = tagChipInlineStyle(cat.color) || 'background:#6c8ebf;';
      return `<button type="button" class="article-reader-category-btn${activeClass}" data-category-select-id="${categoryId}" data-category-name="${escapeHtml(String(cat.name || ''))}">
        <span class="article-reader-category-dot" style="${dotStyle}"></span>
        <span class="article-reader-category-name">${escapeHtml(String(cat.name || cat.code || ''))}</span>
      </button>`;
    })
    .join('');

  if (typeof window.refreshLucideIcons === 'function') window.refreshLucideIcons();

  listEl.querySelectorAll('[data-category-select-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const categoryId = Number(btn.getAttribute('data-category-select-id'));
      const categoryName = btn.getAttribute('data-category-name') || '';
      if (!Number.isFinite(categoryId)) return;
      await selectCategoryFilter(categoryId, categoryName);
    });
  });
}

async function loadSidebarCategories() {
  const headers = authHeaders();
  const listEl = document.getElementById('article-reader-categories-list');
  if (!listEl) return;
  if (!headers) {
    sidebarCategoriesState = [];
    listEl.innerHTML = '<div class="article-reader-categories-empty">登录后可用</div>';
    return;
  }
  try {
    const res = await fetch(`${API_BASE_URL}/classification/categories`, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '加载主题分类失败');
    sidebarCategoriesState = Array.isArray(data.categories) ? data.categories : [];
    if (activeScope === 'category' && activeCategoryId != null) {
      const exists = sidebarCategoriesState.some((cat) => Number(cat.id) === Number(activeCategoryId));
      if (!exists) {
        clearActiveScopeFilter();
        await loadArticles();
      }
    }
    renderSidebarCategories();
  } catch (error) {
    console.error('loadSidebarCategories failed:', error);
    listEl.innerHTML = '<div class="article-reader-categories-empty">主题分类加载失败</div>';
  }
}

function initSidebarCategoriesUi() {
  sidebarCategoriesCollapsed = readSidebarCategoriesCollapsed();
  const chevron = document.getElementById('article-reader-categories-chevron');
  if (chevron && chevron.dataset.bound !== '1') {
    chevron.dataset.bound = '1';
    chevron.addEventListener('click', () => {
      sidebarCategoriesCollapsed = !sidebarCategoriesCollapsed;
      saveSidebarCategoriesCollapsed();
      renderSidebarCategories();
    });
  }
}

function ensureTagContextMenu() {
  let menu = document.getElementById('article-reader-tag-context-menu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'article-reader-tag-context-menu';
  menu.className = 'article-reader-group-context-menu hidden';
  menu.innerHTML = `
    <button type="button" class="article-reader-group-context-item" data-action="rename">重命名</button>
    <button type="button" class="article-reader-group-context-item" data-action="color">改色</button>
    <button type="button" class="article-reader-group-context-item danger" data-action="delete">删除</button>
  `;
  document.body.appendChild(menu);

  menu.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.getAttribute('data-action');
    if (!action || !contextMenuTag) return;
    const selectedTag = { ...contextMenuTag };
    closeTagContextMenu();
    if (action === 'rename') {
      await editSidebarTag(selectedTag);
    } else if (action === 'color') {
      await editSidebarTagColor(selectedTag);
    } else if (action === 'delete') {
      await deleteSidebarTag(selectedTag);
    }
  });
  return menu;
}

function closeTagContextMenu() {
  const menu = document.getElementById('article-reader-tag-context-menu');
  if (!menu) return;
  menu.classList.add('hidden');
  contextMenuTag = null;
}

function openTagContextMenu(clientX, clientY, tag) {
  const menu = ensureTagContextMenu();
  closeGroupContextMenu();
  closeFeedContextMenu();
  contextMenuTag = {
    id: Number(tag.id),
    name: String(tag.name || ''),
    color: tag.color == null ? null : String(tag.color),
  };
  menu.classList.remove('hidden');
  const maxLeft = Math.max(8, window.innerWidth - menu.offsetWidth - 8);
  const maxTop = Math.max(8, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = `${Math.min(clientX, maxLeft)}px`;
  menu.style.top = `${Math.min(clientY, maxTop)}px`;
}

async function editSidebarTag(tag) {
  const headers = authHeaders();
  if (!headers) return;
  const tagId = Number(tag?.id);
  if (!Number.isFinite(tagId)) return;
  const newName = window.prompt('标签名称', String(tag.name || ''));
  if (newName === null) return;
  const cleanName = newName.trim();
  if (!cleanName) {
    showMsg('标签名称不能为空', true);
    return;
  }
  try {
    const res = await fetch(`${API_BASE_URL}/feed-subscriptions/tags/${tagId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: cleanName }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '标签重命名失败');
    if (activeScope === 'tag' && Number(activeTagId) === tagId) {
      activeFeedTitle = `标签：${cleanName}`;
      syncTagFilterChrome();
    }
    showMsg('标签已更新', false);
    await loadSidebarTags();
  } catch (error) {
    showMsg(error.message || '标签重命名失败', true);
  }
}

async function editSidebarTagColor(tag) {
  const headers = authHeaders();
  if (!headers) return;
  const tagId = Number(tag?.id);
  if (!Number.isFinite(tagId)) return;
  const newColor = window.prompt('标签颜色（#RGB 或 #RRGGBB，留空清除）', String(tag.color || ''));
  if (newColor === null) return;
  const trimmed = newColor.trim();
  const body = trimmed ? { color: trimmed } : { color: null };
  if (trimmed && normalizeTagColor(trimmed) === undefined) {
    showMsg('颜色格式无效，须为 #RGB 或 #RRGGBB', true);
    return;
  }
  try {
    const res = await fetch(`${API_BASE_URL}/feed-subscriptions/tags/${tagId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '标签颜色更新失败');
    showMsg('标签颜色已更新', false);
    await loadSidebarTags();
  } catch (error) {
    showMsg(error.message || '标签颜色更新失败', true);
  }
}

async function deleteSidebarTag(tag) {
  const headers = authHeaders();
  if (!headers) return;
  const tagId = Number(tag?.id);
  if (!Number.isFinite(tagId)) return;
  const ok = window.confirm(`确定删除标签「${tag.name || tagId}」吗？将移除所有文章上的该标签关联。`);
  if (!ok) return;
  try {
    const res = await fetch(`${API_BASE_URL}/feed-subscriptions/tags/${tagId}`, {
      method: 'DELETE',
      headers: { Authorization: headers.Authorization },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '标签删除失败');
    if (activeScope === 'tag' && Number(activeTagId) === tagId) {
      clearActiveTagFilter();
      resetArticleListPage();
      activeFeedId = ALL_FEED_ID;
      activeGroupId = null;
      activeFeedTitle = '全部文章';
      updateCurrentFeedTitle('全部文章');
      saveSidebarSelection();
      await loadArticles();
    }
    showMsg('标签已删除', false);
    await loadSidebarTags();
  } catch (error) {
    showMsg(error.message || '标签删除失败', true);
  }
}

function initSidebarTagsUi() {
  sidebarTagsCollapsed = readSidebarTagsCollapsed();
  const chevron = document.getElementById('article-reader-tags-chevron');
  if (chevron && chevron.dataset.bound !== '1') {
    chevron.dataset.bound = '1';
    chevron.addEventListener('click', () => {
      sidebarTagsCollapsed = !sidebarTagsCollapsed;
      saveSidebarTagsCollapsed();
      renderSidebarTags();
    });
  }
  const clearBtn = document.getElementById('article-reader-clear-tag-filter');
  if (clearBtn && clearBtn.dataset.bound !== '1') {
    clearBtn.dataset.bound = '1';
    clearBtn.addEventListener('click', async () => {
      clearActiveScopeFilter();
      activeFeedId = activeFeedId || ALL_FEED_ID;
      activeGroupId = null;
      activeFeedTitle = '全部文章';
      updateCurrentFeedTitle('全部文章');
      saveSidebarSelection();
      resetArticleListPage();
      await loadArticles();
    });
  }
  ensureTagContextMenu();
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

/** 尝试加载 favicon URL，确认资源可访问 */
function probeFaviconUrl(faviconUrl) {
  const url = String(faviconUrl || '').trim();
  if (!url) return Promise.resolve(false);
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.referrerPolicy = 'no-referrer';
    img.src = `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`;
    setTimeout(() => finish(false), 5000);
  });
}

function buildFeedFaviconMarkup(feedData, opts) {
  const customText = String(feedData?.favicon_custom_text || feedData?.faviconCustomText || '').trim().slice(0, 2);
  const customBg = String(feedData?.favicon_custom_bg || feedData?.faviconCustomBg || '').trim() || '#2874a6';
  const directUrl = String(feedData?.favicon_url || feedData?.faviconUrl || '').trim();
  const fallbackUrl = faviconUrlFromSite(feedData?.url || '');
  const finalUrl = directUrl || fallbackUrl;
  const feedName = String(feedData?.title || feedData?.tooltip || (opts && opts.tooltip) || '').trim();
  const dataAttr = feedName ? ` data-feed-name="${escapeHtml(feedName)}"` : '';
  if (finalUrl) {
    return `<span class="article-reader-favicon-cell"${dataAttr}><img src="${escapeHtml(finalUrl)}" alt="favicon" loading="lazy" referrerpolicy="no-referrer"></span>`;
  }
  const text = (customText || String(feedData?.title || 'F').trim().slice(0, 1) || 'F').toUpperCase();
  return `<span class="article-reader-favicon-cell" style="background:${escapeHtml(customBg)};color:#fff;"${dataAttr}>${escapeHtml(text)}</span>`;
}

function resolveFeedById(feedId) {
  const targetId = Number(feedId);
  if (!Number.isFinite(targetId)) return null;
  for (const group of menuState) {
    const feeds = Array.isArray(group?.feeds) ? group.feeds : [];
    const hit = feeds.find((item) => Number(item?.id) === targetId);
    if (hit) return hit;
  }
  return null;
}

function markArticleReadLocalByIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index >= currentArticles.length) return;
  const article = currentArticles[index];
  if (!article || article.is_read) return;
  article.is_read = true;
  const list = document.getElementById('article-reader-list');
  if (!list) return;
  const item = list.querySelector(`.article-reader-item[data-article-index="${index}"]`);
  if (item) item.classList.add('is-read');
}

async function markArticleAsRead(articleId) {
  if (!Number.isFinite(articleId)) return;
  const token = localStorage.getItem('anonymousUserToken');
  if (!token) return;
  try {
    const res = await fetch(`${API_BASE_URL}/feed-subscriptions/articles/${articleId}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '标记已读失败');
    }
  } catch (error) {
    console.error('markArticleAsRead failed:', error);
  }
}

async function markArticleAsUnread(articleId) {
  if (!Number.isFinite(articleId)) return false;
  const token = localStorage.getItem('anonymousUserToken');
  if (!token) return false;
  try {
    const res = await fetch(`${API_BASE_URL}/feed-subscriptions/articles/${articleId}/read`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '标记未读失败');
    return true;
  } catch (error) {
    showMsg(error.message || '标记未读失败', true);
    return false;
  }
}

function markArticleUnreadLocalByIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index >= currentArticles.length) return;
  const article = currentArticles[index];
  if (!article || !article.is_read) return;
  article.is_read = false;
  const list = document.getElementById('article-reader-list');
  if (!list) return;
  const item = list.querySelector(`.article-reader-item[data-article-index="${index}"]`);
  if (item) item.classList.remove('is-read');
}

function updateArticleAiCategoryInList(articleIndex, aiCategory) {
  const article = currentArticles[articleIndex];
  if (!article) return;
  article.ai_category = aiCategory || null;

  const list = document.getElementById('article-reader-list');
  if (!list) return;
  const item = list.querySelector(`.article-reader-item[data-article-index="${articleIndex}"]`);
  if (!item) return;

  let tagsWrap = item.querySelector('.article-reader-item-tags');
  const tagInner = buildArticleListTagsInnerHtml(article.tags);
  const aiChip = buildArticleListAiCategoryChip(article.ai_category);
  if (!aiChip && !tagInner) {
    if (tagsWrap) tagsWrap.remove();
    return;
  }
  const html = `${aiChip}${tagInner}`;
  if (tagsWrap) {
    tagsWrap.innerHTML = html;
  } else {
    const titleStack = item.querySelector('.article-reader-item-title-stack');
    if (!titleStack) return;
    tagsWrap = document.createElement('div');
    tagsWrap.className = 'article-reader-item-tags';
    tagsWrap.innerHTML = html;
    const summaryEl = titleStack.querySelector('.article-reader-item-inline-summary');
    if (summaryEl) titleStack.insertBefore(tagsWrap, summaryEl);
    else titleStack.appendChild(tagsWrap);
  }

  tagsWrap.querySelectorAll('[data-category-filter-id]').forEach((chip) => {
    chip.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const categoryId = Number(chip.getAttribute('data-category-filter-id'));
      const categoryName = chip.getAttribute('data-category-name') || '';
      if (!Number.isFinite(categoryId)) return;
      await selectCategoryFilter(categoryId, categoryName);
    });
  });
}

async function annotateArticleCategory(articleId, categoryId) {
  const headers = authHeaders();
  if (!headers) throw new Error('请先登录');
  const res = await fetch(`${API_BASE_URL}/classification/annotate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ article_id: articleId, category_id: categoryId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '标注失败');
  return data;
}

function closeCategoryAnnotateMenu() {
  const menu = document.getElementById('article-reader-category-annotate-menu');
  if (!menu) return;
  menu.classList.add('hidden');
  categoryAnnotateMenuState = { index: null };
}

function ensureCategoryAnnotateMenu() {
  let menu = document.getElementById('article-reader-category-annotate-menu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'article-reader-category-annotate-menu';
  menu.className = 'article-reader-group-context-menu article-reader-category-annotate-menu hidden';
  menu.style.position = 'fixed';
  menu.style.minWidth = '148px';
  menu.innerHTML = '<div class="article-reader-category-annotate-title">选择正确分类</div><div class="article-reader-category-annotate-list"></div>';
  document.body.appendChild(menu);

  menu.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const btn = target.closest('[data-category-annotate-id]');
    if (!btn) return;
    const categoryId = Number(btn.getAttribute('data-category-annotate-id'));
    const idx = Number(categoryAnnotateMenuState.index);
    if (!Number.isFinite(categoryId) || !Number.isFinite(idx) || !currentArticles[idx]) return;
    const article = currentArticles[idx];
    const articleId = Number(article.id);
    if (!Number.isFinite(articleId)) {
      showMsg('文章 ID 无效', true);
      return;
    }

    closeCategoryAnnotateMenu();
    try {
      const data = await annotateArticleCategory(articleId, categoryId);
      updateArticleAiCategoryInList(idx, data.ai_category || null);
      const name = data.ai_category?.name || '新分类';
      showMsg(`已修正为「${name}」`, false);
    } catch (error) {
      showMsg(error.message || '标注失败', true);
    }
  });
  return menu;
}

async function openCategoryAnnotateMenu(anchorEl, articleIndex) {
  if (!(anchorEl instanceof HTMLElement)) return;
  const idx = Number(articleIndex);
  if (!Number.isFinite(idx) || !currentArticles[idx]) return;
  if (!authHeaders()) {
    showMsg('请先登录后再修正分类', true);
    return;
  }

  if (!sidebarCategoriesState.length) {
    await loadSidebarCategories();
  }
  const categories = sidebarCategoriesState || [];
  if (!categories.length) {
    showMsg('暂无可用分类', true);
    return;
  }

  const menu = ensureCategoryAnnotateMenu();
  const listEl = menu.querySelector('.article-reader-category-annotate-list');
  if (!listEl) return;

  const currentCategoryId = Number(currentArticles[idx]?.ai_category?.id);
  listEl.innerHTML = categories
    .map((cat) => {
      const categoryId = Number(cat.id);
      if (!Number.isFinite(categoryId)) return '';
      const dotStyle = tagChipInlineStyle(cat.color) || 'background:#6c8ebf;';
      const activeMark =
        Number.isFinite(currentCategoryId) && currentCategoryId === categoryId ? ' ✓' : '';
      return `<button type="button" class="article-reader-group-context-item article-reader-category-annotate-item" data-category-annotate-id="${categoryId}">
        <span class="article-reader-category-annotate-dot" style="${dotStyle}"></span>
        <span>${escapeHtml(String(cat.name || cat.code || ''))}${activeMark}</span>
      </button>`;
    })
    .join('');

  categoryAnnotateMenuState = { index: idx };
  menu.classList.remove('hidden');

  const rect = anchorEl.getBoundingClientRect();
  const menuWidth = menu.offsetWidth || 160;
  const menuHeight = menu.offsetHeight || 220;
  const left = Math.min(Math.max(8, rect.right - menuWidth), window.innerWidth - menuWidth - 8);
  const top = Math.min(Math.max(8, rect.bottom + 6), window.innerHeight - menuHeight - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function ensureArticleActionMenu() {
  let menu = document.getElementById('article-reader-article-action-menu');
  if (menu && menu.querySelector('[data-action="translate-article"]')) return menu;
  if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
  menu = document.createElement('div');
  menu.id = 'article-reader-article-action-menu';
  menu.className = 'article-reader-group-context-menu hidden';
  menu.style.position = 'fixed';
  menu.style.minWidth = '140px';
  menu.innerHTML = `
    <button type="button" class="article-reader-group-context-item" data-action="toggle-like">标记喜欢</button>
    <button type="button" class="article-reader-group-context-item" data-action="toggle-read">标记为已读</button>
    <button type="button" class="article-reader-group-context-item" data-action="open-link">打开原文</button>
    <button type="button" class="article-reader-group-context-item hidden" data-action="translate-article">执行翻译</button>
    <button type="button" class="article-reader-group-context-item article-reader-annotate-category-entry hidden" data-action="annotate-category">修正 AI 分类</button>
    <button type="button" class="article-reader-group-context-item" data-action="ai-summary">AI 总结</button>
    <button type="button" class="article-reader-group-context-item" data-action="voice-read">语音朗读</button>
  `;
  document.body.appendChild(menu);

  menu.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.getAttribute('data-action');
    const idx = Number(articleActionMenuState.index);
    if (!action || !Number.isFinite(idx) || !currentArticles[idx]) return;
    const article = currentArticles[idx];
    closeArticleActionMenu();

    if (action === 'toggle-like') {
      const articleId = Number(article.id);
      if (!Number.isFinite(articleId)) return;
      const nextLiked = !article.is_liked;
      const ok = await toggleArticleLike(articleId, nextLiked);
      if (!ok) return;
      article.is_liked = nextLiked;
      if (activeScope === 'liked' && !nextLiked) {
        await loadArticles();
        await refreshQuickScopeCounts();
        return;
      }
      // 更新对应的文章项上的喜欢按钮状态（如果存在）
      const list = document.getElementById('article-reader-list');
      if (list) {
        const item = list.querySelector(`.article-reader-item[data-article-index="${idx}"]`);
        if (item) {
          const likeBtn = item.querySelector(`[data-article-like-toggle="${idx}"]`);
          if (likeBtn) {
            likeBtn.classList.toggle('active', nextLiked);
            likeBtn.textContent = nextLiked ? '★' : '☆';
            likeBtn.setAttribute('aria-label', nextLiked ? '取消喜欢' : '标记喜欢');
          }
        }
      }
      await refreshQuickScopeCounts();
      showMsg(nextLiked ? '已标记喜欢' : '已取消喜欢', false);
      return;
    }
    if (action === 'toggle-read') {
      const articleId = Number(article.id);
      if (article.is_read) {
        markArticleUnreadLocalByIndex(idx);
        if (!Number.isFinite(articleId)) {
          showMsg('标记未读失败：文章ID无效', true);
          markArticleReadLocalByIndex(idx);
          return;
        }
        const ok = await markArticleAsUnread(articleId);
        if (!ok) {
          markArticleReadLocalByIndex(idx);
          return;
        }
        showMsg('已标记为未读', false);
      } else {
        markArticleReadLocalByIndex(idx);
        if (Number.isFinite(articleId)) await markArticleAsRead(articleId);
        showMsg('已标记为已读', false);
      }
      return;
    }
    if (action === 'open-link') {
      const articleUrl = String(article.url || '').trim();
      if (!articleUrl) {
        showMsg('当前文章无原文链接', true);
        return;
      }
      window.open(articleUrl, '_blank', 'noopener');
      return;
    }
    if (action === 'translate-article') {
      await triggerArticleTranslation(article, idx);
      return;
    }
    if (action === 'annotate-category') {
      const anchor = event.target instanceof HTMLElement ? event.target : menu;
      closeArticleActionMenu();
      await openCategoryAnnotateMenu(anchor, idx);
      return;
    }
    if (action === 'ai-summary') {
      showMsg('AI 总结功能暂未实现', false);
      return;
    }
    if (action === 'voice-read') {
      showMsg('语音朗读功能暂未实现', false);
    }
  });
  return menu;
}

function closeArticleActionMenu() {
  const menu = document.getElementById('article-reader-article-action-menu');
  if (!menu) return;
  menu.classList.add('hidden');
  articleActionMenuState = { index: null };
}

function openArticleActionMenu(anchorEl, articleIndex) {
  if (!(anchorEl instanceof HTMLElement)) return;
  const idx = Number(articleIndex);
  if (!Number.isFinite(idx) || !currentArticles[idx]) return;
  const menu = ensureArticleActionMenu();
  const article = currentArticles[idx];
  const toggleReadBtn = menu.querySelector('[data-action="toggle-read"]');
  const toggleLikeBtn = menu.querySelector('[data-action="toggle-like"]');
  const translateBtn = menu.querySelector('[data-action="translate-article"]');
  const annotateBtn = menu.querySelector('[data-action="annotate-category"]');
  const feedData = resolveFeedById(getArticleFeedId(article));
  if (toggleReadBtn instanceof HTMLElement) {
    toggleReadBtn.textContent = article.is_read ? '标记为未读' : '标记为已读';
  }
  if (toggleLikeBtn instanceof HTMLElement) {
    toggleLikeBtn.textContent = article.is_liked ? '取消喜欢' : '标记喜欢';
  }
  if (translateBtn instanceof HTMLElement) {
    translateBtn.classList.toggle('hidden', !(feedData && feedData.needsTranslation === true));
    translateBtn.disabled = false;
    translateBtn.textContent = '执行翻译';
  }
  if (annotateBtn instanceof HTMLElement) {
    annotateBtn.classList.toggle('hidden', !authHeaders());
  }

  articleActionMenuState = { index: idx };
  menu.classList.remove('hidden');

  const rect = anchorEl.getBoundingClientRect();
  const menuWidth = menu.offsetWidth || 150;
  const menuHeight = menu.offsetHeight || 180;
  const left = Math.min(Math.max(8, rect.right - menuWidth), window.innerWidth - menuWidth - 8);
  const top = Math.min(Math.max(8, rect.bottom + 6), window.innerHeight - menuHeight - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

async function triggerArticleTranslation(article, idx) {
  const headers = authHeaders();
  if (!headers) return;
  const articleId = Number(article?.id);
  if (!Number.isFinite(articleId)) {
    showMsg('文章 ID 无效', true);
    return;
  }

  showMsg('正在翻译当前文章…', false);
  try {
    const res = await fetch(`${API_BASE_URL}/feed-subscriptions/articles/${articleId}/translate`, {
      method: 'POST',
      headers: { Authorization: headers.Authorization },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '翻译失败');

    article.title_zh = data.title_zh ?? article.title_zh ?? null;
    article.description_zh = data.description_zh ?? article.description_zh ?? null;

    renderArticles(currentArticles, {
      preserveSelection: true,
      prevActiveArticleId: article.id,
    });
    if (activeArticleIndex === idx || currentArticles[activeArticleIndex]?.id === article.id) {
      const activeArticle = currentArticles.find((a) => String(a?.id) === String(article.id)) || article;
      updateDetailPane(activeArticle);
    }
    showMsg('翻译完成', false);
  } catch (error) {
    showMsg(error.message || '翻译失败', true);
  }
}

async function toggleArticleLike(articleId, shouldLike) {
  if (!Number.isFinite(articleId)) return false;
  const token = localStorage.getItem('anonymousUserToken');
  if (!token) return false;
  try {
    const res = await fetch(`${API_BASE_URL}/feed-subscriptions/articles/${articleId}/like`, {
      method: shouldLike ? 'POST' : 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '喜欢状态更新失败');
    return true;
  } catch (error) {
    showMsg(error.message || '喜欢状态更新失败', true);
    return false;
  }
}

function authHeaders() {
  const token = localStorage.getItem('anonymousUserToken');
  if (!token) return null;
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

let userTagsVocabularyCache = [];

function tagChipInlineStyle(color) {
  const raw = String(color || '').trim();
  if (/^#[0-9a-fA-F]{3}$/.test(raw) || /^#[0-9a-fA-F]{6}$/.test(raw)) {
    return `background:${raw};border-color:${raw};color:#fff;`;
  }
  return '';
}

function buildArticleListAiCategoryChip(aiCategory) {
  if (!aiCategory || aiCategory.id == null) return '';
  const categoryId = Number(aiCategory.id);
  if (!Number.isFinite(categoryId)) return '';
  const name = String(aiCategory.name || aiCategory.code || '');
  const dotStyle = tagChipInlineStyle(aiCategory.color) || 'background:#6c8ebf;';
  const confRaw = aiCategory.confidence;
  const confText =
    confRaw != null && !Number.isNaN(Number(confRaw)) ? `${Math.round(Number(confRaw) * 100)}%` : '';
  const title = confText ? `${name} · ${confText}` : name;
  const confHtml = confText
    ? `<span class="ai-category-chip-conf">${escapeHtml(confText)}</span>`
    : '';
  return `<button type="button" class="ai-category-chip" data-category-filter-id="${categoryId}" data-category-name="${escapeHtml(name)}" title="${escapeHtml(title)}">
    <span class="ai-category-chip-dot" style="${dotStyle}"></span>
    <span class="ai-category-chip-icon" aria-hidden="true">🤖</span>
    <span class="ai-category-chip-name">${escapeHtml(name)}</span>${confHtml}
  </button>`;
}

/** 列表卡片标题下 Tag chips 内部 HTML（最多 3 个，超出 +N） */
function buildArticleListTagsInnerHtml(tags) {
  const list = Array.isArray(tags) ? tags : [];
  if (!list.length) return '';
  const maxShow = 3;
  const visible = list.slice(0, maxShow);
  const extra = list.length - visible.length;
  const chips = visible
    .map((tag) => {
      const tagId = Number(tag.id);
      if (!Number.isFinite(tagId)) return '';
      const name = String(tag.name || '');
      const style = tagChipInlineStyle(tag.color);
      return `<button type="button" class="article-reader-list-tag-chip" data-tag-filter-id="${tagId}" data-tag-name="${escapeHtml(name)}" style="${style}" title="${escapeHtml(name)}">${escapeHtml(name)}</button>`;
    })
    .filter(Boolean)
    .join('');
  const more =
    extra > 0 ? `<span class="article-reader-list-tag-overflow" title="还有 ${extra} 个标签">+${extra}</span>` : '';
  return `${chips}${more}`;
}

/** 列表卡片标题下 AI 类别 + 用户 Tag chips */
function buildArticleListTagsHtml(tags, aiCategory) {
  const aiChip = buildArticleListAiCategoryChip(aiCategory);
  const tagInner = buildArticleListTagsInnerHtml(tags);
  if (!aiChip && !tagInner) return '';
  return `<div class="article-reader-item-tags">${aiChip}${tagInner}</div>`;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

/** 用于原生 title 提示，避免属性过长 */
function clipTextForTooltip(value, maxLen) {
  const s = String(value == null ? '' : value);
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…`;
}

let summaryTipEl = null;

function ensureSummaryTipElement() {
  if (summaryTipEl) return summaryTipEl;
  summaryTipEl = document.createElement('div');
  summaryTipEl.id = 'article-reader-summary-tip';
  summaryTipEl.className = 'article-reader-summary-tip';
  summaryTipEl.setAttribute('role', 'tooltip');
  summaryTipEl.style.display = 'none';
  document.body.appendChild(summaryTipEl);
  return summaryTipEl;
}

function showArticleSummaryTip(anchor, fullText) {
  const tip = ensureSummaryTipElement();
  tip.textContent = fullText;
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
  tip.style.position = 'fixed';
  tip.style.zIndex = '100050';
  tip.style.visibility = 'visible';
}

function hideArticleSummaryTip() {
  if (summaryTipEl) {
    summaryTipEl.style.display = 'none';
    summaryTipEl.textContent = '';
  }
}

function initFeedFaviconTooltip() {
  const list = document.getElementById('article-reader-list');
  if (!list || list.dataset.feedFaviconTooltip === '1') return;
  list.dataset.feedFaviconTooltip = '1';

  const tip = document.createElement('div');
  tip.className = 'article-reader-feed-name-tip';
  tip.style.display = 'none';
  document.body.appendChild(tip);

  let hideTimer = null;

  function show(el, text) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    tip.textContent = text;
    tip.style.display = 'block';
    tip.style.visibility = 'hidden';
    tip.style.position = 'fixed';
    tip.style.zIndex = '100050';
    const r = el.getBoundingClientRect();
    const pad = 6;
    tip.style.maxWidth = Math.min(280, window.innerWidth - 16) + 'px';
    tip.style.left = Math.max(pad, Math.min(r.left, window.innerWidth - tip.offsetWidth - pad)) + 'px';
    tip.style.top = (r.bottom + 4) + 'px';
    if (tip.offsetTop + tip.offsetHeight > window.innerHeight - pad) {
      tip.style.top = (r.top - tip.offsetHeight - 4) + 'px';
    }
    tip.style.visibility = 'visible';
  }

  function hide() {
    hideTimer = setTimeout(function () { tip.style.display = 'none'; }, 80);
  }

  list.addEventListener('mouseover', function (e) {
    const el = (e.target instanceof Element ? e.target : e.target.parentElement)?.closest?.('.article-reader-favicon-cell[data-feed-name]');
    if (!el || !list.contains(el)) return;
    const name = el.getAttribute('data-feed-name');
    if (name) show(el, name);
  }, true);

  list.addEventListener('mouseout', function (e) {
    const el = (e.target instanceof Element ? e.target : e.target.parentElement)?.closest?.('.article-reader-favicon-cell[data-feed-name]');
    if (!el || !list.contains(el)) return;
    const to = e.relatedTarget;
    if (to instanceof Node && el.contains(to)) return;
    hide();
  }, true);

  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}

function initArticleSummaryTipDelegation() {
  const list = document.getElementById('article-reader-list');
  if (!list || list.dataset.summaryTipDelegation === '1') return;
  list.dataset.summaryTipDelegation = '1';

  list.addEventListener(
    'mouseover',
    (e) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      const el = (t instanceof Element ? t : t.parentElement)?.closest('.article-reader-item-inline-summary');
      if (!el || !list.contains(el)) return;
      const from = e.relatedTarget;
      if (from instanceof Node && el.contains(from)) return;
      const full = el.getAttribute('data-full-summary');
      if (!full) return;
      showArticleSummaryTip(el, full);
    },
    true
  );

  list.addEventListener(
    'mouseout',
    (e) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      const el = (t instanceof Element ? t : t.parentElement)?.closest('.article-reader-item-inline-summary');
      if (!el || !list.contains(el)) return;
      const to = e.relatedTarget;
      if (to instanceof Node && el.contains(to)) return;
      hideArticleSummaryTip();
    },
    true
  );

  window.addEventListener(
    'scroll',
    () => {
      hideArticleSummaryTip();
    },
    true
  );
  window.addEventListener('resize', hideArticleSummaryTip);
}

function getArticleFeedId(article) {
  const raw = article?.feed_id ?? article?.feedId ?? article?.subscription_feed_id;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

function getArticleDisplayTitle(article) {
  if (isFeedShowingOriginal(getArticleFeedId(article))) {
    return String(article?.title || '无标题');
  }
  const zh = String(article?.title_zh || '').trim();
  if (zh) return zh;
  return String(article?.title || '无标题');
}

function getArticleDisplayDescription(article) {
  if (isFeedShowingOriginal(getArticleFeedId(article))) {
    return article?.description || article?.content || '';
  }
  const zh = String(article?.description_zh || '').trim();
  if (zh) return zh;
  return article?.description || article?.content || '';
}

function buildFeedLangTag(feed) {
  if (!feed || feed.needsTranslation !== true) return '';
  return '<span class="article-reader-feed-lang-tag" title="英文源，已开启翻译">en</span>';
}

function stripHtmlTags(value) {
  const div = document.createElement('div');
  div.innerHTML = value == null ? '' : String(value);
  return (div.textContent || div.innerText || '').trim();
}

function sanitizeArticleHtml(value) {
  const template = document.createElement('template');
  template.innerHTML = value == null ? '' : String(value);

  template.content.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach((el) => {
    el.remove();
  });

  template.content.querySelectorAll('*').forEach((el) => {
    Array.from(el.attributes).forEach((attr) => {
      const name = attr.name.toLowerCase();
      const val = String(attr.value || '').trim().toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        return;
      }
      if ((name === 'href' || name === 'src') && val.startsWith('javascript:')) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return template.innerHTML;
}

function formatFriendlyAddedTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = Date.now();
  const diffMs = Math.max(0, now - date.getTime());
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const yearMs = 365 * dayMs;

  if (diffMs < hourMs) {
    const minutes = Math.max(1, Math.floor(diffMs / minuteMs));
    return `${minutes}分钟前`;
  }
  if (diffMs < dayMs) {
    const hours = Math.max(1, Math.floor(diffMs / hourMs));
    return `${hours}小时前`;
  }
  if (diffMs < yearMs) {
    const days = Math.max(1, Math.floor(diffMs / dayMs));
    return `${days}天前`;
  }
  return date.toLocaleDateString();
}

function formatShortAddedTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = Date.now();
  const diffMs = Math.max(0, now - date.getTime());
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const monthMs = 30 * dayMs;
  const yearMs = 365 * dayMs;

  if (diffMs < minuteMs) return '刚刚';
  if (diffMs < hourMs) return Math.floor(diffMs / minuteMs) + 's';
  if (diffMs < dayMs) return Math.floor(diffMs / hourMs) + 'h';
  if (diffMs < monthMs) return Math.floor(diffMs / dayMs) + 'd';
  if (diffMs < yearMs) return Math.floor(diffMs / monthMs) + 'm';
  return date.toLocaleDateString();
}

function showMsg(text, isError) {
  const el = document.getElementById('article-reader-msg');
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
  el.classList.toggle('ok', !isError && !!text);
}

function updateCurrentFeedTitle(text) {
  const current = document.getElementById('article-reader-current-feed');
  if (!current) return;
  const label = text || '全部文章';
  const textEl = current.querySelector('.current-feed-text');
  if (textEl) textEl.textContent = label;
  else current.textContent = label;
  current.setAttribute('title', label);
}

function syncTitleFilterMenu() {
  const menu = document.getElementById('article-reader-title-filter-menu');
  if (!menu) return;
  const key = activeScope === 'today' && activeUnreadOnly ? 'today-unread' : activeScope === 'today' ? 'today' : 'all';
  menu.querySelectorAll('[data-title-filter]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-title-filter') === key);
  });
}

function formatDateTimeForDisplay(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function formatUnreadCountText(count) {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count > 1000) return '1000+';
  return String(count);
}

// 左侧快捷筛选（全部 / 今天 / 喜欢）计数数字统一样式：略小、略淡
const ARTICLE_READER_MENU_COUNT_STYLE =
  'margin-left:6px;font-size:0.78em;color:#a8b4c2;font-weight:500;letter-spacing:0.01em;';

function updateAllButtonLabel(totalCount) {
  const allBtn = document.getElementById('reader-all-btn');
  if (!allBtn) return;
  const countText = formatUnreadCountText(totalCount);
  const ariaLabel = `全部文章 ${countText}`;
  allBtn.innerHTML = `<span class="article-reader-filter-label"><span class="nav-icon"><i data-lucide="list-checks"></i></span><span>全部文章<span class="article-reader-menu-count-num" style="${ARTICLE_READER_MENU_COUNT_STYLE}">${escapeHtml(countText)}</span></span></span>`;
  allBtn.setAttribute('aria-label', ariaLabel);
  if (typeof window.refreshLucideIcons === 'function') window.refreshLucideIcons();
}

function updateScopeButtonCountLabel(type, count) {
  const btn = document.getElementById(type === 'today' ? 'reader-today-btn' : 'reader-liked-btn');
  if (!btn) return;
  const prefix = type === 'today' ? '今天' : '喜欢';
  const icon = type === 'today' ? 'clock' : 'star';
  const countText = formatUnreadCountText(count);
  const ariaLabel = `${prefix} ${countText}`;
  btn.innerHTML = `<span class="article-reader-filter-label"><span class="nav-icon"><i data-lucide="${icon}"></i></span><span>${escapeHtml(prefix)}<span class="article-reader-menu-count-num" style="${ARTICLE_READER_MENU_COUNT_STYLE}">${escapeHtml(countText)}</span></span></span>`;
  btn.setAttribute('aria-label', ariaLabel);
  if (typeof window.refreshLucideIcons === 'function') window.refreshLucideIcons();
}

async function refreshQuickScopeCounts() {
  const headers = authHeaders();
  if (!headers) return;
  try {
    const statsRes = await fetch(`${API_BASE_URL}/feed-subscriptions/articles/stats`, { headers });
    const stats = await statsRes.json().catch(() => ({}));
    if (!statsRes.ok) return;
    const todayCount = Number(stats.today_count || 0);
    const likedCount = Number(stats.liked_count || 0);
    updateScopeButtonCountLabel('today', Number.isFinite(todayCount) ? todayCount : 0);
    updateScopeButtonCountLabel('liked', Number.isFinite(likedCount) ? likedCount : 0);
  } catch (error) {
    console.error('refreshQuickScopeCounts failed:', error);
  }
}

function syncQuickScopeButtons() {
  const allBtn = document.getElementById('reader-all-btn');
  const todayBtn = document.getElementById('reader-today-btn');
  const likedBtn = document.getElementById('reader-liked-btn');
  const titleFilterBtn = document.getElementById('article-reader-current-feed');
  const titleFilterMenu = document.getElementById('article-reader-title-filter-menu');
  if (titleFilterBtn && titleFilterMenu && titleFilterBtn.dataset.filterBound !== '1') {
    titleFilterBtn.dataset.filterBound = '1';
    titleFilterBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      titleFilterMenu.classList.toggle('hidden');
      titleFilterBtn.setAttribute('aria-expanded', titleFilterMenu.classList.contains('hidden') ? 'false' : 'true');
      syncTitleFilterMenu();
    });
    titleFilterMenu.querySelectorAll('[data-title-filter]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const filter = btn.getAttribute('data-title-filter') || 'all';
        resetArticleListPage();
        activeScope = filter === 'today' || filter === 'today-unread' ? 'today' : 'all';
        activeTagId = null;
        activeCategoryId = null;
        activeUnreadOnly = filter === 'today-unread';
        activeFeedId = ALL_FEED_ID;
        activeGroupId = null;
        activeFeedTitle = activeUnreadOnly ? '今日未读' : activeScope === 'today' ? '今天文章' : '全部文章';
        updateCurrentFeedTitle(activeFeedTitle);
        titleFilterMenu.classList.add('hidden');
        titleFilterBtn.setAttribute('aria-expanded', 'false');
        syncTitleFilterMenu();
        syncTagFilterChrome();
        saveSidebarSelection();
        renderMenu();
        await loadArticles();
      });
    });
  }
  if (allBtn) {
    allBtn.classList.toggle('active', activeScope === 'all');
  }
  if (todayBtn) {
    todayBtn.classList.toggle('active', activeScope === 'today');
  }
  if (likedBtn) {
    likedBtn.classList.toggle('active', activeScope === 'liked');
  }
}

async function refreshUnreadCount() {
  const headers = authHeaders();
  if (!headers) return;
  try {
    const res = await fetch(`${API_BASE_URL}/feed-subscriptions/articles/stats`, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return;
    const totalCount = Number(data.total_count || 0);
    updateAllButtonLabel(Number.isFinite(totalCount) ? totalCount : 0);
    await refreshQuickScopeCounts();
  } catch (error) {
    console.error('refreshUnreadCount failed:', error);
  }
}

function ensureToolbarRefreshBtn() {
  const refreshBtn = document.getElementById('reader-refresh-icon-btn');
  if (!(refreshBtn instanceof HTMLButtonElement) || refreshBtn.dataset.bound === '1') return;
  refreshBtn.dataset.bound = '1';
  refreshBtn.addEventListener('click', async () => {
    await performReaderDataRefresh({ silent: false, playSound: false });
  });
}

function createDialogMask() {
  const mask = document.createElement('div');
  mask.style.position = 'fixed';
  mask.style.inset = '0';
  mask.style.background = 'rgba(15, 23, 42, 0.42)';
  mask.style.display = 'flex';
  mask.style.alignItems = 'center';
  mask.style.justifyContent = 'center';
  mask.style.zIndex = '10000';
  return mask;
}

function decodeHtmlEntities(value) {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = String(value || '');
  return String(textarea.value || '');
}

function nodeLocalName(node) {
  if (!node || node.nodeType !== 1) return '';
  return String(node.localName || node.nodeName || '').toLowerCase();
}

function extractTitleFromXmlText(xmlText) {
  const text = String(xmlText || '').trim();
  if (!text) return '';
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(text, 'text/xml');
  if (xmlDoc.querySelector('parsererror')) return '';

  const roots = Array.from(xmlDoc.getElementsByTagName('*')).filter((el) => {
    const name = nodeLocalName(el);
    return name === 'channel' || name === 'feed';
  });

  for (const root of roots) {
    const titleChild = Array.from(root.children || []).find((child) => nodeLocalName(child) === 'title');
    const title = String(titleChild?.textContent || '').trim();
    if (title) return title;
  }

  const allTitles = Array.from(xmlDoc.getElementsByTagName('*')).filter((el) => nodeLocalName(el) === 'title');
  for (const titleNode of allTitles) {
    const title = String(titleNode.textContent || '').trim();
    if (title) return title;
  }
  return '';
}

function extractTitleByRegex(xmlLikeText) {
  const text = String(xmlLikeText || '');
  if (!text) return '';
  const patterns = [
    /<channel\b[\s\S]*?<title\b[^>]*>([\s\S]*?)<\/title>/i,
    /<feed\b[\s\S]*?<title\b[^>]*>([\s\S]*?)<\/title>/i,
    /<title\b[^>]*>([\s\S]*?)<\/title>/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match || !match[1]) continue;
    const title = String(match[1]).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').trim();
    if (title) return title;
  }
  return '';
}

function getFeedSiteRootUrl(feedUrl) {
  try {
    const parsed = new URL(feedUrl);
    return `${parsed.protocol}//${parsed.hostname}/`;
  } catch {
    return '';
  }
}

function findFaviconFromHtml(html, baseUrl) {
  const rawHtml = String(html || '').trim();
  if (!rawHtml) return '';
  try {
    const parser = new DOMParser();
    const htmlDoc = parser.parseFromString(rawHtml, 'text/html');
    const head = htmlDoc.querySelector('head') || htmlDoc;
    const links = Array.from(head.querySelectorAll('link[href]'));
    const iconLinks = links.filter((link) => {
      const rel = String(link.getAttribute('rel') || '').toLowerCase();
      const href = String(link.getAttribute('href') || '').trim();
      return href && rel.includes('icon') && (/\.ico(?:[?#].*)?$/i.test(href) || href.toLowerCase().includes('.ico'));
    });
    const first = iconLinks[0] || links.find((link) => /\.ico(?:[?#].*)?$/i.test(String(link.getAttribute('href') || '').trim()));
    const href = first ? String(first.getAttribute('href') || '').trim() : '';
    if (!href) return '';
    return new URL(href, baseUrl || window.location.href).href;
  } catch {
    return '';
  }
}

function extractFeedTitleFromRenderedHtml(html) {
  const rawHtml = String(html || '').trim();
  if (!rawHtml) return '';

  const parser = new DOMParser();
  const htmlDoc = parser.parseFromString(rawHtml, 'text/html');
  const candidates = [];

  // 结构1：Chromium XML Viewer 包裹的原始 XML。
  const xmlViewerNode = htmlDoc.querySelector('#webkit-xml-viewer-source-xml');
  if (xmlViewerNode) {
    candidates.push(String(xmlViewerNode.textContent || ''));
    candidates.push(String(xmlViewerNode.innerHTML || ''));
  }

  // 结构2：<pre> 内放置转义 XML 文本（如 &lt;rss&gt;...）。
  const preNode = htmlDoc.querySelector('pre');
  if (preNode) {
    candidates.push(String(preNode.textContent || ''));
    candidates.push(decodeHtmlEntities(String(preNode.innerHTML || '')));
  }

  candidates.push(rawHtml);

  for (const candidateRaw of candidates) {
    const candidate = String(candidateRaw || '').trim();
    if (!candidate) continue;
    const decodedCandidate = decodeHtmlEntities(candidate);
    const parsedTitle = extractTitleFromXmlText(decodedCandidate) || extractTitleByRegex(decodedCandidate);
    if (parsedTitle) return parsedTitle;
  }
  return '';
}

function openAddFeedDialog() {
  const headers = authHeaders();
  if (!headers) {
    showMsg('请先登录后再添加订阅', true);
    return;
  }

  const mask = createDialogMask();
  const dialog = document.createElement('div');
  dialog.style.width = 'min(560px, calc(100vw - 32px))';
  dialog.style.background = '#fff';
  dialog.style.borderRadius = '10px';
  dialog.style.padding = '16px';
  dialog.style.boxShadow = '0 18px 50px rgba(15, 23, 42, 0.28)';
  dialog.innerHTML = `
    <h3 style="margin:0 0 12px;font-size:16px;color:#1f3344;">新增订阅 Feed</h3>
    <label style="display:block;margin:0 0 6px;color:#4c6072;font-size:13px;">Feed 地址</label>
    <input id="reader-feed-url-input" type="url" placeholder="https://example.com/rss.xml" style="width:100%;height:34px;padding:0 10px;border:1px solid #d0d7de;border-radius:6px;box-sizing:border-box;">
    <label style="display:block;margin:12px 0 6px;color:#4c6072;font-size:13px;">Feed 标题</label>
    <input id="reader-feed-title-input" type="text" placeholder="自动解析后可手动修改" style="width:100%;height:34px;padding:0 10px;border:1px solid #d0d7de;border-radius:6px;box-sizing:border-box;">
    <label style="display:block;margin:12px 0 6px;color:#4c6072;font-size:13px;">Favicon 地址</label>
    <input id="reader-feed-favicon-input" type="url" placeholder="自动从网站根域名识别，可手动修改" style="width:100%;height:34px;padding:0 10px;border:1px solid #d0d7de;border-radius:6px;box-sizing:border-box;">
    <label style="display:block;margin:12px 0 6px;color:#4c6072;font-size:13px;">选择分组</label>
    <div style="display:flex;gap:8px;align-items:center;">
      <select id="reader-feed-group-select" style="flex:1;height:34px;padding:0 10px;border:1px solid #d0d7de;border-radius:6px;box-sizing:border-box;background:#fff;">
        <option value="">未分组</option>
      </select>
      <button type="button" data-act="add-group" style="min-width:34px;height:34px;border:1px solid #0969da;background:#fff;color:#0969da;border-radius:6px;cursor:pointer;" title="新增分组" aria-label="新增分组">+</button>
    </div>
    <label style="display:block;margin:12px 0 6px;color:#4c6072;font-size:13px;">是否经过代理</label>
    <div style="display:flex;flex-wrap:wrap;gap:12px 16px;align-items:center;">
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#1f3344;cursor:pointer;">
        <input type="radio" name="reader-feed-use-proxy" value="0" checked> 不需要
      </label>
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#1f3344;cursor:pointer;">
        <input type="radio" name="reader-feed-use-proxy" value="1"> 需要通过代理（127.0.0.1:7890）
      </label>
    </div>
    <label style="display:flex;align-items:center;gap:8px;margin:12px 0 0;font-size:13px;color:#1f3344;cursor:pointer;">
      <input type="checkbox" id="reader-feed-needs-translation" />
      英文源需要翻译（爬取后自动将标题和简介译为中文）
    </label>
    <p id="reader-feed-dialog-msg" style="margin:8px 0 0;min-height:18px;font-size:12px;color:#7a8794;"></p>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
      <button type="button" data-act="cancel" style="border:1px solid #d0d7de;background:#fff;color:#1f3344;border-radius:6px;padding:6px 10px;cursor:pointer;">取消</button>
      <button type="button" data-act="confirm" style="border:1px solid #0969da;background:#0969da;color:#fff;border-radius:6px;padding:6px 10px;cursor:pointer;">确认订阅</button>
    </div>
  `;
  mask.appendChild(dialog);
  document.body.appendChild(mask);

  const urlInput = dialog.querySelector('#reader-feed-url-input');
  const titleInput = dialog.querySelector('#reader-feed-title-input');
  const faviconInput = dialog.querySelector('#reader-feed-favicon-input');
  const groupSelect = dialog.querySelector('#reader-feed-group-select');
  const addGroupBtn = dialog.querySelector('button[data-act="add-group"]');
  const msgEl = dialog.querySelector('#reader-feed-dialog-msg');
  const confirmBtn = dialog.querySelector('button[data-act="confirm"]');
  const cancelBtn = dialog.querySelector('button[data-act="cancel"]');
  if (
    !(urlInput instanceof HTMLInputElement) ||
    !(titleInput instanceof HTMLInputElement) ||
    !(faviconInput instanceof HTMLInputElement) ||
    !(groupSelect instanceof HTMLSelectElement) ||
    !(addGroupBtn instanceof HTMLButtonElement) ||
    !(msgEl instanceof HTMLElement) ||
    !(confirmBtn instanceof HTMLButtonElement) ||
    !(cancelBtn instanceof HTMLButtonElement)
  ) {
    if (mask.parentNode) mask.parentNode.removeChild(mask);
    return;
  }

  function closeDialog() {
    if (feedTitleAutoFillController) {
      feedTitleAutoFillController.abort();
      feedTitleAutoFillController = null;
    }
    if (feedTitleAutoFillTimer) {
      clearTimeout(feedTitleAutoFillTimer);
      feedTitleAutoFillTimer = null;
    }
    if (mask.parentNode) mask.parentNode.removeChild(mask);
  }

  async function autoFillTitleByFeedUrl(feedUrl) {
    if (feedTitleAutoFillController) {
      feedTitleAutoFillController.abort();
    }
    feedTitleAutoFillController = new AbortController();
    msgEl.textContent = '正在解析标题...';
    try {
      // 通过后端渲染接口代理拉取标题，规避浏览器跨域限制
      const res = await fetch(`${API_BASE_URL}/page-renderer/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: feedTitleAutoFillController.signal,
        body: JSON.stringify({
          url: feedUrl,
          waitForTimeout: 20000,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '自动解析失败');
      const html = String(data.html || '');
      let parsedTitle = extractFeedTitleFromRenderedHtml(html);
      if (!parsedTitle) {
        parsedTitle = String(data.title || '').trim();
      }
      if (parsedTitle && !titleInput.value.trim()) {
        titleInput.value = parsedTitle;
      } else if (parsedTitle && titleInput.value.trim()) {
        // 用户已填写时不强覆盖，减少误改
      } else if (!titleInput.value.trim()) {
        titleInput.value = feedUrl;
      }
      msgEl.textContent = parsedTitle ? '已自动解析标题，可继续修改' : '未解析到标题，请手动填写';
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      msgEl.textContent = '自动解析失败，请手动填写标题';
    } finally {
      feedTitleAutoFillController = null;
    }
  }

  async function autoFillFaviconByFeedUrl(feedUrl) {
    if (!feedUrl || faviconInput.value.trim()) return;
    const siteRootUrl = getFeedSiteRootUrl(feedUrl);
    if (!siteRootUrl) return;
    msgEl.textContent = '正在解析网站 favicon...';
    try {
      const res = await fetch(`${API_BASE_URL}/page-renderer/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: feedTitleAutoFillController ? feedTitleAutoFillController.signal : undefined,
        body: JSON.stringify({
          url: siteRootUrl,
          waitForTimeout: 12000,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'favicon 解析失败');
      const faviconUrl = findFaviconFromHtml(String(data.html || ''), siteRootUrl);
      if (faviconUrl && !faviconInput.value.trim()) {
        faviconInput.value = faviconUrl;
        msgEl.textContent = '已自动解析标题和 favicon，可继续修改';
      } else if (!titleInput.value.trim()) {
        msgEl.textContent = '未解析到 favicon，请手动填写';
      }
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      if (!faviconInput.value.trim()) msgEl.textContent = 'favicon 自动解析失败，可手动填写';
    }
  }

  async function loadGroupsForSelect(selectedGroupId) {
    try {
      const res = await fetch(`${API_BASE_URL}/feed-subscriptions`, { headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '加载分组失败');
      const groups = Array.isArray(data.groups) ? data.groups : [];
      groupSelect.innerHTML = '<option value="">未分组</option>';
      groups.forEach((group) => {
        const id = Number(group?.id);
        const name = String(group?.name || '').trim();
        if (!Number.isFinite(id) || !name) return;
        const option = document.createElement('option');
        option.value = String(id);
        option.textContent = name;
        groupSelect.appendChild(option);
      });
      if (selectedGroupId != null && selectedGroupId !== '') {
        groupSelect.value = String(selectedGroupId);
      }
    } catch (error) {
      console.error('loadGroupsForSelect failed:', error);
      msgEl.textContent = '分组加载失败，默认将订阅到未分组';
    }
  }

  async function createGroupAndSelect() {
    const nextName = window.prompt('请输入新分组名称', '');
    if (nextName == null) return;
    const cleanName = String(nextName).trim();
    if (!cleanName) {
      msgEl.textContent = '分组名称不能为空';
      return;
    }
    addGroupBtn.disabled = true;
    addGroupBtn.textContent = '...';
    try {
      const res = await fetch(`${API_BASE_URL}/feed-subscriptions/groups`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: cleanName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '创建分组失败');
      const newGroupId = data?.group?.id;
      await loadGroupsForSelect(newGroupId);
      msgEl.textContent = '分组已创建并选中';
    } catch (error) {
      msgEl.textContent = error.message || '创建分组失败';
    } finally {
      addGroupBtn.disabled = false;
      addGroupBtn.textContent = '+';
    }
  }

  addGroupBtn.addEventListener('click', createGroupAndSelect);
  loadGroupsForSelect();

  urlInput.addEventListener('keyup', () => {
    const feedUrl = urlInput.value.trim();
    if (feedTitleAutoFillTimer) {
      clearTimeout(feedTitleAutoFillTimer);
      feedTitleAutoFillTimer = null;
    }
    if (!feedUrl) {
      msgEl.textContent = '';
      return;
    }
    feedTitleAutoFillTimer = setTimeout(() => {
      autoFillTitleByFeedUrl(feedUrl).then(() => autoFillFaviconByFeedUrl(feedUrl));
    }, 500);
  });

  cancelBtn.addEventListener('click', closeDialog);
  mask.addEventListener('click', (event) => {
    if (event.target === mask) closeDialog();
  });

  confirmBtn.addEventListener('click', async () => {
    const feedUrl = urlInput.value.trim();
    const feedTitle = titleInput.value.trim();
    const faviconUrl = faviconInput.value.trim();
    if (!feedUrl) {
      msgEl.textContent = '请先输入 Feed 地址';
      return;
    }
    if (!feedTitle) {
      msgEl.textContent = '请填写 Feed 标题';
      return;
    }
    confirmBtn.disabled = true;
    confirmBtn.textContent = '提交中...';
    msgEl.textContent = '';
    try {
      const selectedGroupIdValue = String(groupSelect.value || '').trim();
      const selectedGroupId = selectedGroupIdValue ? Number(selectedGroupIdValue) : null;
      const useProxyInput = dialog.querySelector('input[name="reader-feed-use-proxy"]:checked');
      const useProxy = useProxyInput instanceof HTMLInputElement && useProxyInput.value === '1';
      const needsTranslationEl = dialog.querySelector('#reader-feed-needs-translation');
      const needsTranslation = needsTranslationEl instanceof HTMLInputElement && needsTranslationEl.checked;
      const res = await fetch(`${API_BASE_URL}/feed-subscriptions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          feedTitle,
          feedUrl,
          faviconUrl,
          groupId: Number.isFinite(selectedGroupId) ? selectedGroupId : null,
          sourceType: 'native',
          useProxy,
          needsTranslation,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '添加订阅失败');
      closeDialog();
      showMsg('Feed 订阅添加成功', false);
      await loadMenu();
      await loadArticles();
      await refreshUnreadCount();
    } catch (error) {
      msgEl.textContent = error.message || '添加订阅失败';
      confirmBtn.disabled = false;
      confirmBtn.textContent = '确认订阅';
    }
  });
}

window.openAddFeedDialog = openAddFeedDialog;

function ensureGroupContextMenu() {
  let menu = document.getElementById('article-reader-group-context-menu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'article-reader-group-context-menu';
  menu.className = 'article-reader-group-context-menu hidden';
  menu.innerHTML = `
    <button type="button" class="article-reader-group-context-item" data-action="rename">修改</button>
    <button type="button" class="article-reader-group-context-item danger" data-action="delete">删除</button>
  `;
  document.body.appendChild(menu);

  menu.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.getAttribute('data-action');
    if (!action || !contextMenuGroup) return;
    const selectedGroup = { ...contextMenuGroup };
    closeGroupContextMenu();
    if (action === 'rename') {
      await editGroup(selectedGroup);
    } else if (action === 'delete') {
      await deleteGroup(selectedGroup.id, selectedGroup.name);
    }
  });
  return menu;
}

function closeGroupContextMenu() {
  const menu = document.getElementById('article-reader-group-context-menu');
  if (!menu) return;
  menu.classList.add('hidden');
  contextMenuGroup = null;
}

function openGroupContextMenu(clientX, clientY, groupId, groupName, groupIcon) {
  const menu = ensureGroupContextMenu();
  closeFeedContextMenu();
  contextMenuGroup = {
    id: groupId,
    name: groupName,
    icon: String(groupIcon || '').trim() || 'folder',
  };
  menu.classList.remove('hidden');
  const maxLeft = Math.max(8, window.innerWidth - menu.offsetWidth - 8);
  const maxTop = Math.max(8, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = `${Math.min(clientX, maxLeft)}px`;
  menu.style.top = `${Math.min(clientY, maxTop)}px`;
}

function ensureFeedContextMenu() {
  let menu = document.getElementById('article-reader-feed-context-menu');
  if (
    menu &&
    menu.querySelector('[data-action="move-up"]') &&
    menu.querySelector('[data-action="pin-top"]') &&
    menu.querySelector('[data-action="translate"]') &&
    menu.querySelector('[data-action="toggle-original"]')
  ) {
    return menu;
  }
  if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
  menu = document.createElement('div');
  menu.id = 'article-reader-feed-context-menu';
  menu.className = 'article-reader-group-context-menu hidden';
  menu.innerHTML = `
    <button type="button" class="article-reader-group-context-item" data-action="pin-top">置顶</button>
    <button type="button" class="article-reader-group-context-item" data-action="move-up">上移一位</button>
    <button type="button" class="article-reader-group-context-item" data-action="move-down">下移一位</button>
    <button type="button" class="article-reader-group-context-item" data-action="info">查看信息</button>
    <button type="button" class="article-reader-group-context-item" data-action="crawl">开始爬取</button>
    <button type="button" class="article-reader-group-context-item hidden" data-action="translate">执行翻译</button>
    <button type="button" class="article-reader-group-context-item hidden" data-action="toggle-original">显示原文</button>
    <button type="button" class="article-reader-group-context-item" data-action="rename">修改</button>
    <button type="button" class="article-reader-group-context-item danger" data-action="delete">删除</button>
  `;
  document.body.appendChild(menu);

  menu.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.getAttribute('data-action');
    if (!action || !contextMenuFeed) return;
    const selectedFeed = { ...contextMenuFeed };
    closeFeedContextMenu();
    if (action === 'pin-top') {
      await pinFeedToTopInMenu(selectedFeed.id);
    } else if (action === 'move-up') {
      await moveFeedInMenu(selectedFeed.id, 'up');
    } else if (action === 'move-down') {
      await moveFeedInMenu(selectedFeed.id, 'down');
    } else if (action === 'info') {
      await showFeedInfoDialog(selectedFeed);
    } else if (action === 'crawl') {
      await triggerFeedCrawl(selectedFeed.id, selectedFeed.title);
    } else if (action === 'translate') {
      await triggerFeedTranslation(selectedFeed);
    } else if (action === 'toggle-original') {
      toggleFeedShowOriginal(selectedFeed);
    } else if (action === 'rename') {
      await editFeed(selectedFeed);
    } else if (action === 'delete') {
      await deleteFeed(selectedFeed);
    }
  });
  return menu;
}

function closeFeedContextMenu() {
  const menu = document.getElementById('article-reader-feed-context-menu');
  if (!menu) return;
  menu.classList.add('hidden');
  contextMenuFeed = null;
}

async function triggerFeedCrawl(feedId, feedTitle) {
  const label = String(feedTitle || '').trim() || `Feed #${feedId}`;
  void CrawlLogDialog.runCrawl(feedId, {
    title: `爬取 · ${label}`,
    showMsg,
    onComplete: loadMenu,
  });
}

function syncFeedContextMenuTranslationState(feedData) {
  const menu = document.getElementById('article-reader-feed-context-menu');
  if (!menu || !feedData) return;
  const translateBtn = menu.querySelector('[data-action="translate"]');
  const toggleBtn = menu.querySelector('[data-action="toggle-original"]');
  const showTranslationActions = feedData.needsTranslation === true;
  if (translateBtn instanceof HTMLButtonElement) {
    translateBtn.classList.toggle('hidden', !showTranslationActions);
    translateBtn.disabled = false;
    translateBtn.textContent = '执行翻译';
  }
  if (toggleBtn instanceof HTMLButtonElement) {
    toggleBtn.classList.toggle('hidden', !showTranslationActions);
    toggleBtn.textContent = isFeedShowingOriginal(feedData.id) ? '显示中文' : '显示原文';
  }
}

async function triggerFeedTranslation(feedData) {
  const headers = authHeaders();
  if (!headers) return;
  const feedId = Number(feedData?.id);
  if (!Number.isFinite(feedId)) return;

  const label = String(feedData.title || '').trim() || `Feed #${feedId}`;
  showMsg(`正在翻译「${label}」…`, false);
  try {
    const res = await fetch(`${API_BASE_URL}/feeds/${feedId}/translate`, {
      method: 'POST',
      headers: { Authorization: headers.Authorization },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '翻译失败');
    const translated = Number(data.translated);
    const total = Number(data.total);
    const failed = Number(data.failed);
    const summary = Number.isFinite(translated) && Number.isFinite(total)
      ? `翻译完成：${translated}/${total} 篇${Number.isFinite(failed) && failed > 0 ? `，失败 ${failed} 篇` : ''}`
      : (data.message || '翻译完成');
    showMsg(summary, false);
    if (String(activeFeedId || '') === String(feedId)) {
      await loadArticles();
    } else if (bulletinActive) {
      await refreshBulletinCards();
    }
  } catch (error) {
    showMsg(error.message || '翻译失败', true);
  }
}

function toggleFeedShowOriginal(feedData) {
  const feedId = Number(feedData?.id);
  if (!Number.isFinite(feedId)) return;
  const nextShowOriginal = !isFeedShowingOriginal(feedId);
  setFeedShowingOriginal(feedId, nextShowOriginal);
  showMsg(nextShowOriginal ? '已切换为显示原文' : '已切换为显示中文', false);

  if (String(activeFeedId || '') === String(feedId)) {
    renderArticles(currentArticles, {
      preserveSelection: true,
      prevActiveArticleId: currentArticles[activeArticleIndex]?.id,
    });
    const activeArticle = currentArticles[activeArticleIndex];
    if (activeArticle) updateDetailPane(activeArticle);
  } else if (bulletinActive) {
    void refreshBulletinCards();
  }
}

function findFeedMenuContext(feedId) {
  const targetId = Number(feedId);
  if (!Number.isFinite(targetId)) return null;
  for (const group of menuState) {
    const feeds = sortFeedsInMenuOrder(group.feeds || []);
    const idx = feeds.findIndex((f) => Number(f?.id) === targetId);
    if (idx >= 0) return { group, feeds, idx };
  }
  return null;
}

function syncFeedContextMenuMoveState(feedId) {
  const menu = document.getElementById('article-reader-feed-context-menu');
  if (!menu) return;
  const pinBtn = menu.querySelector('[data-action="pin-top"]');
  const upBtn = menu.querySelector('[data-action="move-up"]');
  const downBtn = menu.querySelector('[data-action="move-down"]');
  const ctx = findFeedMenuContext(feedId);
  const atTop = !ctx || ctx.idx <= 0;
  const atBottom = !ctx || ctx.idx >= ctx.feeds.length - 1;
  if (pinBtn instanceof HTMLButtonElement) pinBtn.disabled = atTop;
  if (upBtn instanceof HTMLButtonElement) upBtn.disabled = atTop;
  if (downBtn instanceof HTMLButtonElement) downBtn.disabled = atBottom;
}

async function updateFeedSortOrderApi(feedId, sortOrder, headers) {
  const res = await fetch(`${API_BASE_URL}/feeds/${feedId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ sort_order: Math.floor(sortOrder) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '排序更新失败');
}

function groupNeedsSortOrderNormalize(feeds) {
  const list = Array.isArray(feeds) ? feeds : [];
  if (list.length < 2) return false;
  const orders = list.map((f) => Number(f?.sortOrder ?? f?.sort_order ?? 0));
  if (new Set(orders).size !== orders.length) return true;
  for (let i = 1; i < list.length; i += 1) {
    if (orders[i] === orders[i - 1]) return true;
  }
  return false;
}

async function pinFeedToTopInMenu(feedId) {
  const headers = authHeaders();
  if (!headers) return;

  const ctx = findFeedMenuContext(feedId);
  if (!ctx) {
    showMsg('未找到该 Feed', true);
    return;
  }

  let feeds = ctx.feeds.map((f) => ({ ...f }));
  let idx = feeds.findIndex((f) => Number(f.id) === Number(feedId));
  if (idx < 0) return;
  if (idx === 0) {
    showMsg('已在最上方', true);
    return;
  }

  try {
    if (groupNeedsSortOrderNormalize(feeds)) {
      feeds = feeds.map((f, i) => ({ ...f, sortOrder: i * 10 }));
      await Promise.all(feeds.map((f) => updateFeedSortOrderApi(f.id, f.sortOrder, headers)));
      idx = feeds.findIndex((f) => Number(f.id) === Number(feedId));
    }

    const [movedFeed] = feeds.splice(idx, 1);
    feeds.unshift(movedFeed);

    const updates = [];
    feeds.forEach((f, i) => {
      const newOrder = i * 10;
      if (Number(f.sortOrder) !== newOrder) {
        f.sortOrder = newOrder;
        updates.push({ id: f.id, sortOrder: newOrder });
      }
    });

    if (!updates.length) {
      feeds.forEach((f, i) => {
        updates.push({ id: f.id, sortOrder: i * 10 });
      });
    }

    await Promise.all(updates.map((item) => updateFeedSortOrderApi(item.id, item.sortOrder, headers)));
    showMsg('已置顶', false);
    await loadMenu();
  } catch (error) {
    showMsg(error.message || '置顶失败', true);
  }
}

async function moveFeedInMenu(feedId, direction) {
  const headers = authHeaders();
  if (!headers) return;

  const ctx = findFeedMenuContext(feedId);
  if (!ctx) {
    showMsg('未找到该 Feed', true);
    return;
  }

  let feeds = ctx.feeds.map((f) => ({ ...f }));
  let idx = feeds.findIndex((f) => Number(f.id) === Number(feedId));
  if (idx < 0) return;

  const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (targetIdx < 0) {
    showMsg('已在最上方', true);
    return;
  }
  if (targetIdx >= feeds.length) {
    showMsg('已在最下方', true);
    return;
  }

  try {
    if (groupNeedsSortOrderNormalize(feeds)) {
      feeds = feeds.map((f, i) => ({ ...f, sortOrder: i * 10 }));
      await Promise.all(feeds.map((f) => updateFeedSortOrderApi(f.id, f.sortOrder, headers)));
      idx = feeds.findIndex((f) => Number(f.id) === Number(feedId));
    }

    [feeds[idx], feeds[targetIdx]] = [feeds[targetIdx], feeds[idx]];

    const updates = [];
    feeds.forEach((f, i) => {
      const newOrder = i * 10;
      if (Number(f.sortOrder) !== newOrder) {
        f.sortOrder = newOrder;
        updates.push({ id: f.id, sortOrder: newOrder });
      }
    });

    if (!updates.length) {
      updates.push(
        { id: feeds[targetIdx].id, sortOrder: targetIdx * 10 },
        { id: feeds[idx].id, sortOrder: idx * 10 },
      );
    }

    await Promise.all(updates.map((item) => updateFeedSortOrderApi(item.id, item.sortOrder, headers)));
    showMsg(direction === 'up' ? '已上移一位' : '已下移一位', false);
    await loadMenu();
  } catch (error) {
    showMsg(error.message || '调整排序失败', true);
  }
}

function openFeedContextMenu(clientX, clientY, feedData) {
  const menu = ensureFeedContextMenu();
  closeGroupContextMenu();
  contextMenuFeed = { ...feedData };
  syncFeedContextMenuMoveState(feedData.id);
  syncFeedContextMenuTranslationState(feedData);
  menu.classList.remove('hidden');
  const maxLeft = Math.max(8, window.innerWidth - menu.offsetWidth - 8);
  const maxTop = Math.max(8, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = `${Math.min(clientX, maxLeft)}px`;
  menu.style.top = `${Math.min(clientY, maxTop)}px`;
}

async function fetchFeedArticleCount(feedId) {
  const headers = authHeaders();
  if (!headers || !Number.isFinite(Number(feedId))) return 0;
  try {
    const params = new URLSearchParams();
    params.set('feedId', String(feedId));
    params.set('limit', '1000');
    const res = await fetch(`${API_BASE_URL}/feed-subscriptions/articles?${params.toString()}`, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return 0;
    const articles = Array.isArray(data.articles) ? data.articles : [];
    return articles.length;
  } catch (error) {
    console.error('fetchFeedArticleCount failed:', error);
    return 0;
  }
}

async function showFeedInfoDialog(feedData) {
  const articleCount = await fetchFeedArticleCount(feedData.id);
  const mask = createDialogMask();
  const dialog = document.createElement('div');
  dialog.style.width = 'min(580px, calc(100vw - 32px))';
  dialog.style.background = '#fff';
  dialog.style.borderRadius = '10px';
  dialog.style.padding = '16px';
  dialog.style.boxShadow = '0 18px 50px rgba(15, 23, 42, 0.28)';
  dialog.innerHTML = `
    <h3 style="margin:0 0 14px;font-size:16px;color:#1f3344;">Feed 信息</h3>
    <div style="display:grid;grid-template-columns:130px minmax(0,1fr);gap:8px 10px;font-size:13px;color:#314658;line-height:1.5;">
      <strong>名称</strong><span>${escapeHtml(feedData.title || '未命名 Feed')}</span>
      <strong>URL</strong><span style="word-break:break-all;">${escapeHtml(feedData.url || '—')}</span>
      <strong>分组</strong><span>${escapeHtml(feedData.groupName || '未分组')}</span>
      <strong>添加日期</strong><span>${escapeHtml(formatDateTimeForDisplay(feedData.createdAt))}</span>
      <strong>最近更新日期</strong><span>${escapeHtml(formatDateTimeForDisplay(feedData.updatedAt))}</span>
      <strong>文章数</strong><span>${escapeHtml(articleCount >= 1000 ? '1000+' : String(articleCount))}</span>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:16px;">
      <button type="button" data-act="close" style="border:1px solid #0969da;background:#0969da;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;">关闭</button>
    </div>
  `;
  mask.appendChild(dialog);
  document.body.appendChild(mask);
  const closeBtn = dialog.querySelector('button[data-act="close"]');
  const closeDialog = () => {
    if (mask.parentNode) mask.parentNode.removeChild(mask);
  };
  if (closeBtn) closeBtn.addEventListener('click', closeDialog);
  mask.addEventListener('click', (event) => {
    if (event.target === mask) closeDialog();
  });
}

function createUpgradeMembershipConfirmDialog() {
  return new Promise((resolve) => {
    const mask = createDialogMask();
    const dialog = document.createElement('div');
    dialog.style.width = 'min(430px, calc(100vw - 32px))';
    dialog.style.background = '#fff';
    dialog.style.borderRadius = '10px';
    dialog.style.padding = '16px';
    dialog.style.boxShadow = '0 18px 50px rgba(15, 23, 42, 0.28)';
    dialog.innerHTML = `
      <h3 style="margin:0 0 10px;font-size:16px;color:#1f3344;">高级会员功能</h3>
      <p style="margin:0 0 12px;color:#4c6072;line-height:1.6;">
        小于 1800 秒的更新间隔为高级会员专享功能。是否现在前往会员页面？
      </p>
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button type="button" data-act="cancel" style="border:1px solid #d0d7de;background:#fff;color:#1f3344;border-radius:6px;padding:6px 10px;cursor:pointer;">取消</button>
        <button type="button" data-act="confirm" style="border:1px solid #0969da;background:#0969da;color:#fff;border-radius:6px;padding:6px 10px;cursor:pointer;">去开通会员</button>
      </div>
    `;
    mask.appendChild(dialog);
    document.body.appendChild(mask);

    function done(ok) {
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      resolve(ok);
    }

    mask.addEventListener('click', (event) => {
      if (event.target === mask) done(false);
    });
    const cancelBtn = dialog.querySelector('button[data-act="cancel"]');
    const confirmBtn = dialog.querySelector('button[data-act="confirm"]');
    if (cancelBtn) cancelBtn.addEventListener('click', () => done(false));
    if (confirmBtn) confirmBtn.addEventListener('click', () => done(true));
  });
}

function ensureValidIntervalValue(value) {
  const next = Number(value);
  if (!Number.isFinite(next)) return 1800;
  return Math.min(604800, Math.max(60, Math.floor(next)));
}

function getVipTrackPercent(value, min, max) {
  if (!(max > min)) return 0;
  const safeValue = Math.min(max, Math.max(min, value));
  return ((safeValue - min) / (max - min)) * 100;
}

async function editFeed(feedData) {
  const headers = authHeaders();
  if (!headers) return;

  const mask = createDialogMask();
  const dialog = document.createElement('div');
  dialog.style.width = 'min(600px, calc(100vw - 32px))';
  dialog.style.background = '#fff';
  dialog.style.borderRadius = '10px';
  dialog.style.padding = '16px';
  dialog.style.boxShadow = '0 18px 50px rgba(15, 23, 42, 0.28)';
  dialog.innerHTML = `
    <h3 style="margin:0 0 12px;font-size:16px;color:#1f3344;">修改 Feed</h3>
    <label style="display:block;margin:0 0 6px;color:#4c6072;font-size:13px;">Feed 名称</label>
    <input id="reader-feed-edit-name" type="text" style="width:100%;height:34px;padding:0 10px;border:1px solid #d0d7de;border-radius:6px;box-sizing:border-box;">
    <label style="display:block;margin:12px 0 6px;color:#4c6072;font-size:13px;">描述</label>
    <textarea id="reader-feed-edit-desc" rows="4" style="width:100%;padding:8px 10px;border:1px solid #d0d7de;border-radius:6px;box-sizing:border-box;resize:vertical;"></textarea>
    <label style="display:block;margin:12px 0 6px;color:#4c6072;font-size:13px;">Favicon 地址</label>
    <div style="display:flex;gap:8px;align-items:center;">
      <input id="reader-feed-edit-favicon" type="url" placeholder="https://example.com/favicon.ico" style="flex:1;height:34px;padding:0 10px;border:1px solid #d0d7de;border-radius:6px;box-sizing:border-box;">
      <button type="button" id="reader-feed-edit-favicon-fetch" style="flex-shrink:0;height:34px;padding:0 12px;border:1px solid #d0d7de;background:#fff;color:#1f3344;border-radius:6px;cursor:pointer;white-space:nowrap;">自动获取</button>
    </div>
    <label style="display:block;margin:12px 0 6px;color:#4c6072;font-size:13px;">分组</label>
    <select id="reader-feed-edit-group" style="width:100%;height:34px;padding:0 10px;border:1px solid #d0d7de;border-radius:6px;box-sizing:border-box;background:#fff;">
      <option value="">未分组</option>
    </select>
    <label style="display:block;margin:12px 0 6px;color:#4c6072;font-size:13px;">排序</label>
    <input id="reader-feed-edit-sort-order" type="number" min="0" max="999999" step="1" style="width:100%;height:34px;padding:0 10px;border:1px solid #d0d7de;border-radius:6px;box-sizing:border-box;">
    <p style="margin:4px 0 0;font-size:12px;color:#7a8794;">数字越小越靠前，可在左侧 Feed 列表中调整显示顺序</p>
    <label style="display:block;margin:12px 0 6px;color:#4c6072;font-size:13px;">是否经过代理</label>
    <div style="display:flex;flex-wrap:wrap;gap:12px 16px;align-items:center;">
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#1f3344;cursor:pointer;">
        <input type="radio" name="reader-feed-edit-use-proxy" value="0" checked> 不需要
      </label>
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#1f3344;cursor:pointer;">
        <input type="radio" name="reader-feed-edit-use-proxy" value="1"> 需要通过代理（127.0.0.1:7890）
      </label>
    </div>
    <label style="display:flex;align-items:center;gap:8px;margin:12px 0 0;font-size:13px;color:#1f3344;cursor:pointer;">
      <input type="checkbox" id="reader-feed-edit-needs-translation" />
      英文源需要翻译（爬取后自动将标题和简介译为中文）
    </label>
    <label style="display:block;margin:12px 0 6px;color:#4c6072;font-size:13px;">更新间隔</label>
    <div style="position:relative;padding-top:24px;">
      <div style="position:absolute;left:0;top:0;font-size:12px;color:#0969da;font-weight:600;">VIP 专享（&lt;1800 秒）</div>
      <input id="reader-feed-edit-interval" type="range" min="60" max="7200" step="60" value="1800" style="width:100%;accent-color:#1f6feb;">
      <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:12px;color:#7a8794;">
        <span>60 秒</span>
        <span id="reader-feed-edit-interval-value" style="color:#1f3344;font-weight:600;">1800 秒</span>
        <span>7200 秒</span>
      </div>
      <div id="reader-feed-edit-vip-track" style="position:absolute;left:0;top:29px;height:4px;background:#0b3b8a;border-radius:999px;pointer-events:none;"></div>
    </div>
    <p id="reader-feed-edit-msg" style="margin:10px 0 0;min-height:18px;font-size:12px;color:#7a8794;"></p>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
      <button type="button" data-act="cancel" style="border:1px solid #d0d7de;background:#fff;color:#1f3344;border-radius:6px;padding:6px 10px;cursor:pointer;">取消</button>
      <button type="button" data-act="confirm" style="border:1px solid #0969da;background:#0969da;color:#fff;border-radius:6px;padding:6px 10px;cursor:pointer;">保存修改</button>
    </div>
  `;
  mask.appendChild(dialog);
  document.body.appendChild(mask);

  const nameInput = dialog.querySelector('#reader-feed-edit-name');
  const descInput = dialog.querySelector('#reader-feed-edit-desc');
  const faviconInput = dialog.querySelector('#reader-feed-edit-favicon');
  const faviconFetchBtn = dialog.querySelector('#reader-feed-edit-favicon-fetch');
  const groupSelect = dialog.querySelector('#reader-feed-edit-group');
  const sortOrderInput = dialog.querySelector('#reader-feed-edit-sort-order');
  const intervalInput = dialog.querySelector('#reader-feed-edit-interval');
  const intervalValueEl = dialog.querySelector('#reader-feed-edit-interval-value');
  const vipTrackEl = dialog.querySelector('#reader-feed-edit-vip-track');
  const msgEl = dialog.querySelector('#reader-feed-edit-msg');
  const confirmBtn = dialog.querySelector('button[data-act="confirm"]');
  const cancelBtn = dialog.querySelector('button[data-act="cancel"]');
  if (
    !(nameInput instanceof HTMLInputElement) ||
    !(descInput instanceof HTMLTextAreaElement) ||
    !(faviconInput instanceof HTMLInputElement) ||
    !(faviconFetchBtn instanceof HTMLButtonElement) ||
    !(groupSelect instanceof HTMLSelectElement) ||
    !(sortOrderInput instanceof HTMLInputElement) ||
    !(intervalInput instanceof HTMLInputElement) ||
    !(intervalValueEl instanceof HTMLElement) ||
    !(vipTrackEl instanceof HTMLElement) ||
    !(msgEl instanceof HTMLElement) ||
    !(confirmBtn instanceof HTMLButtonElement) ||
    !(cancelBtn instanceof HTMLButtonElement)
  ) {
    if (mask.parentNode) mask.parentNode.removeChild(mask);
    return;
  }

  function closeDialog() {
    if (mask.parentNode) mask.parentNode.removeChild(mask);
  }

  async function loadGroupsForSelect() {
    try {
      const res = await fetch(`${API_BASE_URL}/feed-subscriptions`, { headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '加载分组失败');
      const groups = Array.isArray(data.groups) ? data.groups : [];
      groupSelect.innerHTML = '<option value="">未分组</option>';
      groups.forEach((group) => {
        const id = Number(group?.id);
        const name = String(group?.name || '').trim();
        if (!Number.isFinite(id) || !name) return;
        const option = document.createElement('option');
        option.value = String(id);
        option.textContent = name;
        groupSelect.appendChild(option);
      });
    } catch (error) {
      msgEl.textContent = error.message || '分组加载失败';
    }
  }

  function renderIntervalHint(rawValue) {
    const value = ensureValidIntervalValue(rawValue);
    intervalInput.value = String(value);
    intervalValueEl.textContent = `${value} 秒`;
    const vipPercent = getVipTrackPercent(Math.min(1800, value), Number(intervalInput.min), Number(intervalInput.max));
    vipTrackEl.style.width = `${vipPercent}%`;
  }

  const initialName = String(feedData.title || '').trim();
  const initialDesc = String(feedData.description || '').trim();
  const initialFavicon = String(feedData.favicon_url || '').trim();
  const feedSiteUrl = String(feedData.url || '').trim();
  const initialGroupId = feedData.groupId == null ? '' : String(feedData.groupId);
  const initialSortOrder = Number.isFinite(Number(feedData.sortOrder)) ? Math.max(0, Math.floor(Number(feedData.sortOrder))) : 0;
  const initialInterval = ensureValidIntervalValue(feedData.updateInterval || 1800);
  const initialUseProxy = feedData.useProxy === true;
  const initialNeedsTranslation = feedData.needsTranslation === true;

  nameInput.value = initialName;
  descInput.value = initialDesc;
  faviconInput.value = initialFavicon;
  sortOrderInput.value = String(initialSortOrder);
  intervalInput.value = String(initialInterval);
  renderIntervalHint(initialInterval);
  await loadGroupsForSelect();
  if (initialGroupId) groupSelect.value = initialGroupId;
  dialog.querySelectorAll('input[name="reader-feed-edit-use-proxy"]').forEach((input) => {
    if (!(input instanceof HTMLInputElement)) return;
    input.checked = input.value === (initialUseProxy ? '1' : '0');
  });
  const needsTranslationEl = dialog.querySelector('#reader-feed-edit-needs-translation');
  if (needsTranslationEl instanceof HTMLInputElement) {
    needsTranslationEl.checked = initialNeedsTranslation;
  }

  faviconFetchBtn.addEventListener('click', async () => {
    const autoUrl = faviconUrlFromSite(feedSiteUrl);
    if (!autoUrl) {
      msgEl.textContent = '无法从 Feed 地址解析网站域名，请手动填写';
      return;
    }
    faviconFetchBtn.disabled = true;
    faviconFetchBtn.textContent = '获取中…';
    msgEl.textContent = `正在尝试 ${autoUrl} …`;
    const loaded = await probeFaviconUrl(autoUrl);
    faviconInput.value = autoUrl;
    msgEl.textContent = loaded
      ? '已从网站 /favicon.ico 获取'
      : '已填入 /favicon.ico 地址，但预览加载失败，可手动修改后保存';
    faviconFetchBtn.disabled = false;
    faviconFetchBtn.textContent = '自动获取';
  });

  let vipPromptLock = false;
  intervalInput.addEventListener('input', async () => {
    renderIntervalHint(intervalInput.value);
    const intervalValue = ensureValidIntervalValue(intervalInput.value);
    if (intervalValue >= 1800 || vipPromptLock) return;
    vipPromptLock = true;
    const shouldUpgrade = await createUpgradeMembershipConfirmDialog();
    intervalInput.value = '1800';
    renderIntervalHint(1800);
    if (shouldUpgrade) {
      window.location.href = 'membership.html';
    }
    vipPromptLock = false;
  });

  cancelBtn.addEventListener('click', closeDialog);
  mask.addEventListener('click', (event) => {
    if (event.target === mask) closeDialog();
  });

  confirmBtn.addEventListener('click', async () => {
    const cleanName = String(nameInput.value || '').trim();
    const nextDesc = String(descInput.value || '').trim();
    const nextFavicon = String(faviconInput.value || '').trim();
    const selectedGroupValue = String(groupSelect.value || '').trim();
    const nextGroupId = selectedGroupValue ? Number(selectedGroupValue) : null;
    const nextSortOrder = Number(sortOrderInput.value);
    const nextInterval = ensureValidIntervalValue(intervalInput.value);
    const useProxyInput = dialog.querySelector('input[name="reader-feed-edit-use-proxy"]:checked');
    const nextUseProxy = useProxyInput instanceof HTMLInputElement && useProxyInput.value === '1';
    const needsTranslationInput = dialog.querySelector('#reader-feed-edit-needs-translation');
    const nextNeedsTranslation = needsTranslationInput instanceof HTMLInputElement && needsTranslationInput.checked;
    if (!cleanName) {
      msgEl.textContent = 'Feed 名称不能为空';
      return;
    }
    if (!Number.isFinite(nextSortOrder) || nextSortOrder < 0 || nextSortOrder > 999999) {
      msgEl.textContent = '排序须为 0～999999 的整数';
      return;
    }
    if (nextInterval < 1800) {
      msgEl.textContent = '小于 1800 秒的更新间隔为高级会员专享';
      return;
    }
    confirmBtn.disabled = true;
    confirmBtn.textContent = '保存中...';
    msgEl.textContent = '';
    try {
      const res = await fetch(`${API_BASE_URL}/feeds/${feedData.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          name: cleanName,
          description: nextDesc,
          favicon_url: nextFavicon || null,
          group_id: Number.isFinite(nextGroupId) ? nextGroupId : null,
          sort_order: Math.floor(nextSortOrder),
          update_interval: nextInterval,
          use_proxy: nextUseProxy,
          needs_translation: nextNeedsTranslation,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Feed 修改失败');
      if (String(activeFeedId || '') === String(feedData.id)) {
        activeFeedTitle = cleanName;
        updateCurrentFeedTitle(cleanName);
      }
      closeDialog();
      showMsg('Feed 已修改', false);
      await loadMenu();
      await loadArticles();
      await refreshUnreadCount();
    } catch (error) {
      msgEl.textContent = error.message || 'Feed 修改失败';
      confirmBtn.disabled = false;
      confirmBtn.textContent = '保存修改';
    }
  });
}

async function renameFeed(feedData) {
  // 兼容历史调用，统一走新版“修改 Feed”弹窗。
  await editFeed(feedData);
  try {
    await loadMenu();
    await loadArticles();
  } catch (error) {
    console.error('renameFeed compatibility refresh failed:', error);
  }
}

async function deleteFeed(feedData) {
  const headers = authHeaders();
  if (!headers) return;
  const ok = window.confirm(`确定删除 Feed「${feedData.title || `#${feedData.id}`}」吗？此操作不可恢复。`);
  if (!ok) return;
  try {
    const res = await fetch(`${API_BASE_URL}/feeds/${feedData.id}`, {
      method: 'DELETE',
      headers: { Authorization: headers.Authorization },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Feed 删除失败');
    if (String(activeFeedId || '') === String(feedData.id)) {
      activeGroupId = null;
      activeFeedId = ALL_FEED_ID;
      activeFeedTitle = '全部文章';
      updateCurrentFeedTitle('全部文章');
    }
    showMsg('Feed 已删除', false);
    await loadMenu();
    await loadArticles();
    await refreshUnreadCount();
  } catch (error) {
    showMsg(error.message || 'Feed 删除失败', true);
  }
}

function askDeleteGroupMode(groupName) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.style.position = 'fixed';
    mask.style.inset = '0';
    mask.style.background = 'rgba(15, 23, 42, 0.45)';
    mask.style.display = 'flex';
    mask.style.alignItems = 'center';
    mask.style.justifyContent = 'center';
    mask.style.zIndex = '10000';

    const dialog = document.createElement('div');
    dialog.style.width = 'min(520px, calc(100vw - 32px))';
    dialog.style.background = '#fff';
    dialog.style.borderRadius = '10px';
    dialog.style.padding = '18px 16px 14px';
    dialog.style.boxShadow = '0 18px 50px rgba(15, 23, 42, 0.28)';
    dialog.innerHTML = `
      <h3 style="margin:0 0 10px;font-size:16px;color:#1f3344;">删除分组确认</h3>
      <p style="margin:0 0 14px;color:#4c6072;line-height:1.6;">
        请选择“${escapeHtml(groupName || '')}”的删除方式：
      </p>
      <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
        <button type="button" data-delete-mode="cancel" style="border:1px solid #d0d7de;background:#fff;color:#1f3344;border-radius:6px;padding:6px 10px;cursor:pointer;">取消</button>
        <button type="button" data-delete-mode="keep-feeds" style="border:1px solid #0969da;background:#fff;color:#0969da;border-radius:6px;padding:6px 10px;cursor:pointer;">仅删除分组名称，保留 feeds</button>
        <button type="button" data-delete-mode="delete-all" style="border:1px solid #cf222e;background:#cf222e;color:#fff;border-radius:6px;padding:6px 10px;cursor:pointer;">删除分组和所有 feeds</button>
      </div>
    `;
    mask.appendChild(dialog);
    document.body.appendChild(mask);

    function done(mode) {
      if (mask.parentNode) {
        mask.parentNode.removeChild(mask);
      }
      resolve(mode);
    }

    mask.addEventListener('click', (event) => {
      if (event.target === mask) done('cancel');
    });

    dialog.querySelectorAll('button[data-delete-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        done(btn.getAttribute('data-delete-mode') || 'cancel');
      });
    });
  });
}

const GROUP_ICON_OPTIONS = [
  'folder',
  'folders',
  'star',
  'bookmark',
  'rss',
  'globe',
  'newspaper',
  'bell',
  'heart',
  'tag',
  'layers',
  'layout-grid',
  'book-open',
  'zap',
  'flame',
  'coffee',
  'code',
  'briefcase',
  'home',
  'inbox',
];

function groupLucideIconMarkup(iconName) {
  const name = String(iconName || 'folder').trim();
  return `<span class="nav-icon"><i data-lucide="${escapeHtml(name)}"></i></span>`;
}

async function editGroup(groupData) {
  const headers = authHeaders();
  if (!headers) return;
  const groupId = groupData?.id;
  if (!groupId) return;

  const initialName = String(groupData.name || '').trim();
  const initialIcon = String(groupData.icon || '').trim() || 'folder';
  let selectedIcon = GROUP_ICON_OPTIONS.includes(initialIcon) ? initialIcon : 'folder';

  const mask = createDialogMask();
  const dialog = document.createElement('div');
  dialog.style.width = 'min(420px, calc(100vw - 32px))';
  dialog.style.background = '#fff';
  dialog.style.borderRadius = '10px';
  dialog.style.padding = '16px';
  dialog.style.boxShadow = '0 18px 50px rgba(15, 23, 42, 0.28)';
  dialog.innerHTML = `
    <h3 style="margin:0 0 12px;font-size:16px;color:#1f3344;">修改分组</h3>
    <label style="display:block;margin:0 0 6px;color:#4c6072;font-size:13px;">组名</label>
    <input id="reader-group-edit-name" type="text" placeholder="请输入分组名称" maxlength="100" style="width:100%;height:34px;padding:0 10px;border:1px solid #d0d7de;border-radius:6px;box-sizing:border-box;">
    <label style="display:block;margin:12px 0 6px;color:#4c6072;font-size:13px;">图标</label>
    <div id="reader-group-icon-picker" class="header-group-icon-picker"></div>
    <p id="reader-group-edit-msg" style="margin:8px 0 0;min-height:18px;font-size:12px;color:#7a8794;"></p>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
      <button type="button" data-act="cancel" style="border:1px solid #d0d7de;background:#fff;color:#1f3344;border-radius:6px;padding:6px 10px;cursor:pointer;">取消</button>
      <button type="button" data-act="confirm" style="border:1px solid #0969da;background:#0969da;color:#fff;border-radius:6px;padding:6px 10px;cursor:pointer;">保存</button>
    </div>
  `;
  mask.appendChild(dialog);
  document.body.appendChild(mask);

  const nameInput = dialog.querySelector('#reader-group-edit-name');
  const pickerEl = dialog.querySelector('#reader-group-icon-picker');
  const msgEl = dialog.querySelector('#reader-group-edit-msg');
  const confirmBtn = dialog.querySelector('button[data-act="confirm"]');
  const cancelBtn = dialog.querySelector('button[data-act="cancel"]');
  if (
    !(nameInput instanceof HTMLInputElement) ||
    !(pickerEl instanceof HTMLElement) ||
    !(msgEl instanceof HTMLElement) ||
    !(confirmBtn instanceof HTMLButtonElement) ||
    !(cancelBtn instanceof HTMLButtonElement)
  ) {
    mask.remove();
    return;
  }

  function closeDialog() {
    mask.remove();
  }

  function renderIconPicker() {
    pickerEl.innerHTML = GROUP_ICON_OPTIONS.map((icon) => {
      const selected = icon === selectedIcon ? ' selected' : '';
      return `<button type="button" class="header-group-icon-option${selected}" data-icon="${escapeHtml(icon)}" title="${escapeHtml(icon)}" aria-label="${escapeHtml(icon)}">${groupLucideIconMarkup(icon)}</button>`;
    }).join('');
    if (typeof window.refreshLucideIcons === 'function') window.refreshLucideIcons();
    pickerEl.querySelectorAll('.header-group-icon-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedIcon = btn.getAttribute('data-icon') || 'folder';
        renderIconPicker();
      });
    });
  }

  nameInput.value = initialName;
  renderIconPicker();
  cancelBtn.addEventListener('click', closeDialog);
  mask.addEventListener('click', (event) => {
    if (event.target === mask) closeDialog();
  });

  confirmBtn.addEventListener('click', async () => {
    const cleanName = nameInput.value.trim();
    if (!cleanName) {
      msgEl.textContent = '分组名称不能为空';
      return;
    }
    const nameUnchanged = cleanName === initialName;
    const iconUnchanged = selectedIcon === initialIcon;
    if (nameUnchanged && iconUnchanged) {
      closeDialog();
      return;
    }
    confirmBtn.disabled = true;
    confirmBtn.textContent = '保存中...';
    msgEl.textContent = '';
    try {
      const res = await fetch(`${API_BASE_URL}/feed-subscriptions/groups/${groupId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ name: cleanName, icon: selectedIcon }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '分组修改失败');
      closeDialog();
      showMsg('分组已修改', false);
      if (String(activeGroupId) === String(groupId)) {
        activeFeedTitle = cleanName;
        updateCurrentFeedTitle(`分组：${cleanName}`);
      }
      await loadMenu();
      await loadArticles();
    } catch (error) {
      msgEl.textContent = error.message || '分组修改失败';
      confirmBtn.disabled = false;
      confirmBtn.textContent = '保存';
    }
  });

  nameInput.focus();
  nameInput.select();
}

async function deleteGroup(groupId, groupName) {
  const headers = authHeaders();
  if (!headers) return;
  const deleteHeaders = { Authorization: headers.Authorization };
  const deleteMode = await askDeleteGroupMode(groupName);
  if (deleteMode === 'cancel') return;

  const activeGroup = menuState.find((item) => String(item.id) === String(groupId));
  const targetFeeds = Array.isArray(activeGroup?.feeds) ? activeGroup.feeds : [];

  try {
    if (deleteMode === 'delete-all') {
      for (const feed of targetFeeds) {
        const feedId = Number(feed?.id);
        if (!Number.isFinite(feedId)) continue;
        const feedRes = await fetch(`${API_BASE_URL}/feeds/${feedId}`, {
          method: 'DELETE',
          headers: deleteHeaders,
        });
        const feedData = await feedRes.json().catch(() => ({}));
        if (!feedRes.ok) {
          throw new Error(feedData.error || `删除 Feed #${feedId} 失败`);
        }
      }
    }

    const groupRes = await fetch(`${API_BASE_URL}/feed-subscriptions/groups/${groupId}`, {
      method: 'DELETE',
      headers: deleteHeaders,
    });
    const groupData = await groupRes.json().catch(() => ({}));
    if (!groupRes.ok) throw new Error(groupData.error || '分组删除失败');

    if (String(activeGroupId || '') === String(groupId)) {
      activeGroupId = null;
      activeFeedId = ALL_FEED_ID;
      activeFeedTitle = '全部文章';
      updateCurrentFeedTitle('全部文章');
    }
    if (deleteMode === 'delete-all') {
      showMsg('分组及其所有 feeds（含文章）已删除', false);
    } else {
      showMsg('分组已删除，原分组 feeds 已移到未分组', false);
    }
    await loadMenu();
    await loadArticles();
  } catch (error) {
    showMsg(error.message || '分组删除失败', true);
  }
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

function compareFeedsBySortOrder(a, b) {
  const orderA = Number(a?.sortOrder ?? a?.sort_order ?? 0);
  const orderB = Number(b?.sortOrder ?? b?.sort_order ?? 0);
  const safeA = Number.isFinite(orderA) ? orderA : 0;
  const safeB = Number.isFinite(orderB) ? orderB : 0;
  if (safeA !== safeB) return safeA - safeB;
  const idA = Number(a?.id);
  const idB = Number(b?.id);
  if (Number.isFinite(idA) && Number.isFinite(idB) && idA !== idB) return idA - idB;
  return String(a?.title || '').localeCompare(String(b?.title || ''), 'zh-CN');
}

function sortFeedsInMenuOrder(feeds) {
  return [...(Array.isArray(feeds) ? feeds : [])].sort(compareFeedsBySortOrder);
}

function buildMenuState(groups, feeds, crawlByFeedId) {
  const crawlMap = crawlByFeedId instanceof Map ? crawlByFeedId : new Map();
  const groupMap = new Map();
  (groups || []).forEach((g) => {
    groupMap.set(g.id, {
      id: g.id,
      name: g.name,
      icon: String(g.icon || '').trim() || null,
      feeds: [],
      collapsed: false,
    });
  });

  const ungrouped = { id: 'ungrouped', name: '未分组', feeds: [], collapsed: false };
  (feeds || []).forEach((feed) => {
    if (!feed) return;
    const crawl = crawlMap.get(feed.id);
    const feedItem = {
      id: feed.id,
      title: feed.title || `Feed#${feed.id}`,
      articleCount: Number(feed.article_count ?? feed.articleCount ?? 0),
      url: feed.url || feed.feed_url || '',
      description: feed.description || '',
      updateInterval: feed.update_interval || 1800,
      favicon_url: feed.favicon_url || null,
      favicon_custom_text: feed.favicon_custom_text || null,
      favicon_custom_bg: feed.favicon_custom_bg || null,
      groupId: feed.group_id ?? null,
      sortOrder: Number.isFinite(Number(feed.sort_order)) ? Number(feed.sort_order) : 0,
      useProxy: feed.use_proxy === true,
      needsTranslation: feed.needs_translation === true,
      createdAt: feed.created_at || feed.createdAt || null,
      updatedAt: feed.updated_at || feed.updatedAt || feed.last_updated_at || null,
      lastStatus: crawl?.stats?.last_status || null,
      lastFailureReason: crawl?.stats?.last_failure_reason || null,
      lastFailureMessage: crawl?.stats?.last_failure_message || null,
      antiBotStatus: crawl?.anti_bot_status || 'normal',
      lastCrawlFinishedAt: crawl?.stats?.last_finished_at || null,
      lastNewArticlesCount:
        crawl?.stats?.last_new_articles_count == null
          ? null
          : Math.max(0, Number(crawl.stats.last_new_articles_count) || 0),
    };
    if (feed.group_id != null && groupMap.has(feed.group_id)) {
      groupMap.get(feed.group_id).feeds.push(feedItem);
    } else {
      ungrouped.feeds.push(feedItem);
    }
  });

  const result = Array.from(groupMap.values());
  if (ungrouped.feeds.length) result.push(ungrouped);
  return result.map((g) => ({ ...g, feeds: sortFeedsInMenuOrder(g.feeds) }));
}

function formatCrawlElapsedShort(iso) {
  if (iso == null || iso === '') return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const diffMs = Math.max(0, Date.now() - then.getTime());
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}S`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}d`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}mo`;
  const year = Math.floor(day / 365);
  return `${Math.max(1, year)}y`;
}

function buildFeedCrawlMetaTag(feed) {
  const finishedAt = feed?.lastCrawlFinishedAt;
  if (!finishedAt) return '';
  const elapsed = formatCrawlElapsedShort(finishedAt);
  if (!elapsed) return '';
  const rawCount = feed?.lastNewArticlesCount;
  const count = rawCount == null ? null : Math.max(0, Number(rawCount) || 0);
  const countText = count == null ? '—' : count > 0 ? `+${count}` : '0';
  const countClass =
    count == null ? 'is-unknown-new' : count === 0 ? 'is-zero-new' : 'has-new';
  const tipParts = [`上次爬取 ${elapsed} 前`];
  if (count != null) tipParts.push(`新增 ${count} 篇`);
  const titleAttr = ` title="${escapeHtml(tipParts.join('，'))}"`;
  return `<span class="article-reader-feed-crawl-meta"${titleAttr} data-last-finished-at="${escapeHtml(String(finishedAt))}" data-new-count="${count == null ? '' : String(count)}"><span class="article-reader-feed-crawl-elapsed">${escapeHtml(elapsed)}</span><span class="article-reader-feed-crawl-new ${countClass}">${escapeHtml(countText)}</span></span>`;
}

function refreshFeedCrawlMetaLabels() {
  document.querySelectorAll('.article-reader-feed-crawl-meta[data-last-finished-at]').forEach((el) => {
    const iso = el.getAttribute('data-last-finished-at');
    const elapsedEl = el.querySelector('.article-reader-feed-crawl-elapsed');
    if (elapsedEl) {
      const label = formatCrawlElapsedShort(iso);
      if (label) elapsedEl.textContent = label;
    }
  });
}

function ensureFeedCrawlMetaRefresh() {
  if (window.__readerCrawlMetaRefreshBound) return;
  window.__readerCrawlMetaRefreshBound = true;
  setInterval(refreshFeedCrawlMetaLabels, 15000);
}

function buildFeedCrawlFailTag(feed) {
  const anti = feed?.antiBotStatus || 'normal';
  const status = feed?.lastStatus;
  const reason = feed?.lastFailureReason || '';
  const message = feed?.lastFailureMessage || '';
  const tipText = message || (reason && reason !== '—' ? reason : '');

  let show = false;
  let label = '';
  if (anti !== 'normal') {
    show = true;
    label = reason && reason !== '—' ? reason : anti;
  } else if (status === 'failed') {
    show = true;
    label = reason && reason !== '—' ? reason : '失败';
  }
  if (!show) return '';

  const titleAttr = tipText ? ` title="${escapeHtml(tipText)}"` : '';
  return `<span class="article-reader-feed-crawl-tag"${titleAttr}>${escapeHtml(label)}</span>`;
}

function renderMenu() {
  const wrap = document.getElementById('article-reader-menu');
  syncQuickScopeButtons();
  if (!menuState.length) {
    wrap.innerHTML = '<div class="article-reader-menu-empty">暂无分组和订阅</div>';
    return;
  }

  wrap.innerHTML = menuState
    .map((group, groupIdx) => {
      const groupActiveClass = String(activeGroupId || '') === String(group.id) ? ' active' : '';
      const groupArticleCount = (group.feeds || []).reduce((sum, feed) => {
        const count = Number(feed?.articleCount ?? 0);
        return sum + (Number.isFinite(count) ? Math.max(0, count) : 0);
      }, 0);
      const feedsHtml = group.feeds
        .map((feed) => {
          const activeClass = String(feed.id) === String(activeFeedId) && !activeGroupId ? ' active' : '';
          const articleCountText = Number.isFinite(Number(feed.articleCount)) ? String(Math.max(0, Number(feed.articleCount))) : '0';
          return `<button type="button" class="article-reader-feed-btn${activeClass}" data-feed-id="${feed.id}" data-feed-title="${escapeHtml(feed.title)}" data-feed-url="${escapeHtml(feed.url || '')}" data-feed-favicon-url="${escapeHtml(feed.favicon_url || '')}" data-feed-description="${escapeHtml(feed.description || '')}" data-feed-update-interval="${escapeHtml(String(feed.updateInterval || 1800))}" data-feed-sort-order="${escapeHtml(String(feed.sortOrder ?? 0))}" data-feed-use-proxy="${feed.useProxy ? '1' : '0'}" data-feed-needs-translation="${feed.needsTranslation ? '1' : '0'}" data-feed-group-id="${escapeHtml(feed.groupId == null ? '' : String(feed.groupId))}" data-feed-group-name="${escapeHtml(group.name || '')}" data-feed-created-at="${escapeHtml(feed.createdAt || '')}" data-feed-updated-at="${escapeHtml(feed.updatedAt || '')}">
            <span class="article-reader-feed-btn-inner">
              ${buildFeedFaviconMarkup(feed)}
              <span class="article-reader-feed-btn-text">
                <span class="article-reader-feed-btn-title">${escapeHtml(feed.title)}</span>
                ${buildFeedLangTag(feed)}
                ${buildFeedCrawlMetaTag(feed)}
                ${buildFeedCrawlFailTag(feed)}
              </span>
              <span class="article-reader-feed-article-count" style="margin-left:auto;flex:0 0 auto;color:#7a8794;font-size:12px;">${escapeHtml(articleCountText)}</span>
            </span>
          </button>`;
        })
        .join('');
      const groupClass = group.collapsed ? ' collapsed' : '';
      const chevronIcon = group.collapsed ? 'chevron-right' : 'chevron-down';
      return `
        <div class="article-reader-group${groupClass}" data-group-index="${groupIdx}">
          <div class="article-reader-group-toggle">
            <button type="button" class="article-reader-group-chevron-btn" data-group-index="${groupIdx}" aria-label="${group.collapsed ? '展开分组' : '折叠分组'}" title="${group.collapsed ? '展开分组' : '折叠分组'}">
              <span class="nav-icon"><i data-lucide="${chevronIcon}"></i></span>
            </button>
            <button type="button" class="article-reader-group-name${groupActiveClass}" data-group-id="${escapeHtml(group.id)}" data-group-name="${escapeHtml(group.name)}" style="display:flex;align-items:center;gap:6px;min-width:0;">
              ${
                group.id !== 'ungrouped' && group.icon
                  ? `<span class="nav-icon" style="flex:0 0 auto;"><i data-lucide="${escapeHtml(group.icon)}"></i></span>`
                  : group.id !== 'ungrouped'
                    ? `<span class="nav-icon" style="flex:0 0 auto;"><i data-lucide="folder"></i></span>`
                    : ''
              }
              <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(group.name)}</span>
              <span class="article-reader-group-article-count" style="flex:0 0 auto;color:#7a8794;font-size:12px;">${escapeHtml(String(groupArticleCount))}</span>
            </button>
          </div>
          <div class="article-reader-group-feeds">${feedsHtml}</div>
        </div>
      `;
    })
    .join('');

  if (typeof window.refreshLucideIcons === 'function') window.refreshLucideIcons();

  wrap.querySelectorAll('.article-reader-group-chevron-btn').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      const idx = parseInt(el.getAttribute('data-group-index'), 10);
      if (!Number.isFinite(idx) || !menuState[idx]) return;
      menuState[idx].collapsed = !menuState[idx].collapsed;
      saveGroupCollapsedState();
      renderMenu();
    });
  });

  wrap.querySelectorAll('.article-reader-group-name').forEach((el) => {
    el.addEventListener('click', () => {
      const groupId = el.getAttribute('data-group-id');
      const groupName = el.getAttribute('data-group-name') || '';
      if (!groupId) return;
      resetArticleListPage();
      activeScope = 'all';
      activeTagId = null;
      activeCategoryId = null;
      activeUnreadOnly = false;
      activeGroupId = groupId;
      activeFeedId = null;
      activeFeedTitle = groupName;
      updateCurrentFeedTitle(`分组：${groupName}`);
      syncTagFilterChrome();
      saveSidebarSelection();
      renderMenu();
      loadArticles();
    });

    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const groupId = el.getAttribute('data-group-id');
      const groupName = el.getAttribute('data-group-name') || '';
      // 未分组为前端虚拟分组，不提供改名/删除
      if (!groupId || groupId === 'ungrouped') return;
      const groupItem = menuState.find((g) => String(g?.id) === String(groupId));
      const groupIcon = groupItem?.icon || 'folder';
      openGroupContextMenu(event.clientX, event.clientY, groupId, groupName, groupIcon);
    });
  });

  wrap.querySelectorAll('.article-reader-feed-btn').forEach((el) => {
    el.addEventListener('click', () => {
      const id = parseInt(el.getAttribute('data-feed-id'), 10);
      if (!Number.isFinite(id)) return;
      resetArticleListPage();
      activeScope = 'all';
      activeTagId = null;
      activeCategoryId = null;
      activeUnreadOnly = false;
      activeFeedId = id;
      activeGroupId = null;
      activeFeedTitle = el.getAttribute('data-feed-title') || '';
      updateCurrentFeedTitle(activeFeedTitle || `Feed #${activeFeedId}`);
      syncTagFilterChrome();
      saveSidebarSelection();
      renderMenu();
      loadArticles();
    });

    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const id = parseInt(el.getAttribute('data-feed-id'), 10);
      if (!Number.isFinite(id)) return;
      openFeedContextMenu(event.clientX, event.clientY, {
        id,
        title: el.getAttribute('data-feed-title') || '',
        url: el.getAttribute('data-feed-url') || '',
        favicon_url: el.getAttribute('data-feed-favicon-url') || '',
        description: el.getAttribute('data-feed-description') || '',
        updateInterval: Number(el.getAttribute('data-feed-update-interval') || 1800),
        sortOrder: Number(el.getAttribute('data-feed-sort-order') || 0),
        useProxy: el.getAttribute('data-feed-use-proxy') === '1',
        needsTranslation: el.getAttribute('data-feed-needs-translation') === '1',
        groupId: el.getAttribute('data-feed-group-id') || null,
        groupName: el.getAttribute('data-feed-group-name') || '未分组',
        createdAt: el.getAttribute('data-feed-created-at') || null,
        updatedAt: el.getAttribute('data-feed-updated-at') || null,
      });
    });
  });

  renderSidebarTags();
}

async function loadMenu() {
  const headers = authHeaders();
  if (!headers) { redirectToLogin(); return; }
  const [subRes, crawlRes] = await Promise.all([
    fetch(`${API_BASE_URL}/feed-subscriptions`, { headers }),
    fetch(`${API_BASE_URL}/crawler-strategies`, { headers }).catch(() => null),
  ]);
  if (subRes.status === 401) { redirectToLogin(); return; }
  const data = await subRes.json();
  if (!subRes.ok) throw new Error(data.error || '加载分组菜单失败');

  const crawlByFeedId = new Map();
  if (crawlRes && crawlRes.ok) {
    const crawlData = await crawlRes.json().catch(() => ({}));
    (crawlData.items || []).forEach((item) => {
      if (item && item.id != null) crawlByFeedId.set(item.id, item);
    });
  }

  menuState = buildMenuState(data.groups || [], data.feeds || [], crawlByFeedId);
  applyGroupCollapsedFromStorage();
  const activeGroupExists =
    activeGroupId != null && menuState.some((group) => String(group?.id) === String(activeGroupId));
  const activeFeedExists =
    activeFeedId === ALL_FEED_ID ||
    (activeFeedId != null &&
      menuState.some((group) => Array.isArray(group?.feeds) && group.feeds.some((feed) => String(feed?.id) === String(activeFeedId))));
  if (activeGroupId && !activeGroupExists) {
    setSelectionToAllAndPersist();
  } else if (activeFeedId && !activeFeedExists) {
    setSelectionToAllAndPersist();
  } else if (!activeFeedId && !activeGroupId) {
    setSelectionToAllAndPersist();
  } else {
    if (activeGroupId) {
      const group = menuState.find((item) => String(item?.id) === String(activeGroupId));
      updateCurrentFeedTitle(group ? `分组：${group.name}` : '全部文章');
    } else if (activeScope === 'category' && activeCategoryId != null) {
      const cat = getActiveCategoryMeta();
      updateCurrentFeedTitle(`主题：${cat?.name || activeCategoryId}`);
    } else if (activeScope === 'tag' && activeTagId != null) {
      const tag = getActiveTagMeta();
      updateCurrentFeedTitle(`标签：${tag?.name || activeTagId}`);
    } else if (activeFeedId === ALL_FEED_ID) {
      updateCurrentFeedTitle(activeScope === 'today' ? (activeUnreadOnly ? '今日未读' : '今天文章') : activeScope === 'liked' ? '喜欢的文章' : '全部文章');
    } else {
      const feed = resolveFeedById(activeFeedId);
      updateCurrentFeedTitle(feed?.title || activeFeedTitle || `Feed #${activeFeedId}`);
    }
  }
  renderMenu();
  ensureFeedCrawlMetaRefresh();
  await refreshUnreadCount();
  await Promise.all([loadSidebarCategories(), loadSidebarTags()]);
  syncTagFilterChrome();
}

function readStoredArticlePageSize() {
  try {
    const raw = localStorage.getItem(ARTICLE_READER_PAGE_SIZE_KEY);
    const n = Number(raw);
    if ([10, 20, 30, 50, 100].includes(n)) return n;
  } catch (error) {
    console.error('readStoredArticlePageSize failed:', error);
  }
  return 20;
}

function resetArticleListPage() {
  articleListPage = 1;
}

function articleSearchKeyword() {
  const el = document.getElementById('reader-search-input');
  const raw = el && 'value' in el ? String(el.value || '').trim().toLowerCase() : '';
  return raw;
}

function filterArticlesByKeyword(articles, keyword) {
  if (!keyword) return Array.isArray(articles) ? articles : [];
  const list = Array.isArray(articles) ? articles : [];
  return list.filter((a) => {
    const blob = [
      a.title,
      a.description,
      a.content,
      a.author,
      a.feed_title,
      String(a.url || ''),
    ]
      .map((x) => String(x || '').toLowerCase())
      .join('\n');
    return blob.indexOf(keyword) !== -1;
  });
}

/** 根据当前左侧选中状态设置文章接口的 feed / 分组参数（不含分页与 scope） */
function applyArticleScopeQueryParams(params) {
  const isGroupMode = !!activeGroupId;
  if (isGroupMode) {
    if (String(activeGroupId) === 'ungrouped') {
      params.set('ungrouped', '1');
    } else {
      const gid = Number(activeGroupId);
      if (Number.isFinite(gid)) params.set('groupId', String(gid));
    }
  } else if (activeFeedId != null && activeFeedId !== ALL_FEED_ID) {
    params.set('feedId', String(activeFeedId));
  }
  // categoryId 与 tagId、scope=liked 互斥：有 categoryId 时按 AI 类别筛选
  if (activeScope === 'category' && activeCategoryId != null && Number.isFinite(Number(activeCategoryId))) {
    params.set('categoryId', String(activeCategoryId));
    params.set('scope', 'all');
  } else if (activeScope === 'tag' && activeTagId != null && Number.isFinite(Number(activeTagId))) {
    // tagId 与 scope=liked 互斥：有 tagId 时按标签筛选，忽略 scope=liked
    params.set('tagId', String(activeTagId));
    params.set('scope', 'all');
  } else {
    params.set('scope', activeScope === 'tag' || activeScope === 'category' ? 'all' : activeScope || 'all');
  }
  if (activeUnreadOnly) params.set('unread', '1');
}

function getPaginationWindow(current, totalPages) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const pageSet = new Set([1, totalPages, current, current - 1, current + 1, current - 2, current + 2]);
  const sorted = [...pageSet].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) out.push(null);
    out.push(p);
    prev = p;
  }
  return out;
}

function renderArticlePaginationBar(total, page, pageSize, opts) {
  const nav = document.getElementById('article-reader-pagination');
  if (!nav) return;
  const searchMode = !!(opts && opts.searchMode);
  if (total <= 0) {
    nav.classList.add('hidden');
    nav.innerHTML = '';
    return;
  }
  nav.classList.remove('hidden');
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const windowItems = getPaginationWindow(safePage, totalPages);
  const sizeOptions = [10, 20, 30, 50, 100]
    .map((n) => `<option value="${n}"${n === pageSize ? ' selected' : ''}>${n}</option>`)
    .join('');
  const pageButtons = windowItems
    .map((p) => {
      if (p === null) return '<span class="article-reader-page-ellipsis" aria-hidden="true">…</span>';
      const active = p === safePage ? ' is-active' : '';
      return `<button type="button" class="article-reader-page-btn${active}" data-article-page="${p}">${p}</button>`;
    })
    .join('');
  const startIdx = (safePage - 1) * pageSize + 1;
  const endIdx = Math.min(total, safePage * pageSize);
  const searchHint = searchMode ? ' · 全库搜索' : '';
  nav.innerHTML = `
    <div class="article-reader-pagination-meta">
      <div class="article-reader-pagination-size">
        <span class="article-reader-pagination-size-label">每页</span>
        <select id="reader-page-size-select" aria-label="每页条数">${sizeOptions}</select>
        <span class="article-reader-pagination-size-label">条</span>
      </div>
      <div class="article-reader-pagination-info">共 ${total} 条，第 ${startIdx}–${endIdx} 条${searchHint}</div>
      <div class="article-reader-pagination-mobile-info">${safePage}/${totalPages} 页</div>
    </div>
    <div class="article-reader-pagination-float">
      <button type="button" class="article-reader-pagination-drag-handle" data-article-pagination-drag-handle="1" aria-label="拖动分页按钮" title="拖动分页按钮">
        <span class="article-reader-pagination-drag-handle-icon"><i data-lucide="grip-vertical"></i></span>
      </button>
      <div class="article-reader-pagination-pages">
        <button type="button" class="article-reader-page-btn article-reader-page-btn-nav" data-article-page-nav="prev" aria-label="上一页" title="上一页" ${safePage <= 1 ? ' disabled' : ''}><span class="article-reader-page-btn-icon"><i data-lucide="arrow-big-left"></i></span><span class="article-reader-page-btn-text">上一页</span></button>
        <button type="button" class="article-reader-page-btn article-reader-page-btn-nav article-reader-page-btn-mobile-indicator" data-article-page-panel-toggle="1" aria-label="分页设置，当前第 ${safePage} 页，共 ${totalPages} 页" title="分页设置">${safePage}/${totalPages}</button>
        <div id="article-reader-mobile-page-panel" class="article-reader-mobile-page-panel hidden">
          <label class="article-reader-mobile-page-field">
            <span>每页条数</span>
            <select id="reader-page-size-select-mobile" aria-label="每页条数">${sizeOptions}</select>
          </label>
          <label class="article-reader-mobile-page-field">
            <span>跳转页码</span>
            <div class="article-reader-mobile-page-jump">
              <input id="reader-page-jump-input-mobile" type="number" min="1" max="${totalPages}" value="${safePage}" inputmode="numeric" aria-label="跳转页码">
              <button type="button" class="article-reader-mobile-page-jump-btn" data-article-page-jump="1">跳转</button>
            </div>
          </label>
        </div>
        <button type="button" class="article-reader-page-btn article-reader-page-btn-nav" data-article-page-nav="next" aria-label="下一页" title="下一页" ${safePage >= totalPages ? ' disabled' : ''}><span class="article-reader-page-btn-icon"><i data-lucide="arrow-big-right"></i></span><span class="article-reader-page-btn-text">下一页</span></button>
        <span class="article-reader-page-numbers-desktop">${pageButtons}</span>
      </div>
    </div>
  `;
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
  applyMobilePaginationPosition(nav);
}

function isMobilePaginationViewport() {
  return window.matchMedia('(max-width: 896px)').matches;
}

function getPaginationSafeInsets() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);visibility:hidden;pointer-events:none;';
  document.body.appendChild(probe);
  const style = window.getComputedStyle(probe);
  const top = Number.parseFloat(style.paddingTop) || 0;
  const right = Number.parseFloat(style.paddingRight) || 0;
  const bottom = Number.parseFloat(style.paddingBottom) || 0;
  const left = Number.parseFloat(style.paddingLeft) || 0;
  document.body.removeChild(probe);
  return { top, right, bottom, left };
}

function loadMobilePaginationPosition() {
  try {
    const raw = localStorage.getItem(ARTICLE_READER_PAGINATION_POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const xPct = Number(parsed && parsed.xPct);
    const yPct = Number(parsed && parsed.yPct);
    if (!Number.isFinite(xPct) || !Number.isFinite(yPct)) return null;
    return {
      xPct: Math.min(100, Math.max(0, xPct)),
      yPct: Math.min(100, Math.max(0, yPct)),
    };
  } catch (error) {
    console.error('load pagination position failed:', error);
    return null;
  }
}

function saveMobilePaginationPosition(nav) {
  if (!nav || !isMobilePaginationViewport()) return;
  const rect = nav.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const vw = window.innerWidth || document.documentElement.clientWidth || 1;
  const vh = window.innerHeight || document.documentElement.clientHeight || 1;
  const payload = {
    xPct: (rect.left / vw) * 100,
    yPct: (rect.top / vh) * 100,
  };
  try {
    localStorage.setItem(ARTICLE_READER_PAGINATION_POS_KEY, JSON.stringify(payload));
  } catch (error) {
    console.error('save pagination position failed:', error);
  }
}

function clampMobilePaginationPosition(left, top, nav) {
  const rect = nav.getBoundingClientRect();
  const width = rect.width || nav.offsetWidth || 0;
  const height = rect.height || nav.offsetHeight || 0;
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const inset = getPaginationSafeInsets();
  const minLeft = inset.left + 8;
  const minTop = inset.top + 8;
  const maxLeft = Math.max(minLeft, vw - width - inset.right - 8);
  const maxTop = Math.max(minTop, vh - height - inset.bottom - 8);
  return {
    left: Math.min(maxLeft, Math.max(minLeft, left)),
    top: Math.min(maxTop, Math.max(minTop, top)),
  };
}

function applyMobilePaginationPosition(nav) {
  if (!nav) return;
  if (!isMobilePaginationViewport()) {
    nav.classList.remove('is-user-positioned', 'is-dragging');
    nav.style.left = '';
    nav.style.top = '';
    return;
  }
  const saved = loadMobilePaginationPosition();
  if (!saved) {
    nav.classList.remove('is-user-positioned');
    nav.style.left = '';
    nav.style.top = '';
    return;
  }
  const vw = window.innerWidth || document.documentElement.clientWidth || 1;
  const vh = window.innerHeight || document.documentElement.clientHeight || 1;
  const targetLeft = (saved.xPct / 100) * vw;
  const targetTop = (saved.yPct / 100) * vh;
  nav.classList.add('is-user-positioned');
  const clamped = clampMobilePaginationPosition(targetLeft, targetTop, nav);
  nav.style.left = `${clamped.left}px`;
  nav.style.top = `${clamped.top}px`;
}

let mobilePaginationDragBound = false;
let mobilePaginationResizeBound = false;
function ensureMobilePaginationDrag() {
  const nav = document.getElementById('article-reader-pagination');
  if (!nav) return;

  if (!mobilePaginationResizeBound) {
    mobilePaginationResizeBound = true;
    window.addEventListener('resize', () => {
      applyMobilePaginationPosition(nav);
    });
  }

  if (mobilePaginationDragBound) return;
  mobilePaginationDragBound = true;

  let dragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let activePointerId = null;

  function finishDrag(pointerId) {
    if (!dragging) return;
    dragging = false;
    nav.classList.remove('is-dragging');
    if (Number.isFinite(pointerId)) {
      try {
        nav.releasePointerCapture(pointerId);
      } catch (error) {
        /* ignore */
      }
    }
    activePointerId = null;
    saveMobilePaginationPosition(nav);
  }

  nav.addEventListener('pointerdown', (event) => {
    if (!isMobilePaginationViewport()) return;
    const handle = event.target instanceof HTMLElement ? event.target.closest('[data-article-pagination-drag-handle]') : null;
    if (!handle) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = nav.getBoundingClientRect();
    dragging = true;
    activePointerId = event.pointerId;
    dragOffsetX = event.clientX - rect.left;
    dragOffsetY = event.clientY - rect.top;
    nav.classList.add('is-user-positioned', 'is-dragging');
    nav.style.right = 'auto';
    nav.style.bottom = 'auto';
    const clamped = clampMobilePaginationPosition(rect.left, rect.top, nav);
    nav.style.left = `${clamped.left}px`;
    nav.style.top = `${clamped.top}px`;
    try {
      nav.setPointerCapture(event.pointerId);
    } catch (error) {
      /* ignore */
    }
  });

  nav.addEventListener('pointermove', (event) => {
    if (!dragging || event.pointerId !== activePointerId) return;
    event.preventDefault();
    const nextLeft = event.clientX - dragOffsetX;
    const nextTop = event.clientY - dragOffsetY;
    const clamped = clampMobilePaginationPosition(nextLeft, nextTop, nav);
    nav.style.left = `${clamped.left}px`;
    nav.style.top = `${clamped.top}px`;
  });

  nav.addEventListener('pointerup', (event) => {
    if (event.pointerId !== activePointerId) return;
    finishDrag(event.pointerId);
  });

  nav.addEventListener('pointercancel', (event) => {
    if (event.pointerId !== activePointerId) return;
    finishDrag(event.pointerId);
  });
}

let articleReaderPaginationBound = false;
function ensureArticleReaderPaginationEvents() {
  const nav = document.getElementById('article-reader-pagination');
  if (!nav) return;
  ensureMobilePaginationDrag();
  if (articleReaderPaginationBound) return;
  articleReaderPaginationBound = true;
  nav.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    if (target.id !== 'reader-page-size-select' && target.id !== 'reader-page-size-select-mobile') return;
    const n = Number(target.value);
    if (![10, 20, 30, 50, 100].includes(n)) return;
    articlePageSize = n;
    articleListPage = 1;
    try {
      localStorage.setItem(ARTICLE_READER_PAGE_SIZE_KEY, String(n));
    } catch (error) {
      console.error('persist page size failed:', error);
    }
    loadArticles();
  });
  nav.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const pageAttr = target.getAttribute('data-article-page');
    if (pageAttr) {
      const p = Number(pageAttr);
      if (!Number.isFinite(p)) return;
      articleListPage = p;
      loadArticles();
      return;
    }
    if (target.closest('[data-article-page-panel-toggle]')) {
      const panel = document.getElementById('article-reader-mobile-page-panel');
      if (panel) panel.classList.toggle('hidden');
      return;
    }
    if (target.closest('[data-article-page-jump]')) {
      const input = document.getElementById('reader-page-jump-input-mobile');
      const max = input instanceof HTMLInputElement ? Number(input.max) : 1;
      const value = input instanceof HTMLInputElement ? Number(input.value) : NaN;
      if (!Number.isFinite(value)) return;
      articleListPage = Math.min(Math.max(1, Math.trunc(value)), Number.isFinite(max) && max > 0 ? max : 1);
      loadArticles();
      return;
    }
    const navAttr = target.getAttribute('data-article-page-nav');
    if (navAttr === 'prev') {
      if (articleListPage > 1) {
        articleListPage -= 1;
        loadArticles();
      }
    } else if (navAttr === 'next') {
      articleListPage += 1;
      loadArticles();
    }
  });
}

function getArticleSortTime(article) {
  const pubTime = article?.pub_date ? new Date(article.pub_date).getTime() : NaN;
  if (Number.isFinite(pubTime)) return pubTime;
  const createdTime = article?.created_at ? new Date(article.created_at).getTime() : NaN;
  if (Number.isFinite(createdTime)) return createdTime;
  return 0;
}

function sortArticlesByPublishTimeDesc(articles) {
  return [...(Array.isArray(articles) ? articles : [])].sort((a, b) => {
    const diff = getArticleSortTime(b) - getArticleSortTime(a);
    if (diff !== 0) return diff;
    return String(b?.id || '').localeCompare(String(a?.id || ''));
  });
}

function renderArticles(articles, options = {}) {
  if (bulletinActive) return;
  const preserveSelection = !!options.preserveSelection;
  const prevActiveArticleId = options.prevActiveArticleId;
  const list = document.getElementById('article-reader-list');
  const empty = document.getElementById('article-reader-empty');
  const detail = document.getElementById('article-reader-detail');
  const sortedArticles = sortArticlesByPublishTimeDesc(articles);
  currentArticles = sortedArticles;
  if (!sortedArticles.length) {
    list.classList.add('hidden');
    list.innerHTML = '';
    empty.classList.remove('hidden');
    activeArticleIndex = -1;
    if (detail) detail.style.display = 'none';
    return;
  }

  empty.classList.add('hidden');
  list.classList.remove('hidden');
  if (detail) detail.style.display = '';
  list.innerHTML = sortedArticles
    .map((a, idx) => {
      const readClass = a.is_read ? ' is-read' : '';
      const pubDate = a.pub_date ? new Date(a.pub_date).toLocaleString() : '未知时间';
      const desc = getArticleDisplayDescription(a);
      const descText = stripHtmlTags(desc);
      const shortDesc = descText.length > 220 ? `${descText.slice(0, 220)}...` : descText;
      const hasInlineSummary = !!shortDesc.trim();
      const summaryTooltip = clipTextForTooltip(descText, 8000);
      const rawTitle = getArticleDisplayTitle(a);
      const titleTooltip = clipTextForTooltip(rawTitle, 2000);
      const inlineSummaryHtml = hasInlineSummary
        ? `<span class="article-reader-item-inline-summary" data-full-summary="${escapeHtml(summaryTooltip)}">${escapeHtml(shortDesc)}</span>`
        : '';
      const titleStackClass = `article-reader-item-title-stack${hasInlineSummary ? '' : ' article-reader-item-title-stack--no-summary'}`;
      const timeValue = a.created_at || a.createdAt || a.created_time || a.pub_date;
      const addedTime = formatFriendlyAddedTime(timeValue);
      const shortTime = formatShortAddedTime(timeValue);
      const linkHtml = a.url
        ? `<a class="article-reader-link" href="${escapeHtml(a.url)}" target="_blank" rel="noopener">阅读全文</a>`
        : '<span class="article-reader-link article-reader-link--muted">无原文链接</span>';
      const likedClass = a.is_liked ? ' active' : '';
      const likedText = a.is_liked ? '★' : '☆';
      const feedData = resolveFeedById(a.feed_id ?? a.feedId ?? a.subscription_feed_id);
      const faviconHtml = buildFeedFaviconMarkup({
        title: a.feed_title || 'F',
        url: feedData?.url || '',
        favicon_url: feedData?.favicon_url || null,
        favicon_custom_text: feedData?.favicon_custom_text || null,
        favicon_custom_bg: feedData?.favicon_custom_bg || null,
      });
      const listTagsHtml = buildArticleListTagsHtml(a.tags, a.ai_category);
      return `
        <article class="article-reader-item${readClass}" data-article-index="${idx}">
          <div class="article-reader-item-title-row">
            ${faviconHtml}
            <div class="${titleStackClass}">
              <h3 class="article-reader-item-title" title="${escapeHtml(titleTooltip)}">${escapeHtml(rawTitle)}</h3>
              ${listTagsHtml}
              ${inlineSummaryHtml}
            </div>
            <div class="article-reader-item-title-row-trail">
              <span class="article-reader-item-time"><span class="article-reader-item-time-full">${escapeHtml(addedTime)}</span><span class="article-reader-item-time-short">${escapeHtml(shortTime)}</span></span>
              <button type="button" class="article-reader-like-btn-inline${likedClass}" data-article-like-toggle="${idx}" aria-label="${a.is_liked ? '取消喜欢' : '标记喜欢'}">${likedText}</button>
              <button type="button" class="article-reader-like-btn-inline article-reader-item-action-btn" data-article-action-menu="${idx}" aria-label="更多操作" title="更多操作">
                <i data-lucide="ellipsis-vertical"></i>
              </button>
            </div>
          </div>
          <div class="article-reader-item-meta">
            <span>Feed：${escapeHtml(a.feed_title || '')}</span>
            <span>发布时间：${escapeHtml(pubDate)}</span>
            <span>作者：${escapeHtml(a.author || '未知')}</span>
          </div>
          <p class="article-reader-item-desc">${escapeHtml(shortDesc)}</p>
          ${linkHtml}
        </article>
      `;
    })
    .join('');

  bindArticleItemEvents();
  initFeedFaviconTooltip();
  initArticleSummaryTipDelegation();
  if (typeof window.refreshLucideIcons === 'function') window.refreshLucideIcons();
  if (isColumnsLayout()) {
    if (preserveSelection && prevActiveArticleId != null) {
      const idx = sortedArticles.findIndex((a) => String(a?.id) === String(prevActiveArticleId));
      selectArticleByIndex(idx >= 0 ? idx : 0);
    } else {
      selectArticleByIndex(0);
    }
  } else if (preserveSelection && prevActiveArticleId != null) {
    const idx = sortedArticles.findIndex((a) => String(a?.id) === String(prevActiveArticleId));
    activeArticleIndex = idx >= 0 ? idx : -1;
    if (list && activeArticleIndex >= 0) {
      list.querySelectorAll('.article-reader-item').forEach((item) => {
        const itemIndex = parseInt(item.getAttribute('data-article-index'), 10);
        item.classList.toggle('active', itemIndex === activeArticleIndex);
      });
    }
    updateDetailPane(activeArticleIndex >= 0 ? currentArticles[activeArticleIndex] : null);
  } else {
    activeArticleIndex = -1;
    updateDetailPane(null);
  }
}

function isColumnsLayout() {
  const content = document.querySelector('.article-reader-content');
  return !!content && (content.classList.contains('is-columns-layout') || content.classList.contains('is-columns-iframe-layout'));
}

function isColumnsIframeLayout() {
  const content = document.querySelector('.article-reader-content');
  return !!content && content.classList.contains('is-columns-iframe-layout');
}

function isTitleOnlyLayout() {
  const list = document.getElementById('article-reader-list');
  return !!list && list.classList.contains('layout-title-only');
}

function updateDetailPane(article) {
  const detailTitle = document.getElementById('article-reader-detail-title');
  const detailDesc = document.getElementById('article-reader-detail-desc');
  const detailLink = document.getElementById('article-reader-detail-link');
  const detailFrameWrap = document.getElementById('article-reader-detail-frame-wrap');
  const detailFrame = document.getElementById('article-reader-detail-frame');
  if (!detailTitle || !detailDesc || !detailLink || !detailFrameWrap || !detailFrame) return;

  if (!article) {
    detailTitle.textContent = '文章详情';
    detailDesc.textContent = '请选择左侧文章查看详情，默认展示 description 内容。';
    detailLink.classList.add('hidden');
    detailFrameWrap.classList.add('hidden');
    detailFrame.removeAttribute('src');
    return;
  }

  const rawDesc = getArticleDisplayDescription(article);
  const safeHtml = sanitizeArticleHtml(rawDesc);
  detailTitle.textContent = getArticleDisplayTitle(article);
  detailDesc.innerHTML = safeHtml || '暂无 description 内容。';
  if (isColumnsIframeLayout()) {
    detailDesc.classList.add('hidden');
    detailTitle.classList.add('hidden');
    detailLink.classList.add('hidden');
  } else {
    detailDesc.classList.remove('hidden');
    detailTitle.classList.remove('hidden');
  }

  if (article.url) {
    detailLink.href = article.url;
    if (!isColumnsIframeLayout()) {
      detailLink.classList.remove('hidden');
    }
    detailFrame.src = article.url;
    detailFrameWrap.classList.remove('hidden');
  } else {
    detailLink.classList.add('hidden');
    detailFrameWrap.classList.add('hidden');
    detailFrame.removeAttribute('src');
  }

}

function selectArticleByIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index >= currentArticles.length) return;
  activeArticleIndex = index;
  const list = document.getElementById('article-reader-list');
  if (list) {
    list.querySelectorAll('.article-reader-item').forEach((item) => {
      const itemIndex = parseInt(item.getAttribute('data-article-index'), 10);
      item.classList.toggle('active', itemIndex === activeArticleIndex);
    });
  }
  updateDetailPane(currentArticles[activeArticleIndex]);
}

function bindArticleItemEvents() {
  const list = document.getElementById('article-reader-list');
  if (!list) return;
  list.querySelectorAll('.article-reader-link').forEach((linkEl) => {
    linkEl.addEventListener('click', (event) => {
      event.stopPropagation();
    });
  });
  list.querySelectorAll('[data-tag-filter-id]').forEach((chip) => {
    chip.addEventListener('click', async (event) => {
      event.stopPropagation();
      event.preventDefault();
      const tagId = Number(chip.getAttribute('data-tag-filter-id'));
      const tagName = chip.getAttribute('data-tag-name') || '';
      if (!Number.isFinite(tagId)) return;
      await selectTagFilter(tagId, tagName);
    });
  });
  list.querySelectorAll('[data-category-filter-id]').forEach((chip) => {
    chip.addEventListener('click', async (event) => {
      event.stopPropagation();
      event.preventDefault();
      const categoryId = Number(chip.getAttribute('data-category-filter-id'));
      const categoryName = chip.getAttribute('data-category-name') || '';
      if (!Number.isFinite(categoryId)) return;
      await selectCategoryFilter(categoryId, categoryName);
    });
  });
  list.querySelectorAll('.article-reader-like-btn-inline').forEach((likeBtn) => {
    if (likeBtn.hasAttribute('data-article-action-menu')) return;
    likeBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const idx = parseInt(likeBtn.getAttribute('data-article-like-toggle'), 10);
      if (!Number.isFinite(idx) || !currentArticles[idx]) return;
      const article = currentArticles[idx];
      const articleId = Number(article.id);
      if (!Number.isFinite(articleId)) return;
      const nextLiked = !article.is_liked;
      const ok = await toggleArticleLike(articleId, nextLiked);
      if (!ok) return;
      article.is_liked = nextLiked;
      if (activeScope === 'liked' && !nextLiked) {
        await loadArticles();
        await refreshQuickScopeCounts();
        return;
      }
      likeBtn.classList.toggle('active', nextLiked);
      likeBtn.textContent = nextLiked ? '★' : '☆';
      likeBtn.setAttribute('aria-label', nextLiked ? '取消喜欢' : '标记喜欢');
      await refreshQuickScopeCounts();
    });
  });
  list.querySelectorAll('[data-article-action-menu]').forEach((actionBtn) => {
    actionBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const idx = parseInt(actionBtn.getAttribute('data-article-action-menu'), 10);
      if (!Number.isFinite(idx)) return;
      if (articleActionMenuState.index === idx) {
        closeArticleActionMenu();
        return;
      }
      openArticleActionMenu(actionBtn, idx);
    });
  });
  list.querySelectorAll('.article-reader-item').forEach((item) => {
    item.addEventListener('click', (event) => {
      const idx = parseInt(item.getAttribute('data-article-index'), 10);
      if (!Number.isFinite(idx)) return;
      const article = currentArticles[idx];
      const articleId = article ? Number(article.id) : NaN;

      if (article && Number.isFinite(articleId)) {
        markArticleReadLocalByIndex(idx);
        markArticleAsRead(articleId);
      }
      if (isTitleOnlyLayout()) {
        item.classList.toggle('is-title-expanded');
        return;
      }
      if (isColumnsLayout()) {
        selectArticleByIndex(idx);
      } else {
        activeArticleIndex = idx;
      }
    });
  });
}

async function loadArticles(options = {}) {
  if (bulletinActive) return;
  const silent = !!options.silent;
  const headers = authHeaders();
  const authMsg = document.getElementById('article-reader-auth-msg');
  const loading = document.getElementById('article-reader-loading');
  const readingLayout = document.querySelector('.article-reader-reading-layout');
  const list = document.getElementById('article-reader-list');
  const prevScrollTop = silent ? (readingLayout?.scrollTop || list?.scrollTop || 0) : 0;
  const prevActiveArticleId =
    silent && activeArticleIndex >= 0 && currentArticles[activeArticleIndex]
      ? currentArticles[activeArticleIndex].id
      : null;
  if (!headers) { redirectToLogin(); return; }
  authMsg.classList.add('hidden');
  const topLevel = loadArticlesDepth === 0;
  if (topLevel && !silent) loading.classList.remove('hidden');
  if (!silent) showMsg('');
  loadArticlesDepth += 1;

  try {
    if (!activeFeedId && !activeGroupId) {
      articleTotalCount = 0;
      renderArticles([]);
      const nav = document.getElementById('article-reader-pagination');
      if (nav) {
        nav.classList.add('hidden');
        nav.innerHTML = '';
      }
      return;
    }

    const keyword = articleSearchKeyword();
    const searchMode = !!keyword;

    let attempt = 0;
    while (attempt < 4) {
      attempt += 1;
      const params = new URLSearchParams();
      if (searchMode) {
        // 搜索时忽略今天/标签/类别等筛选，在当前 Feed/分组范围内全库匹配
        const isGroupMode = !!activeGroupId;
        if (isGroupMode) {
          if (String(activeGroupId) === 'ungrouped') {
            params.set('ungrouped', '1');
          } else {
            const gid = Number(activeGroupId);
            if (Number.isFinite(gid)) params.set('groupId', String(gid));
          }
        } else if (activeFeedId != null && activeFeedId !== ALL_FEED_ID) {
          params.set('feedId', String(activeFeedId));
        }
        params.set('scope', 'all');
        params.set('q', keyword);
      } else {
        applyArticleScopeQueryParams(params);
      }
      params.set('limit', String(articlePageSize));
      params.set('offset', String((articleListPage - 1) * articlePageSize));

      const res = await fetch(`${API_BASE_URL}/feed-subscriptions/articles?${params.toString()}`, { headers });
      if (res.status === 401) { redirectToLogin(); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '加载文章失败');

      let articles = Array.isArray(data.articles) ? data.articles : [];
      let total = Number(data.total);
      if (!Number.isFinite(total)) total = articles.length;

      if (!searchMode && total > 0) {
        const totalPages = Math.max(1, Math.ceil(total / articlePageSize));
        if (articleListPage > totalPages) {
          articleListPage = totalPages;
          continue;
        }
      }

      articleTotalCount = total;
      renderArticles(articles, {
        preserveSelection: silent,
        prevActiveArticleId,
      });
      renderArticlePaginationBar(total, articleListPage, articlePageSize, { searchMode });
      ensureArticleReaderPaginationEvents();
      if (silent) {
        if (readingLayout) readingLayout.scrollTop = prevScrollTop;
        else if (list) list.scrollTop = prevScrollTop;
      }
      break;
    }
  } catch (error) {
    if (!silent) showMsg(error.message || '加载文章失败', true);
    articleTotalCount = 0;
    const nav = document.getElementById('article-reader-pagination');
    if (nav) {
      nav.classList.add('hidden');
      nav.innerHTML = '';
    }
  } finally {
    loadArticlesDepth -= 1;
    if (loadArticlesDepth === 0) loading.classList.add('hidden');
  }
}

window.articleReaderOnSearchInput = () => {
  resetArticleListPage();
  loadArticles();
};

// ========== 语音朗读 ==========
var voiceAudioCtx = null;
var voicePlaying = false;
var voiceAbortCtrl = null;
var voiceAudioEl = null;
var voiceAudioObjectUrl = null;
var voicePaused = false;
var voiceOverlayEl = null;
var voiceSeekDragging = false;
var voiceAwaitingUserPlay = false;
var VOICE_SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

function formatVoiceTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  var m = Math.floor(seconds / 60);
  var s = Math.floor(seconds % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function updateVoiceSeekBar() {
  if (!voiceAudioEl || !voiceOverlayEl || voiceOverlayEl.style.display === 'none') return;
  var seekBar = document.getElementById('voice-reader-seek-bar');
  if (!seekBar) return;
  var dur = voiceAudioEl.duration;
  var cur = voiceAudioEl.currentTime;
  if (!Number.isFinite(dur) || dur <= 0) return;
  if (!voiceSeekDragging) {
    seekBar.max = dur;
    seekBar.value = cur;
  }
  var curLabel = document.getElementById('voice-reader-time-current');
  var durLabel = document.getElementById('voice-reader-time-duration');
  if (curLabel) curLabel.textContent = formatVoiceTime(cur);
  if (durLabel) durLabel.textContent = formatVoiceTime(dur);
}

function ensureVoiceOverlay() {
  if (voiceOverlayEl) return voiceOverlayEl;

  var mask = document.createElement('div');
  mask.id = 'voice-reader-overlay';
  mask.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.42);display:flex;align-items:center;justify-content:center;z-index:100000;';

  var panel = document.createElement('div');
  panel.style.cssText = 'background:#fff;border-radius:12px;padding:20px 24px;box-shadow:0 18px 50px rgba(15,23,42,0.28);min-width:280px;max-width:min(480px,calc(100vw-32px));text-align:center;';

  var msgEl = document.createElement('p');
  msgEl.id = 'voice-reader-overlay-msg';
  msgEl.style.cssText = 'margin:0 0 16px;font-size:0.95rem;color:#1f3344;line-height:1.5;max-height:160px;overflow:auto;word-break:break-word;';

  var btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:10px;justify-content:center;';

  var pauseBtn = document.createElement('button');
  pauseBtn.id = 'voice-reader-pause-btn';
  pauseBtn.type = 'button';
  pauseBtn.style.cssText = 'border:1px solid #d0d7de;background:#fff;color:#1f3344;border-radius:8px;padding:8px 18px;cursor:pointer;font-size:0.9rem;display:inline-flex;align-items:center;gap:6px;';
  pauseBtn.innerHTML = '<i data-lucide="pause"></i><span>暂停</span>';

  var stopBtn = document.createElement('button');
  stopBtn.id = 'voice-reader-stop-btn';
  stopBtn.type = 'button';
  stopBtn.style.cssText = 'border:1px solid #cf222e;background:#cf222e;color:#fff;border-radius:8px;padding:8px 18px;cursor:pointer;font-size:0.9rem;display:inline-flex;align-items:center;gap:6px;';
  stopBtn.innerHTML = '<i data-lucide="square"></i><span>停止</span>';

  btnRow.appendChild(pauseBtn);
  btnRow.appendChild(stopBtn);

  var seekRow = document.createElement('div');
  seekRow.style.cssText = 'margin-top:14px;display:flex;align-items:center;gap:8px;';

  var timeCurrent = document.createElement('span');
  timeCurrent.id = 'voice-reader-time-current';
  timeCurrent.style.cssText = 'font-size:0.78rem;color:#7a8794;min-width:38px;text-align:right;font-variant-numeric:tabular-nums;';
  timeCurrent.textContent = '0:00';

  var seekBar = document.createElement('input');
  seekBar.id = 'voice-reader-seek-bar';
  seekBar.type = 'range';
  seekBar.min = '0';
  seekBar.max = '100';
  seekBar.value = '0';
  seekBar.step = '0.1';
  seekBar.style.cssText = 'flex:1;min-width:0;height:6px;accent-color:#0969da;cursor:pointer;';

  var timeDuration = document.createElement('span');
  timeDuration.id = 'voice-reader-time-duration';
  timeDuration.style.cssText = 'font-size:0.78rem;color:#7a8794;min-width:38px;font-variant-numeric:tabular-nums;';
  timeDuration.textContent = '0:00';

  seekRow.appendChild(timeCurrent);
  seekRow.appendChild(seekBar);
  seekRow.appendChild(timeDuration);

  panel.appendChild(msgEl);
  panel.appendChild(btnRow);
  panel.appendChild(seekRow);
  mask.appendChild(panel);

  seekBar.addEventListener('input', function () {
    voiceSeekDragging = true;
    var curLabel = document.getElementById('voice-reader-time-current');
    if (curLabel) curLabel.textContent = formatVoiceTime(Number(seekBar.value));
  });

  seekBar.addEventListener('change', function () {
    voiceSeekDragging = false;
    if (voiceAudioEl && Number.isFinite(Number(seekBar.value))) {
      voiceAudioEl.currentTime = Number(seekBar.value);
    }
  });

  seekBar.addEventListener('pointerdown', function () {
    voiceSeekDragging = true;
  });

  seekBar.addEventListener('pointerup', function () {
    voiceSeekDragging = false;
    if (voiceAudioEl && Number.isFinite(Number(seekBar.value))) {
      voiceAudioEl.currentTime = Number(seekBar.value);
    }
  });

  pauseBtn.addEventListener('click', function () {
    if (voicePaused) {
      resumeVoiceRead();
    } else {
      pauseVoiceRead();
    }
  });

  stopBtn.addEventListener('click', function () {
    stopVoiceRead();
  });

  document.body.appendChild(mask);
  voiceOverlayEl = mask;
  return mask;
}

function showVoiceOverlay(message) {
  var overlay = ensureVoiceOverlay();
  var msgEl = document.getElementById('voice-reader-overlay-msg');
  if (msgEl) msgEl.textContent = message;
  var seekBar = document.getElementById('voice-reader-seek-bar');
  if (seekBar) {
    seekBar.value = '0';
    seekBar.max = '100';
  }
  var curLabel = document.getElementById('voice-reader-time-current');
  var durLabel = document.getElementById('voice-reader-time-duration');
  if (curLabel) curLabel.textContent = '0:00';
  if (durLabel) durLabel.textContent = '0:00';
  voiceSeekDragging = false;
  overlay.style.display = 'flex';
}

function hideVoiceOverlay() {
  if (voiceOverlayEl) {
    voiceOverlayEl.style.display = 'none';
  }
  voiceSeekDragging = false;
}

function updatePauseBtnState(paused) {
  var btn = document.getElementById('voice-reader-pause-btn');
  if (!btn) return;
  var span = btn.querySelector('span');
  var icon = btn.querySelector('i');
  if (paused) {
    if (icon) icon.setAttribute('data-lucide', 'play');
    if (span) span.textContent = '播放';
  } else {
    if (icon) icon.setAttribute('data-lucide', 'pause');
    if (span) span.textContent = '暂停';
  }
  if (typeof window.refreshLucideIcons === 'function') window.refreshLucideIcons();
}

function pauseVoiceRead() {
  if (voiceAudioEl) {
    voiceAudioEl.pause();
    voicePaused = true;
    updatePauseBtnState(true);
    showMsg('已暂停朗读', false);
    var msgEl = document.getElementById('voice-reader-overlay-msg');
    if (msgEl) msgEl.textContent = '已暂停朗读 — 点击播放继续';
  }
}

function prepareVoiceAudioElement() {
  if (!voiceAudioEl) voiceAudioEl = new Audio();
  voiceAudioEl.muted = false;
  voiceAudioEl.defaultMuted = false;
  voiceAudioEl.volume = 1;
  return voiceAudioEl;
}

function unlockVoiceAudioPlayback() {
  try {
    var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (AudioContextCtor) {
      if (!voiceAudioCtx || voiceAudioCtx.state === 'closed') {
        voiceAudioCtx = new AudioContextCtor();
      }
      if (voiceAudioCtx.state === 'suspended') {
        voiceAudioCtx.resume().catch(function () {});
      }
    }
  } catch (e) {}

  try {
    var unlockAudio = new Audio(VOICE_SILENT_WAV);
    unlockAudio.volume = 0.01;
    unlockAudio.play().catch(function () {});
    prepareVoiceAudioElement();
  } catch (e) {}
}

function clearVoiceAudioObjectUrl() {
  if (!voiceAudioObjectUrl) return;
  try { URL.revokeObjectURL(voiceAudioObjectUrl); } catch (e) {}
  voiceAudioObjectUrl = null;
}

function resumeVoiceRead() {
  if (!voiceAudioEl) return;
  prepareVoiceAudioElement();
  voiceAudioEl.play().then(function () {
    voicePaused = false;
    voiceAwaitingUserPlay = false;
    updatePauseBtnState(false);
    showMsg('正在朗读…', false);
    var msgEl = document.getElementById('voice-reader-overlay-msg');
    if (msgEl) msgEl.textContent = '正在朗读…';
  }).catch(function (err) {
    console.error('Voice resume error:', err);
    showMsg(err && err.message ? err.message : '播放失败，请再次点击播放', true);
  });
}

var VOICE_TTS_SPEED = 1.2;
var VOICE_TTS_MAX_CHARS = 800;

function getVoiceTtsApiUrl() {
  if (typeof TTS_API_BASE_URL !== 'undefined' && TTS_API_BASE_URL) {
    return String(TTS_API_BASE_URL).replace(/\/$/, '');
  }
  if (typeof window !== 'undefined' && window.location.hostname) {
    return window.location.protocol + '//' + window.location.hostname + ':52492';
  }
  return 'http://127.0.0.1:52492';
}

function splitTextForVoiceTts(text, maxChars) {
  var limit = maxChars || VOICE_TTS_MAX_CHARS;
  var parts = String(text || '').split('\n').map(function (line) {
    return line.trim();
  }).filter(Boolean);
  if (!parts.length) return [];

  var chunks = [];
  var current = '';
  for (var i = 0; i < parts.length; i++) {
    var piece = parts[i];
    var next = current ? current + '，\n' + piece : piece;
    if (next.length > limit && current) {
      chunks.push(current);
      current = piece;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function collectTitlesForVoice() {
  var articles = currentArticles;
  if (!articles || !articles.length) return '';
  var seen = {};
  var titles = [];
  for (var i = 0; i < articles.length; i++) {
    var t = String(articles[i].title || '').trim();
    if (t && !seen[t]) {
      seen[t] = true;
      titles.push(t);
    }
  }
  if (!titles.length) return '';
  return titles.join('，\n');
}

function showCopyToast(message, isError) {
  var toast = document.getElementById('copy-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'copy-toast';
    toast.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:100000;padding:10px 22px;border-radius:10px;font-size:0.9rem;line-height:1.4;pointer-events:none;opacity:0;transition:opacity 0.25s ease;white-space:nowrap;';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.background = isError ? '#cf222e' : '#1f3344';
  toast.style.color = '#fff';
  toast.style.boxShadow = isError ? '0 8px 28px rgba(207,34,46,0.35)' : '0 8px 28px rgba(15,23,42,0.35)';
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(function () {
    toast.style.opacity = '0';
  }, 2000);
}

function bindCopyTitlesBtn() {
  var btn = document.getElementById('reader-copy-titles-btn');
  if (!btn) return;
  btn.addEventListener('click', function () {
    var articles = currentArticles;
    if (!articles || !articles.length) {
      showCopyToast('当前页面无文章', true);
      return;
    }
    var titles = [];
    for (var i = 0; i < articles.length; i++) {
      var t = String(articles[i].title || '').trim();
      if (t) titles.push(t);
    }
    if (!titles.length) {
      showCopyToast('当前页面无文章标题', true);
      return;
    }
    var text = titles.join(' ');
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(function () {
        showCopyToast('已复制 ' + titles.length + ' 个标题', false);
      }).catch(function () {
        showCopyToast('复制失败，请重试', true);
      });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        showCopyToast('已复制 ' + titles.length + ' 个标题', false);
      } catch (error) {
        showCopyToast('复制失败，请重试', true);
      }
      document.body.removeChild(ta);
    }
  });
}

function bindVoiceReadBtn() {
  var btn = document.getElementById('reader-voice-read-btn');
  if (!btn) return;

  btn.addEventListener('click', function () {
    if (voicePlaying) {
      stopVoiceRead();
      return;
    }
    unlockVoiceAudioPlayback();
    startVoiceRead();
  });
}

function setVoiceBtnState(playing) {
  var btn = document.getElementById('reader-voice-read-btn');
  if (!btn) return;
  if (playing) {
    btn.classList.add('is-playing');
    var label = btn.querySelector('span');
    if (label) label.textContent = '停止朗读';
    btn.setAttribute('aria-label', '停止朗读');
    btn.title = '停止朗读';
  } else {
    btn.classList.remove('is-playing');
    var label = btn.querySelector('span');
    if (label) label.textContent = '语音朗读';
    btn.setAttribute('aria-label', '语音朗读');
    btn.title = '语音朗读';
  }
}

async function fetchPiperAudio(text, speed) {
  var res = await fetch(getVoiceTtsApiUrl() + '/api/tts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text: text,
      speed: speed || VOICE_TTS_SPEED
    }),
    signal: voiceAbortCtrl.signal
  });

  if (!res.ok) {
    var errData = await res.json().catch(function () { return {}; });
    throw new Error(errData.error || 'TTS 请求失败 (' + res.status + ')');
  }

  var blob = await res.blob();
  if (!blob || !blob.size) throw new Error('未收到音频数据');
  return blob;
}

function playAudioBlob(blob) {
  if (!blob || blob.size < 1000) {
    return Promise.reject(new Error('音频数据异常'));
  }

  clearVoiceAudioObjectUrl();
  voiceAudioObjectUrl = URL.createObjectURL(blob);

  return new Promise(function (resolve, reject) {
    var audio = prepareVoiceAudioElement();
    var settled = false;

    function finishResolve() {
      if (settled) return;
      settled = true;
      resolve();
    }

    function finishReject(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }

    function startPlayback() {
      audio.muted = false;
      audio.volume = 1;
      var playPromise = audio.play();
      if (!playPromise || typeof playPromise.then !== 'function') return;
      playPromise.catch(function (err) {
        console.warn('Voice autoplay blocked, waiting for user gesture:', err);
        voicePaused = true;
        voiceAwaitingUserPlay = true;
        updatePauseBtnState(true);
        showMsg('音频已就绪，请点击播放开始朗读', false);
        var msgEl = document.getElementById('voice-reader-overlay-msg');
        if (msgEl) msgEl.textContent = '音频已就绪，请点击播放开始朗读';
      });
    }

    audio.onended = finishResolve;
    audio.onerror = function () { finishReject(new Error('音频播放失败')); };
    audio.ontimeupdate = function () { updateVoiceSeekBar(); };
    audio.src = voiceAudioObjectUrl;

    if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      startPlayback();
    } else {
      audio.addEventListener('canplay', startPlayback, { once: true });
      audio.load();
    }
  });
}

async function startVoiceRead() {
  unlockVoiceAudioPlayback();

  var text = collectTitlesForVoice();
  if (!text) { showMsg('当前页面无文章标题', true); return; }

  var chunks = splitTextForVoiceTts(text, VOICE_TTS_MAX_CHARS);
  if (!chunks.length) { showMsg('当前页面无文章标题', true); return; }

  voicePlaying = true;
  voicePaused = false;
  voiceAwaitingUserPlay = false;
  setVoiceBtnState(true);
  showVoiceOverlay('正在生成语音…');
  showMsg('正在生成语音…', false);

  voiceAbortCtrl = new AbortController();

  try {
    for (var i = 0; i < chunks.length; i++) {
      if (!voicePlaying || !voiceAbortCtrl) break;

      var progressText = chunks.length > 1
        ? '正在生成语音…（' + (i + 1) + '/' + chunks.length + '）'
        : '正在生成语音…';
      showVoiceOverlay(progressText);
      showMsg(progressText, false);

      var blob = await fetchPiperAudio(chunks[i], VOICE_TTS_SPEED);

      showMsg('正在朗读…', false);
      var msgEl = document.getElementById('voice-reader-overlay-msg');
      if (msgEl) {
        msgEl.textContent = chunks.length > 1
          ? '正在朗读…（' + (i + 1) + '/' + chunks.length + '）'
          : '正在朗读…';
      }

      await playAudioBlob(blob);
    }

    if (voicePlaying) showMsg('朗读完成', false);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      showMsg('已停止朗读', false);
    } else {
      console.error('Voice read error:', err);
      showMsg(err.message || '语音朗读失败', true);
    }
  } finally {
    if (voiceAbortCtrl) voicePlaying = false;
    voicePaused = false;
    voiceAbortCtrl = null;
    setVoiceBtnState(false);
    hideVoiceOverlay();
  }
}

function stopVoiceRead() {
  if (voiceAbortCtrl) {
    voiceAbortCtrl.abort();
    voiceAbortCtrl = null;
  }
  if (voiceAudioEl) {
    try { voiceAudioEl.pause(); voiceAudioEl.src = ''; voiceAudioEl.load(); } catch (e) {}
    voiceAudioEl = null;
  }
  clearVoiceAudioObjectUrl();
  if (voiceAudioCtx) {
    try { voiceAudioCtx.close(); } catch (e) {}
    voiceAudioCtx = null;
  }
  voicePlaying = false;
  voicePaused = false;
  voiceAwaitingUserPlay = false;
  setVoiceBtnState(false);
  hideVoiceOverlay();
}

// ========== 语音朗读结束 ==========

// ========== 自动刷新与提示音 ==========
let readerAutoRefreshTimer = null;
let readerRefreshAudioCtx = null;
const READER_AUTO_REFRESH_INTERVAL_DEFAULT = 60 * 1000;
const READER_AUTO_REFRESH_STORAGE_KEY = 'article_reader_auto_refresh_interval';

function readReaderAutoRefreshInterval() {
  try {
    const raw = localStorage.getItem(READER_AUTO_REFRESH_STORAGE_KEY);
    if (!raw) return READER_AUTO_REFRESH_INTERVAL_DEFAULT;
    const num = parseInt(raw, 10);
    if (Number.isFinite(num) && (num === 0 || (num >= 30000 && num <= 3600000))) return num;
    return READER_AUTO_REFRESH_INTERVAL_DEFAULT;
  } catch (e) {
    return READER_AUTO_REFRESH_INTERVAL_DEFAULT;
  }
}

function saveReaderAutoRefreshInterval(value) {
  try {
    localStorage.setItem(READER_AUTO_REFRESH_STORAGE_KEY, String(value));
  } catch (e) {}
}

function getActiveReaderRefreshInterval() {
  if (bulletinActive) return readBulletinRefreshInterval();
  return readReaderAutoRefreshInterval();
}

function unlockReaderRefreshAudio() {
  try {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;
    if (!readerRefreshAudioCtx || readerRefreshAudioCtx.state === 'closed') {
      readerRefreshAudioCtx = new AudioContextCtor();
    }
    if (readerRefreshAudioCtx.state === 'suspended') {
      readerRefreshAudioCtx.resume().catch(function () {});
    }
  } catch (e) {}
}

function playReaderRefreshSound() {
  try {
    unlockReaderRefreshAudio();
    if (!readerRefreshAudioCtx) return;
    const ctx = readerRefreshAudioCtx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(1174.66, now + 0.08);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.28);
  } catch (e) {
    console.warn('playReaderRefreshSound failed:', e);
  }
}

function snapshotArticleIdsForRefresh() {
  if (bulletinActive) {
    const ids = new Set();
    document
      .querySelectorAll('.bulletin-feed-card:not(.is-hidden) .bulletin-feed-article-item[data-bulletin-article-id]')
      .forEach((el) => {
        const id = String(el.getAttribute('data-bulletin-article-id') || '').trim();
        if (id) ids.add(id);
      });
    return ids;
  }
  return new Set(
    (currentArticles || [])
      .map((a) => (a?.id != null ? String(a.id) : ''))
      .filter(Boolean)
  );
}

function detectNewArticlesSince(prevSnapshot, prevTotal) {
  const nextSnapshot = snapshotArticleIdsForRefresh();

  if (bulletinActive) {
    if (!prevSnapshot || prevSnapshot.size === 0) {
      return nextSnapshot.size > 0;
    }
    for (const id of nextSnapshot) {
      if (!prevSnapshot.has(id)) return true;
    }
    return false;
  }

  const prevCount = Number(prevTotal);
  const nextCount = Number(articleTotalCount);
  if (Number.isFinite(prevCount) && Number.isFinite(nextCount) && nextCount > prevCount) {
    return true;
  }
  if (!prevSnapshot || prevSnapshot.size === 0) {
    return false;
  }
  for (const id of nextSnapshot) {
    if (!prevSnapshot.has(id)) return true;
  }
  return false;
}

async function performReaderDataRefresh(options = {}) {
  const silent = !!options.silent;
  const playSound = !!options.playSound;
  const headers = authHeaders();
  if (!headers) return false;
  const prevSnapshot = silent && playSound ? snapshotArticleIdsForRefresh() : null;
  const prevTotal = silent && playSound ? articleTotalCount : null;
  try {
    await loadMenu();
    if (bulletinActive) {
      if (silent) {
        await refreshBulletinCards();
      } else {
        await loadBulletinBoard();
      }
    } else {
      await loadArticles({ silent });
    }
    if (playSound && detectNewArticlesSince(prevSnapshot, prevTotal)) {
      playReaderRefreshSound();
    }
    return true;
  } catch (error) {
    console.error('performReaderDataRefresh failed:', error);
    if (!silent) showMsg(error.message || '刷新失败', true);
    return false;
  }
}

function syncReaderAutoRefreshMenu() {
  const menu = document.getElementById('reader-layout-menu');
  if (!menu) return;
  const current = readReaderAutoRefreshInterval();
  menu.querySelectorAll('.article-reader-auto-refresh-option').forEach((btn) => {
    const value = parseInt(btn.getAttribute('data-auto-refresh'), 10);
    btn.classList.toggle('active', Number.isFinite(value) && value === current);
  });
}

function scheduleReaderAutoRefresh() {
  if (readerAutoRefreshTimer) {
    clearTimeout(readerAutoRefreshTimer);
    readerAutoRefreshTimer = null;
  }
  const interval = getActiveReaderRefreshInterval();
  if (interval <= 0) return;
  readerAutoRefreshTimer = setTimeout(async function () {
    if (document.hidden) {
      scheduleReaderAutoRefresh();
      return;
    }
    await performReaderDataRefresh({ silent: true, playSound: true });
    scheduleReaderAutoRefresh();
  }, interval);
}

function ensureReaderAutoRefreshMenu() {
  const menu = document.getElementById('reader-layout-menu');
  if (!menu || menu.dataset.autoRefreshBound === '1') return;
  menu.dataset.autoRefreshBound = '1';
  menu.querySelectorAll('.article-reader-auto-refresh-option').forEach((btn) => {
    btn.addEventListener('click', function () {
      const value = parseInt(btn.getAttribute('data-auto-refresh'), 10);
      if (!Number.isFinite(value)) return;
      saveReaderAutoRefreshInterval(value);
      syncReaderAutoRefreshMenu();
      scheduleReaderAutoRefresh();
    });
  });
  syncReaderAutoRefreshMenu();
}

const READER_CATEGORY_HIDDEN_STORAGE_KEY = 'article_reader_category_hidden';

function isReaderMobileViewport() {
  return (
    window.matchMedia('(max-width: 896px)').matches ||
    window.matchMedia('(orientation: portrait)').matches
  );
}

function hasExplicitReaderCategoryPreference() {
  try {
    const raw = localStorage.getItem(READER_CATEGORY_HIDDEN_STORAGE_KEY);
    return raw === '1' || raw === '0';
  } catch (e) {
    return false;
  }
}

function readReaderCategoryHidden() {
  try {
    const raw = localStorage.getItem(READER_CATEGORY_HIDDEN_STORAGE_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return isReaderMobileViewport();
  } catch (e) {
    return isReaderMobileViewport();
  }
}

function saveReaderCategoryHidden(hidden) {
  try {
    localStorage.setItem(READER_CATEGORY_HIDDEN_STORAGE_KEY, hidden ? '1' : '0');
  } catch (e) {}
}

function applyReaderCategoryHidden(hidden) {
  const layoutEl = document.querySelector('.article-reader-layout');
  if (!layoutEl) return;
  const mobile = isReaderMobileViewport();
  layoutEl.classList.toggle('is-category-hidden', !!hidden && !mobile);
  layoutEl.classList.toggle('is-category-visible', !hidden && mobile);
}

function syncReaderCategoryToggleMenu() {
  const btn = document.querySelector('.article-reader-toggle-category-option');
  if (!btn) return;
  btn.textContent = readReaderCategoryHidden() ? '显示分类' : '隐藏分类';
}

function refreshReaderCategoryVisibility() {
  applyReaderCategoryHidden(readReaderCategoryHidden());
  syncReaderCategoryToggleMenu();
}

function ensureReaderCategoryToggleMenu() {
  const btn = document.querySelector('.article-reader-toggle-category-option');
  if (!btn || btn.dataset.categoryToggleBound === '1') return;
  btn.dataset.categoryToggleBound = '1';
  btn.addEventListener('click', function () {
    const nextHidden = !readReaderCategoryHidden();
    saveReaderCategoryHidden(nextHidden);
    applyReaderCategoryHidden(nextHidden);
    syncReaderCategoryToggleMenu();
  });
  refreshReaderCategoryVisibility();
  if (!window.__readerCategoryViewportBound) {
    window.__readerCategoryViewportBound = true;
    const onViewportChange = function () {
      if (!hasExplicitReaderCategoryPreference()) {
        refreshReaderCategoryVisibility();
        return;
      }
      applyReaderCategoryHidden(readReaderCategoryHidden());
    };
    window.matchMedia('(max-width: 896px)').addEventListener('change', onViewportChange);
    window.matchMedia('(orientation: portrait)').addEventListener('change', onViewportChange);
  }
}

// ========== 板报布局 ==========
let bulletinActive = false;
const BULLETIN_REFRESH_INTERVAL = 60 * 1000;
const BULLETIN_ARTICLES_PER_FEED = 100;
const BULLETIN_STORAGE_HIDDEN = 'article_reader_bulletin_hidden';
const BULLETIN_STORAGE_ORDER = 'article_reader_bulletin_order';
const BULLETIN_STORAGE_COLUMNS = 'article_reader_bulletin_columns';
const BULLETIN_STORAGE_REFRESH = 'article_reader_bulletin_refresh_interval';
const BULLETIN_STORAGE_SHOW_TIME = 'article_reader_bulletin_show_time';

function readBulletinHiddenFeedIds() {
  try {
    const raw = localStorage.getItem(BULLETIN_STORAGE_HIDDEN);
    if (!raw) return [];
    return raw.split(',').map(function (id) { return parseInt(id, 10); }).filter(function (id) { return Number.isFinite(id); });
  } catch (e) { return []; }
}

function saveBulletinHiddenFeedIds(ids) {
  try {
    localStorage.setItem(BULLETIN_STORAGE_HIDDEN, (ids || []).join(','));
  } catch (e) {}
}

function readBulletinFeedOrder() {
  try {
    const raw = localStorage.getItem(BULLETIN_STORAGE_ORDER);
    if (!raw) return [];
    return raw.split(',').map(function (id) { return parseInt(id, 10); }).filter(function (id) { return Number.isFinite(id); });
  } catch (e) { return []; }
}

function saveBulletinFeedOrder(ids) {
  try {
    localStorage.setItem(BULLETIN_STORAGE_ORDER, (ids || []).join(','));
  } catch (e) {}
}

function readBulletinColumns() {
  try {
    var raw = localStorage.getItem(BULLETIN_STORAGE_COLUMNS);
    if (!raw) return 'auto';
    var num = parseInt(raw, 10);
    if (Number.isFinite(num) && num >= 1 && num <= 8) return num;
    return 'auto';
  } catch (e) { return 'auto'; }
}

function saveBulletinColumns(value) {
  try {
    localStorage.setItem(BULLETIN_STORAGE_COLUMNS, String(value));
  } catch (e) {}
}

function applyBulletinColumns() {
  var list = document.getElementById('article-reader-list');
  if (!list) return;
  var cols = readBulletinColumns();
  if (cols === 'auto') {
    list.style.gridTemplateColumns = '';
  } else {
    list.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
  }
}

function readBulletinRefreshInterval() {
  try {
    var raw = localStorage.getItem(BULLETIN_STORAGE_REFRESH);
    if (!raw) return BULLETIN_REFRESH_INTERVAL;
    var num = parseInt(raw, 10);
    if (Number.isFinite(num) && num >= 30000 && num <= 3600000) return num;
    return BULLETIN_REFRESH_INTERVAL;
  } catch (e) { return BULLETIN_REFRESH_INTERVAL; }
}

function saveBulletinRefreshInterval(value) {
  try {
    localStorage.setItem(BULLETIN_STORAGE_REFRESH, String(value));
  } catch (e) {}
}

function readBulletinShowTime() {
  try {
    var raw = localStorage.getItem(BULLETIN_STORAGE_SHOW_TIME);
    if (raw === '0') return false;
    return true;
  } catch (e) { return true; }
}

function saveBulletinShowTime(show) {
  try {
    localStorage.setItem(BULLETIN_STORAGE_SHOW_TIME, show ? '1' : '0');
  } catch (e) {}
}

function applyBulletinShowTime() {
  var list = document.getElementById('article-reader-list');
  if (!list) return;
  list.classList.toggle('bulletin-hide-time', !readBulletinShowTime());
}

function getBulletinFeeds() {
  var feeds = [];
  (menuState || []).forEach(function (group) {
    (group.feeds || []).forEach(function (feed) {
      feeds.push(feed);
    });
  });
  return feeds;
}

function sortFeedsByBulletinOrder(feeds) {
  var order = readBulletinFeedOrder();
  var hidden = readBulletinHiddenFeedIds();
  var orderedIds = new Set(order);
  var feedMap = {};
  feeds.forEach(function (f) { feedMap[f.id] = f; });

  var result = [];
  order.forEach(function (id) {
    if (feedMap[id] && hidden.indexOf(id) === -1) {
      result.push(feedMap[id]);
    }
  });
  feeds.forEach(function (f) {
    if (!orderedIds.has(f.id) && hidden.indexOf(f.id) === -1) {
      result.push(f);
    }
  });
  return result;
}

function ensureMenuLoadedForBulletin() {
  if (menuState && menuState.length > 0) {
    startBulletinMode();
    return;
  }
  loadMenu().then(startBulletinMode).catch(function (err) {
    showMsg(err.message || '加载 Feed 菜单失败', true);
  });
}

function startBulletinMode() {
  bulletinActive = true;
  var customizeBtn = document.getElementById('reader-bulletin-customize-btn');
  if (customizeBtn) customizeBtn.classList.remove('hidden');
  applyBulletinColumns();
  applyBulletinShowTime();
  loadBulletinBoard();
  scheduleReaderAutoRefresh();
}

function stopBulletinMode() {
  bulletinActive = false;
  var customizeBtn = document.getElementById('reader-bulletin-customize-btn');
  if (customizeBtn) customizeBtn.classList.add('hidden');
  var list = document.getElementById('article-reader-list');
  if (list) list.innerHTML = '';
  var loading = document.getElementById('article-reader-loading');
  if (loading) loading.classList.add('hidden');
}

async function loadBulletinBoard() {
  if (!bulletinActive) return;
  var feeds = getBulletinFeeds();
  if (!feeds.length) {
    renderBulletinBoard([], {});
    return;
  }
  var visibleFeeds = sortFeedsByBulletinOrder(feeds);
  if (!visibleFeeds.length) {
    renderBulletinBoard([], {});
    return;
  }

  showMsg('');

  var headers = authHeaders();
  if (!headers) return;

  var feedMap = {};
  visibleFeeds.forEach(function (f) { feedMap[f.id] = { feed: f, articles: [], loading: true }; });
  renderBulletinBoard(visibleFeeds, feedMap);

  var feedIds = visibleFeeds.map(function (f) { return f.id; });
  var concurrency = 5;
  var index = 0;

  function fetchNext() {
    if (index >= feedIds.length) return Promise.resolve();
    var batch = [];
    var end = Math.min(index + concurrency, feedIds.length);
    for (var i = index; i < end; i++) {
      batch.push(fetchFeedBulletinArticles(feedIds[i]));
    }
    index = end;
    return Promise.all(batch).then(function () {
      return fetchNext();
    });
  }

  try {
    await fetchNext();
  } catch (err) {
    console.error('loadBulletinBoard failed:', err);
  }
}

async function fetchFeedBulletinArticles(feedId) {
  var headers = authHeaders();
  if (!headers) return;
  try {
    var params = new URLSearchParams();
    params.set('feedId', String(feedId));
    params.set('limit', String(BULLETIN_ARTICLES_PER_FEED));
    params.set('offset', '0');
    params.set('scope', 'all');
    var res = await fetch(API_BASE_URL + '/feed-subscriptions/articles?' + params.toString(), { headers: headers });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || '加载失败');
    var articles = Array.isArray(data.articles) ? data.articles : [];
    var cardEl = document.querySelector('[data-bulletin-feed-id="' + feedId + '"]');
    if (cardEl) {
      renderBulletinCardBody(cardEl, articles);
    }
  } catch (err) {
    console.error('fetchFeedBulletinArticles failed for feed ' + feedId + ':', err);
    var cardEl = document.querySelector('[data-bulletin-feed-id="' + feedId + '"]');
    if (cardEl) {
      var body = cardEl.querySelector('.bulletin-feed-card-body');
      if (body) body.innerHTML = '<div class="bulletin-feed-card-empty">加载失败</div>';
    }
  }
}

function renderBulletinBoard(feeds, feedMap) {
  var list = document.getElementById('article-reader-list');
  var empty = document.getElementById('article-reader-empty');
  var nav = document.getElementById('article-reader-pagination');
  if (nav) { nav.classList.add('hidden'); nav.innerHTML = ''; }
  var detail = document.getElementById('article-reader-detail');
  if (detail) detail.style.display = 'none';

  if (!feeds.length) {
    list.classList.add('hidden');
    if (empty) { empty.classList.remove('hidden'); empty.textContent = '暂无 Feed 数据。'; }
    return;
  }
  if (empty) empty.classList.add('hidden');
  list.classList.remove('hidden');

  list.innerHTML = feeds.map(function (feed) {
    var faviconHtml = buildFeedFaviconMarkup(feed);
    return '<div class="bulletin-feed-card" data-bulletin-feed-id="' + feed.id + '">' +
      '<div class="bulletin-feed-card-header" draggable="true">' +
        faviconHtml +
        '<span class="bulletin-feed-card-title-wrap">' +
          '<span class="bulletin-feed-card-title" title="' + escapeHtml(feed.title || '') + '">' + escapeHtml(feed.title || 'Feed #' + feed.id) + '</span>' +
          buildFeedLangTag(feed) +
          buildFeedCrawlMetaTag(feed) +
          buildFeedCrawlFailTag(feed) +
        '</span>' +
        '<span class="bulletin-feed-card-count">加载中…</span>' +
        '<button type="button" class="bulletin-feed-card-menu-btn" data-bulletin-feed-id="' + feed.id + '" aria-label="更多操作" title="更多操作">⋮</button>' +
      '</div>' +
      '<div class="bulletin-feed-card-body">' +
        '<div class="bulletin-feed-card-loading">加载中…</div>' +
      '</div>' +
    '</div>';
  }).join('');

  bindBulletinCardEvents();
}

function renderBulletinCardBody(cardEl, articles) {
  var body = cardEl.querySelector('.bulletin-feed-card-body');
  var countEl = cardEl.querySelector('.bulletin-feed-card-count');
  if (!body) return;

  var sorted = (articles || []).slice().sort(function (a, b) {
    var da = new Date(a.pub_date || a.created_at || 0).getTime();
    var db = new Date(b.pub_date || b.created_at || 0).getTime();
    return (isNaN(db) ? 0 : db) - (isNaN(da) ? 0 : da);
  });

  if (countEl) countEl.textContent = sorted.length + ' 篇';

  if (!sorted.length) {
    body.innerHTML = '<div class="bulletin-feed-card-empty">暂无文章</div>';
    return;
  }

  body.innerHTML = sorted.map(function (a) {
    var title = getArticleDisplayTitle(a);
    var timeValue = a.pub_date || a.created_at || a.createdAt || a.created_time || '';
    var shortTime = formatShortAddedTime(timeValue);
    var readClass = a.is_read ? ' is-read' : '';
    return '<div class="bulletin-feed-article-item' + readClass + '" data-bulletin-article-url="' + escapeHtml(a.url || '') + '" data-bulletin-article-id="' + (a.id || '') + '" data-bulletin-article-index="' + sorted.indexOf(a) + '">' +
      '<span class="bulletin-feed-article-time">' + escapeHtml(shortTime || '—') + '</span>' +
      '<span class="bulletin-feed-article-title" title="' + escapeHtml(title) + '">' + escapeHtml(title) + '</span>' +
    '</div>';
  }).join('');
}

function bindBulletinCardEvents() {
  var list = document.getElementById('article-reader-list');
  if (!list || list.dataset.bulletinEvents === '1') return;
  list.dataset.bulletinEvents = '1';

  // 文章点击
  list.addEventListener('click', function (e) {
    var item = e.target.closest('.bulletin-feed-article-item');
    if (!item) return;
    var url = item.getAttribute('data-bulletin-article-url');
    if (url) window.open(url, '_blank', 'noopener');
  });

  // 菜单按钮点击
  list.addEventListener('click', function (e) {
    var menuBtn = e.target.closest('.bulletin-feed-card-menu-btn');
    if (!menuBtn) return;
    e.stopPropagation();
    e.preventDefault();
    var feedId = parseInt(menuBtn.getAttribute('data-bulletin-feed-id'), 10);
    if (Number.isFinite(feedId)) openBulletinCardMenu(menuBtn, feedId);
  });

  // 点击空白处关闭菜单
  document.addEventListener('click', function (e) {
    var menu = document.getElementById('bulletin-card-context-menu');
    if (!menu || menu.classList.contains('hidden')) return;
    if (!menu.contains(e.target)) closeBulletinCardMenu();
  });

  // 拖拽排序
  var dragCard = null;
  var dragPlaceholder = null;
  var dragRafId = null;
  var dragLastClientY = 0;
  var dragLastClientX = 0;

  function createPlaceholder() {
    var el = document.createElement('div');
    el.className = 'bulletin-drop-placeholder';
    return el;
  }

  function placePlaceholder(placeholder, card, before) {
    var list = document.getElementById('article-reader-list');
    if (!list || !card || !placeholder) return;
    var cards = list.querySelectorAll('.bulletin-feed-card');
    var cardFound = false;
    for (var i = 0; i < cards.length; i++) {
      if (cards[i] === card) { cardFound = true; break; }
    }
    if (!cardFound) return;
    if (before) {
      list.insertBefore(placeholder, card);
    } else {
      var next = card.nextSibling;
      if (next === placeholder) next = placeholder.nextSibling;
      list.insertBefore(placeholder, next);
    }
  }

  function findClosestCard(clientX, clientY) {
    var list = document.getElementById('article-reader-list');
    if (!list) return null;
    var cards = list.querySelectorAll('.bulletin-feed-card:not(.is-hidden):not(.bulletin-dragging)');
    if (!cards.length) return null;

    var closest = null;
    var closestDist = Infinity;

    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var rect = card.getBoundingClientRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      var dx = clientX - cx;
      var dy = clientY - cy;
      var dist = dx * dx + dy * dy;
      if (dist < closestDist) {
        closestDist = dist;
        closest = { card: card, rect: rect };
      }
    }

    if (!closest) return null;
    var midX = closest.rect.left + closest.rect.width / 2;
    return { card: closest.card, before: clientX < midX };
  }

  list.addEventListener('dragstart', function (e) {
    var header = e.target.closest('.bulletin-feed-card-header');
    if (!header || !header.hasAttribute('draggable')) return;
    if (e.target.closest('.bulletin-feed-card-menu-btn')) {
      e.preventDefault();
      return;
    }
    var card = header.closest('.bulletin-feed-card');
    if (!card || card.classList.contains('is-hidden')) return;
    dragCard = card;
    card.classList.add('bulletin-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.getAttribute('data-bulletin-feed-id'));

    dragPlaceholder = createPlaceholder();
    if (card.offsetWidth) dragPlaceholder.style.width = card.offsetWidth + 'px';
    card.parentNode.insertBefore(dragPlaceholder, card.nextSibling);
  });

  list.addEventListener('dragend', function (e) {
    if (dragRafId) { cancelAnimationFrame(dragRafId); dragRafId = null; }
    if (dragPlaceholder && dragPlaceholder.parentNode) dragPlaceholder.parentNode.removeChild(dragPlaceholder);
    dragPlaceholder = null;
    if (dragCard) {
      dragCard.classList.remove('bulletin-dragging');
      dragCard = null;
    }
  });

  list.addEventListener('dragover', function (e) {
    if (!dragCard || !dragPlaceholder) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dragLastClientX = e.clientX;
    dragLastClientY = e.clientY;

    if (!dragRafId) {
      dragRafId = requestAnimationFrame(function () {
        dragRafId = null;
        if (!dragCard || !dragPlaceholder) return;
        var target = findClosestCard(dragLastClientX, dragLastClientY);
        if (target) {
          placePlaceholder(dragPlaceholder, target.card, target.before);
        }
      });
    }
  });

  list.addEventListener('drop', function (e) {
    e.preventDefault();
    if (!dragCard || !dragPlaceholder) { dragCard = null; return; }

    var placeholderEl = dragPlaceholder;
    var parent = placeholderEl.parentNode;
    if (parent) {
      parent.insertBefore(dragCard, placeholderEl);
      parent.removeChild(placeholderEl);
    }
    dragCard.classList.remove('bulletin-dragging');
    dragCard = null;
    dragPlaceholder = null;
    if (dragRafId) { cancelAnimationFrame(dragRafId); dragRafId = null; }
    saveBulletinOrderFromDOM();
  });
}

function saveBulletinOrderFromDOM() {
  var list = document.getElementById('article-reader-list');
  if (!list) return;
  var cards = list.querySelectorAll('.bulletin-feed-card');
  var order = [];
  cards.forEach(function (card) {
    var id = parseInt(card.getAttribute('data-bulletin-feed-id'), 10);
    if (Number.isFinite(id)) order.push(id);
  });
  if (order.length) saveBulletinFeedOrder(order);
}

// ---- 卡片菜单 ----
function ensureBulletinCardMenu() {
  var menu = document.getElementById('bulletin-card-context-menu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'bulletin-card-context-menu';
  menu.className = 'article-reader-group-context-menu hidden';
  menu.style.position = 'fixed';
  menu.innerHTML = '<button type="button" class="article-reader-group-context-item" data-action="close-card">关闭</button>' +
    '<button type="button" class="article-reader-group-context-item" data-action="card-settings">设置</button>';
  document.body.appendChild(menu);
  menu.addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var feedId = parseInt(menu.dataset.menuFeedId, 10);
    closeBulletinCardMenu();
    if (!Number.isFinite(feedId)) return;

    if (action === 'close-card') {
      hideBulletinFeedCard(feedId);
    } else if (action === 'card-settings') {
      showMsg('暂未开放', false);
    }
  });
  return menu;
}

function openBulletinCardMenu(anchor, feedId) {
  closeBulletinCardMenu();
  var menu = ensureBulletinCardMenu();
  menu.dataset.menuFeedId = String(feedId);
  menu.classList.remove('hidden');
  var rect = anchor.getBoundingClientRect();
  var menuW = menu.offsetWidth || 100;
  var menuH = menu.offsetHeight || 60;
  var left = Math.min(rect.right - menuW, window.innerWidth - menuW - 8);
  left = Math.max(8, left);
  var top = rect.bottom + 4;
  if (top + menuH > window.innerHeight - 8) top = rect.top - menuH - 4;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function closeBulletinCardMenu() {
  var menu = document.getElementById('bulletin-card-context-menu');
  if (!menu) return;
  menu.classList.add('hidden');
  delete menu.dataset.menuFeedId;
}

function hideBulletinFeedCard(feedId) {
  var card = document.querySelector('.bulletin-feed-card[data-bulletin-feed-id="' + feedId + '"]');
  if (card) card.classList.add('is-hidden');
  var hidden = readBulletinHiddenFeedIds();
  if (hidden.indexOf(feedId) === -1) {
    hidden.push(feedId);
    saveBulletinHiddenFeedIds(hidden);
  }
  if (typeof refreshBulletinHiddenBadge === 'function') refreshBulletinHiddenBadge();
}

async function refreshBulletinCards() {
  if (!bulletinActive) return;
  var list = document.getElementById('article-reader-list');
  if (!list) return;
  var cards = list.querySelectorAll('.bulletin-feed-card:not(.is-hidden)');
  if (!cards.length) return;

  var feedIds = [];
  cards.forEach(function (card) {
    var id = parseInt(card.getAttribute('data-bulletin-feed-id'), 10);
    if (Number.isFinite(id)) feedIds.push(id);
  });

  var concurrency = 5;
  var index = 0;

  function fetchNext() {
    if (index >= feedIds.length) return Promise.resolve();
    var batch = [];
    var end = Math.min(index + concurrency, feedIds.length);
    for (var i = index; i < end; i++) {
      batch.push(fetchFeedBulletinArticles(feedIds[i]));
    }
    index = end;
    return Promise.all(batch).then(function () {
      return fetchNext();
    });
  }

  await fetchNext();
}

function openBulletinCustomize() {
  var feeds = getBulletinFeeds();
  if (!feeds.length) { showMsg('暂无 Feed 可定制', true); return; }

  var hidden = readBulletinHiddenFeedIds();
  var order = readBulletinFeedOrder();
  var orderedIds = new Set(order);

  var sorted = order.map(function (id) {
    return feeds.find(function (f) { return f.id === id; });
  }).filter(Boolean);

  feeds.forEach(function (f) {
    if (!orderedIds.has(f.id)) sorted.push(f);
  });

  var overlay = document.createElement('div');
  overlay.className = 'bulletin-customize-overlay';

  var rowsHtml = sorted.map(function (feed, idx) {
    var isHidden = hidden.indexOf(feed.id) !== -1;
    var isFirst = idx === 0;
    var isLast = idx === sorted.length - 1;
    var faviconHtml = buildFeedFaviconMarkup(feed);
    return '<div class="bulletin-customize-feed-row" data-feed-id="' + feed.id + '">' +
      '<input type="checkbox" class="bulletin-customize-feed-checkbox"' + (isHidden ? '' : ' checked') + ' data-feed-id="' + feed.id + '">' +
      '<span class="bulletin-customize-feed-favicon">' + faviconHtml + '</span>' +
      '<span class="bulletin-customize-feed-name" title="' + escapeHtml(feed.title || '') + '">' + escapeHtml(feed.title || 'Feed #' + feed.id) + '</span>' +
      '<div class="bulletin-customize-feed-actions">' +
        '<button type="button" data-action="up" data-feed-id="' + feed.id + '"' + (isFirst ? ' disabled' : '') + '>▲</button>' +
        '<button type="button" data-action="down" data-feed-id="' + feed.id + '"' + (isLast ? ' disabled' : '') + '>▼</button>' +
      '</div>' +
    '</div>';
  }).join('');

  var currentColumns = readBulletinColumns();
  var currentRefresh = readBulletinRefreshInterval();
  var currentShowTime = readBulletinShowTime();

  overlay.innerHTML = '<div class="bulletin-customize-panel">' +
    '<div class="bulletin-customize-panel-header">' +
      '<span class="bulletin-customize-panel-title">定制板报</span>' +
      '<button type="button" class="bulletin-customize-panel-close" data-action="close-customize">✕</button>' +
    '</div>' +
    '<div class="bulletin-customize-panel-body">' + rowsHtml + '</div>' +
    '<div class="bulletin-customize-panel-footer">' +
      '<div class="bulletin-customize-panel-colcount">' +
        '<label style="font-size:0.85rem;color:#4c6072;">列数</label>' +
        '<select class="bulletin-customize-colcount-select">' +
          '<option value="auto"' + (currentColumns === 'auto' ? ' selected' : '') + '>自适应</option>' +
          '<option value="1"' + (currentColumns === 1 ? ' selected' : '') + '>1列</option>' +
          '<option value="2"' + (currentColumns === 2 ? ' selected' : '') + '>2列</option>' +
          '<option value="3"' + (currentColumns === 3 ? ' selected' : '') + '>3列</option>' +
          '<option value="4"' + (currentColumns === 4 ? ' selected' : '') + '>4列</option>' +
          '<option value="5"' + (currentColumns === 5 ? ' selected' : '') + '>5列</option>' +
          '<option value="6"' + (currentColumns === 6 ? ' selected' : '') + '>6列</option>' +
        '</select>' +
      '</div>' +
      '<div class="bulletin-customize-panel-colcount">' +
        '<label style="font-size:0.85rem;color:#4c6072;">刷新</label>' +
        '<select class="bulletin-customize-refresh-select">' +
          '<option value="30000"' + (currentRefresh === 30000 ? ' selected' : '') + '>30秒</option>' +
          '<option value="60000"' + (currentRefresh === 60000 ? ' selected' : '') + '>1分钟</option>' +
          '<option value="120000"' + (currentRefresh === 120000 ? ' selected' : '') + '>2分钟</option>' +
          '<option value="300000"' + (currentRefresh === 300000 ? ' selected' : '') + '>5分钟</option>' +
          '<option value="600000"' + (currentRefresh === 600000 ? ' selected' : '') + '>10分钟</option>' +
          '<option value="0"' + (currentRefresh === 0 ? ' selected' : '') + '>关闭</option>' +
        '</select>' +
      '</div>' +
      '<div class="bulletin-customize-panel-colcount">' +
        '<label style="display:flex;align-items:center;gap:4px;font-size:0.85rem;color:#4c6072;cursor:pointer;">' +
          '<input type="checkbox" class="bulletin-customize-showtime-checkbox"' + (currentShowTime ? ' checked' : '') + '>显示时间</label>' +
      '</div>' +
      '<button type="button" class="btn-cancel" data-action="close-customize">取消</button>' +
      '<button type="button" class="btn-save" data-action="save-customize">保存</button>' +
    '</div>' +
  '</div>';

  document.body.appendChild(overlay);

  function closePanel() {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closePanel();
  });

  var panel = overlay.querySelector('.bulletin-customize-panel');
  panel.querySelectorAll('[data-action="close-customize"]').forEach(function (btn) {
    btn.addEventListener('click', closePanel);
  });

  panel.querySelector('.bulletin-customize-panel-body').addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var feedId = parseInt(btn.getAttribute('data-feed-id'), 10);
    if (!Number.isFinite(feedId)) return;

    var rows = Array.from(panel.querySelectorAll('.bulletin-customize-feed-row'));
    var currentIdx = rows.findIndex(function (r) { return parseInt(r.getAttribute('data-feed-id'), 10) === feedId; });
    if (currentIdx === -1) return;

    if (action === 'up' && currentIdx > 0) {
      var body = panel.querySelector('.bulletin-customize-panel-body');
      body.insertBefore(rows[currentIdx], rows[currentIdx - 1]);
      refreshCustomizeButtons(panel);
    } else if (action === 'down' && currentIdx < rows.length - 1) {
      var body = panel.querySelector('.bulletin-customize-panel-body');
      body.insertBefore(rows[currentIdx + 1], rows[currentIdx]);
      refreshCustomizeButtons(panel);
    }
  });

  panel.querySelector('[data-action="save-customize"]').addEventListener('click', function () {
    var rows = Array.from(panel.querySelectorAll('.bulletin-customize-feed-row'));
    var newOrder = rows.map(function (r) { return parseInt(r.getAttribute('data-feed-id'), 10); });
    var newHidden = [];
    panel.querySelectorAll('.bulletin-customize-feed-checkbox:not(:checked)').forEach(function (cb) {
      var id = parseInt(cb.getAttribute('data-feed-id'), 10);
      if (Number.isFinite(id)) newHidden.push(id);
    });

    var colSelect = panel.querySelector('.bulletin-customize-colcount-select');
    var newColumns = colSelect ? colSelect.value : 'auto';

    var refreshSelect = panel.querySelector('.bulletin-customize-refresh-select');
    var newRefresh = refreshSelect ? parseInt(refreshSelect.value, 10) : BULLETIN_REFRESH_INTERVAL;
    if (!Number.isFinite(newRefresh)) newRefresh = BULLETIN_REFRESH_INTERVAL;

    var showTimeCheckbox = panel.querySelector('.bulletin-customize-showtime-checkbox');
    var newShowTime = showTimeCheckbox ? showTimeCheckbox.checked : true;

    saveBulletinFeedOrder(newOrder);
    saveBulletinHiddenFeedIds(newHidden);
    saveBulletinColumns(newColumns);
    saveBulletinRefreshInterval(newRefresh);
    saveBulletinShowTime(newShowTime);
    applyBulletinColumns();
    applyBulletinShowTime();
    closePanel();
    if (bulletinActive) {
      scheduleReaderAutoRefresh();
      loadBulletinBoard();
    }
  });
}

function refreshCustomizeButtons(panel) {
  var rows = Array.from(panel.querySelectorAll('.bulletin-customize-feed-row'));
  rows.forEach(function (row, idx) {
    var upBtn = row.querySelector('[data-action="up"]');
    var downBtn = row.querySelector('[data-action="down"]');
    if (upBtn) upBtn.disabled = idx === 0;
    if (downBtn) downBtn.disabled = idx === rows.length - 1;
  });
}

// ========== 板报布局结束 ==========

document.addEventListener('feedgen:group-created', async () => {
  try {
    await loadMenu();
  } catch (error) {
    showMsg(error.message || '刷新分组菜单失败', true);
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  articlePageSize = readStoredArticlePageSize();
  applyRestoredSidebarSelection();
  ensureGroupContextMenu();
  ensureFeedContextMenu();
  ensureArticleActionMenu();
  ensureToolbarRefreshBtn();
  ensureReaderAutoRefreshMenu();
  ensureReaderCategoryToggleMenu();
  initSidebarTagsUi();
  initSidebarCategoriesUi();
  updateAllButtonLabel(0);

  var bulletinCustomizeBtn = document.getElementById('reader-bulletin-customize-btn');
  if (bulletinCustomizeBtn) {
    bulletinCustomizeBtn.addEventListener('click', function () {
      openBulletinCustomize();
    });
  }
  syncQuickScopeButtons();
  updateTopNavUserInfo();
  const allBtn = document.getElementById('reader-all-btn');
  const todayBtn = document.getElementById('reader-today-btn');
  const likedBtn = document.getElementById('reader-liked-btn');
  if (allBtn) {
    allBtn.addEventListener('click', async () => {
      resetArticleListPage();
      activeScope = 'all';
      activeTagId = null;
      activeCategoryId = null;
      activeUnreadOnly = false;
      activeFeedId = ALL_FEED_ID;
      activeGroupId = null;
      activeFeedTitle = '全部文章';
      updateCurrentFeedTitle('全部文章');
      syncTagFilterChrome();
      saveSidebarSelection();
      renderMenu();
      await loadArticles();
    });
  }
  if (todayBtn) {
    todayBtn.addEventListener('click', async () => {
      resetArticleListPage();
      activeScope = 'today';
      activeTagId = null;
      activeCategoryId = null;
      activeUnreadOnly = false;
      activeFeedId = ALL_FEED_ID;
      activeGroupId = null;
      activeFeedTitle = '今天';
      updateCurrentFeedTitle('今天文章');
      syncTitleFilterMenu();
      syncTagFilterChrome();
      saveSidebarSelection();
      renderMenu();
      await loadArticles();
    });
  }
  if (likedBtn) {
    likedBtn.addEventListener('click', async () => {
      resetArticleListPage();
      activeScope = 'liked';
      activeTagId = null;
      activeCategoryId = null;
      activeUnreadOnly = false;
      activeFeedId = ALL_FEED_ID;
      activeGroupId = null;
      activeFeedTitle = '喜欢';
      updateCurrentFeedTitle('喜欢的文章');
      syncTagFilterChrome();
      saveSidebarSelection();
      renderMenu();
      await loadArticles();
    });
  }
  try {
    await loadMenu();
  } catch (error) {
    showMsg(error.message || '初始化分组菜单失败', true);
  }

  const addFeedParam = new URLSearchParams(window.location.search).get('addFeed');
  if (addFeedParam === '1') {
    openAddFeedDialog();
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('addFeed');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    } catch (error) {
      console.error('clean addFeed query failed:', error);
    }
  }

  if (document.getElementById('article-reader-list') && document.getElementById('article-reader-list').classList.contains('layout-bulletin')) {
    startBulletinMode();
  } else {
    await loadArticles();
  }

  document.getElementById('reader-refresh-btn').addEventListener('click', async () => {
    await performReaderDataRefresh({ silent: false, playSound: false });
  });

  document.addEventListener('click', unlockReaderRefreshAudio, { once: true, capture: true });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) scheduleReaderAutoRefresh();
  });
  scheduleReaderAutoRefresh();

  bindVoiceReadBtn();
  bindCopyTitlesBtn();

  document.addEventListener('article-reader-layout-change', (event) => {
    const layout = event && event.detail ? event.detail.layout : 'list';
    if (layout === 'bulletin') {
      ensureMenuLoadedForBulletin();
      return;
    }
    var wasBulletin = bulletinActive;
    stopBulletinMode();
    scheduleReaderAutoRefresh();
    if (wasBulletin) {
      loadArticles();
    }
    if (layout === 'columns' || layout === 'columns-iframe') {
      if (currentArticles.length) selectArticleByIndex(activeArticleIndex >= 0 ? activeArticleIndex : 0);
      else updateDetailPane(null);
      return;
    }
    activeArticleIndex = -1;
    updateDetailPane(null);
  });

  document.addEventListener('click', (event) => {
    const groupMenu = document.getElementById('article-reader-group-context-menu');
    const feedMenu = document.getElementById('article-reader-feed-context-menu');
    const tagMenu = document.getElementById('article-reader-tag-context-menu');
    if (groupMenu && !groupMenu.classList.contains('hidden') && !groupMenu.contains(event.target)) {
      closeGroupContextMenu();
    }
    if (feedMenu && !feedMenu.classList.contains('hidden') && !feedMenu.contains(event.target)) {
      closeFeedContextMenu();
    }
    if (
      tagMenu &&
      !tagMenu.classList.contains('hidden') &&
      !tagMenu.contains(event.target) &&
      !(event.target instanceof HTMLElement && event.target.closest('[data-tag-menu-id]'))
    ) {
      closeTagContextMenu();
    }
    const articleMenu = document.getElementById('article-reader-article-action-menu');
    if (
      articleMenu &&
      !articleMenu.classList.contains('hidden') &&
      !articleMenu.contains(event.target) &&
      !(event.target instanceof HTMLElement && event.target.closest('[data-article-action-menu]'))
    ) {
      closeArticleActionMenu();
    }
    const categoryAnnotateMenu = document.getElementById('article-reader-category-annotate-menu');
    if (
      categoryAnnotateMenu &&
      !categoryAnnotateMenu.classList.contains('hidden') &&
      !categoryAnnotateMenu.contains(event.target) &&
      !(event.target instanceof HTMLElement && event.target.closest('[data-action="annotate-category"]'))
    ) {
      closeCategoryAnnotateMenu();
    }
    const mobilePagePanel = document.getElementById('article-reader-mobile-page-panel');
    if (
      mobilePagePanel &&
      !mobilePagePanel.classList.contains('hidden') &&
      !mobilePagePanel.contains(event.target) &&
      !(event.target instanceof HTMLElement && event.target.closest('[data-article-page-panel-toggle]'))
    ) {
      mobilePagePanel.classList.add('hidden');
    }
    const titleFilterMenu = document.getElementById('article-reader-title-filter-menu');
    const titleFilterBtn = document.getElementById('article-reader-current-feed');
    if (
      titleFilterMenu &&
      !titleFilterMenu.classList.contains('hidden') &&
      !titleFilterMenu.contains(event.target) &&
      !(event.target instanceof HTMLElement && event.target.closest('#article-reader-current-feed'))
    ) {
      titleFilterMenu.classList.add('hidden');
      if (titleFilterBtn) titleFilterBtn.setAttribute('aria-expanded', 'false');
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeGroupContextMenu();
      closeFeedContextMenu();
      closeTagContextMenu();
      closeArticleActionMenu();
      closeCategoryAnnotateMenu();
      const mobilePagePanel = document.getElementById('article-reader-mobile-page-panel');
      if (mobilePagePanel) mobilePagePanel.classList.add('hidden');
      const titleFilterMenu = document.getElementById('article-reader-title-filter-menu');
      const titleFilterBtn = document.getElementById('article-reader-current-feed');
      if (titleFilterMenu) titleFilterMenu.classList.add('hidden');
      if (titleFilterBtn) titleFilterBtn.setAttribute('aria-expanded', 'false');
    }
  });
});

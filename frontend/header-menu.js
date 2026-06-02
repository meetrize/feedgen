(() => {
  const page = (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const mountEl = document.getElementById('global-header');
  if (!mountEl) return;

  /** 左侧主导航：按链接 href 映射 Lucide 图标名（kebab-case）ddd */
  const leftNavLucideByHref = {
    'my-feeds.html': 'cast',
    'article-reader.html': 'book-open',
    'crawler-strategy.html': 'activity',
    'membership.html': 'gem',
    'settings.html': 'settings',
    'admin.html': 'monitor-cog',
  };

  function lucideIconMarkup(iconName) {
    const name = String(iconName || 'circle').trim();
    return `<span class="nav-icon"><i data-lucide="${name}"></i></span>`;
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

  function authHeaders() {
    const token = localStorage.getItem('anonymousUserToken');
    if (!token) return null;
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
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

  function headerToast(text, isError) {
    if (typeof window.showMsg === 'function') {
      window.showMsg(text, isError);
      return;
    }
    const el = document.getElementById('article-reader-msg') || document.getElementById('subscription-hint');
    if (el) {
      el.textContent = text;
      el.style.color = isError ? '#c0392b' : '#2e7d32';
      return;
    }
    window.alert(text);
  }

  function openAddGroupDialog() {
    const headers = authHeaders();
    if (!headers) {
      headerToast('请先登录后再添加分组', true);
      return;
    }
    if (typeof API_BASE_URL === 'undefined') {
      headerToast('配置未加载，请刷新页面后重试', true);
      return;
    }

    let selectedIcon = 'folder';
    const mask = createDialogMask();
    const dialog = document.createElement('div');
    dialog.style.width = 'min(420px, calc(100vw - 32px))';
    dialog.style.background = '#fff';
    dialog.style.borderRadius = '10px';
    dialog.style.padding = '16px';
    dialog.style.boxShadow = '0 18px 50px rgba(15, 23, 42, 0.28)';
    dialog.innerHTML = `
      <h3 style="margin:0 0 12px;font-size:16px;color:#1f3344;">新增分组</h3>
      <label style="display:block;margin:0 0 6px;color:#4c6072;font-size:13px;">组名</label>
      <input id="header-group-name-input" type="text" placeholder="请输入分组名称" maxlength="100" style="width:100%;height:34px;padding:0 10px;border:1px solid #d0d7de;border-radius:6px;box-sizing:border-box;">
      <label style="display:block;margin:12px 0 6px;color:#4c6072;font-size:13px;">图标</label>
      <div id="header-group-icon-picker" class="header-group-icon-picker"></div>
      <p id="header-group-dialog-msg" style="margin:8px 0 0;min-height:18px;font-size:12px;color:#7a8794;"></p>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
        <button type="button" data-act="cancel" style="border:1px solid #d0d7de;background:#fff;color:#1f3344;border-radius:6px;padding:6px 10px;cursor:pointer;">取消</button>
        <button type="button" data-act="confirm" style="border:1px solid #0969da;background:#0969da;color:#fff;border-radius:6px;padding:6px 10px;cursor:pointer;">创建</button>
      </div>
    `;
    mask.appendChild(dialog);
    document.body.appendChild(mask);

    const nameInput = dialog.querySelector('#header-group-name-input');
    const pickerEl = dialog.querySelector('#header-group-icon-picker');
    const msgEl = dialog.querySelector('#header-group-dialog-msg');
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
        return `<button type="button" class="header-group-icon-option${selected}" data-icon="${icon}" title="${icon}" aria-label="${icon}">${lucideIconMarkup(icon)}</button>`;
      }).join('');
      if (typeof window.refreshLucideIcons === 'function') window.refreshLucideIcons();
      pickerEl.querySelectorAll('.header-group-icon-option').forEach((btn) => {
        btn.addEventListener('click', () => {
          selectedIcon = btn.getAttribute('data-icon') || 'folder';
          renderIconPicker();
        });
      });
    }

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
      confirmBtn.disabled = true;
      confirmBtn.textContent = '创建中...';
      msgEl.textContent = '';
      try {
        const res = await fetch(`${API_BASE_URL}/feed-subscriptions/groups`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: cleanName, icon: selectedIcon }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '创建分组失败');
        closeDialog();
        headerToast('分组已创建', false);
        window.dispatchEvent(new CustomEvent('feedgen:group-created', { detail: { group: data.group } }));
      } catch (error) {
        msgEl.textContent = error.message || '创建分组失败';
        confirmBtn.disabled = false;
        confirmBtn.textContent = '创建';
      }
    });

    nameInput.focus();
  }

  function bindSidebarCreateMenu() {
    const btn = mountEl.querySelector('#sidebar-create-menu-btn');
    const menu = mountEl.querySelector('#sidebar-create-menu');
    if (!(btn instanceof HTMLButtonElement) || !(menu instanceof HTMLElement)) return;

    function closeMenu() {
      menu.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    }

    function toggleMenu() {
      const willOpen = menu.classList.contains('hidden');
      if (willOpen) {
        menu.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
        if (typeof window.refreshLucideIcons === 'function') window.refreshLucideIcons();
      } else {
        closeMenu();
      }
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleMenu();
    });

    menu.querySelectorAll('[data-create-action]').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const action = item.getAttribute('data-create-action');
        closeMenu();
        if (action === 'add-feed') {
          if (typeof window.openAddFeedDialog === 'function') {
            window.openAddFeedDialog();
          } else {
            window.location.href = 'article-reader.html?addFeed=1';
          }
          return;
        }
        if (action === 'add-crawler') {
          window.location.href = 'visual-parser.html';
          return;
        }
        if (action === 'add-group') {
          openAddGroupDialog();
        }
      });
    });

    document.addEventListener('click', (e) => {
      if (menu.classList.contains('hidden')) return;
      const target = e.target;
      if (target instanceof Node && (btn.contains(target) || menu.contains(target))) return;
      closeMenu();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });
  }

  const pageConfig = {
    'index.html': {
      leftLinks: [
        { href: 'article-reader.html', label: '文章阅读' },
        { href: 'my-feeds.html', label: '我的feeds' },
        { href: 'crawler-strategy.html', label: '爬虫策略' },
        { href: 'membership.html', label: '会员' },
        { href: 'settings.html', label: '设置' },
        { href: 'admin.html', label: '管理后台' },
      ],
      includeUserInfo: true,
    },
    'profile.html': {
      leftLinks: [
        { href: 'article-reader.html', label: '文章阅读' },
        { href: 'my-feeds.html', label: '我的feeds' },
        { href: 'crawler-strategy.html', label: '爬虫策略' },
        { href: 'membership.html', label: '会员' },
        { href: 'settings.html', label: '设置' },
        { href: 'admin.html', label: '管理后台' },
      ],
      rightLinks: [],
    },
    'admin.html': {
      leftLinks: [
        { href: 'article-reader.html', label: '文章阅读' },
        { href: 'my-feeds.html', label: '我的feeds' },
        { href: 'membership.html', label: '会员' },
        { href: 'settings.html', label: '设置' },
        { href: 'admin.html', label: '管理后台', active: true },
      ],
      includeUserInfo: true,
    },
    'visual-parser.html': {
      leftLinks: [
        { href: 'article-reader.html', label: '文章阅读' },
        { href: 'my-feeds.html', label: '我的feeds' },
        { href: 'membership.html', label: '会员' },
        { href: 'settings.html', label: '设置' },
        { href: 'admin.html', label: '管理后台' },
      ],
      includeUserInfo: true,
    },
    'my-feeds.html': {
      leftLinks: [
        { href: 'article-reader.html', label: '文章阅读' },
        { href: 'my-feeds.html', label: '我的feeds', active: true },
        { href: 'crawler-strategy.html', label: '爬虫策略' },
        { href: 'membership.html', label: '会员' },
        { href: 'settings.html', label: '设置' },
        { href: 'admin.html', label: '管理后台' },
      ],
      includeUserInfo: true,
    },
    'crawler-strategy.html': {
      leftLinks: [
        { href: 'article-reader.html', label: '文章阅读' },
        { href: 'my-feeds.html', label: '我的feeds' },
        { href: 'crawler-strategy.html', label: '爬虫策略', active: true },
        { href: 'membership.html', label: '会员' },
        { href: 'settings.html', label: '设置' },
        { href: 'admin.html', label: '管理后台' },
      ],
      includeUserInfo: true,
    },
    'article-reader.html': {
      leftLinks: [
        { href: 'article-reader.html', label: '文章阅读', active: true },
        { href: 'my-feeds.html', label: '我的feeds' },
        { href: 'membership.html', label: '会员' },
        { href: 'settings.html', label: '设置' },
        { href: 'admin.html', label: '管理后台' },
      ],
      includeUserInfo: true,
    },
    'login.html': {
      leftLinks: [
        { href: 'article-reader.html', label: '文章阅读' },
        { href: 'my-feeds.html', label: '我的feeds' },
        { href: 'membership.html', label: '会员' },
        { href: 'settings.html', label: '设置' },
        { href: 'admin.html', label: '管理后台' },
      ],
      rightLinks: [],
    },
    'register.html': {
      leftLinks: [
        { href: 'article-reader.html', label: '文章阅读' },
        { href: 'my-feeds.html', label: '我的feeds' },
        { href: 'membership.html', label: '会员' },
        { href: 'settings.html', label: '设置' },
        { href: 'admin.html', label: '管理后台' },
      ],
      rightLinks: [],
    },
    'membership.html': {
      leftLinks: [
        { href: 'article-reader.html', label: '文章阅读' },
        { href: 'my-feeds.html', label: '我的feeds' },
        { href: 'membership.html', label: '会员', active: true },
        { href: 'settings.html', label: '设置' },
        { href: 'admin.html', label: '管理后台' },
      ],
      includeUserInfo: false,
    },
    'settings.html': {
      leftLinks: [
        { href: 'article-reader.html', label: '文章阅读' },
        { href: 'my-feeds.html', label: '我的feeds' },
        { href: 'membership.html', label: '会员' },
        { href: 'settings.html', label: '设置', active: true },
        { href: 'admin.html', label: '管理后台' },
      ],
      includeUserInfo: true,
    },
  };

  const config = pageConfig[page] || pageConfig['index.html'];
  const leftLinks = config.leftLinks || [];
  const rightLinks = config.rightLinks || [];
  const includeUserInfo = Boolean(config.includeUserInfo);

  const feedPanelToggleHtml =
    page === 'article-reader.html'
      ? `<button
          type="button"
          id="reader-feed-panel-toggle-btn"
          class="nav-link nav-action-btn"
          title="关闭feed面板"
          aria-label="关闭feed面板"
          aria-expanded="true"
        >
          ${lucideIconMarkup('panel-left-close')}
        </button>`
      : '';

  const linksHtml = leftLinks
    .map((item) => {
      const active = item.active ? ' active' : '';
      const iconName = leftNavLucideByHref[item.href] || 'layout-grid';
      return `
        <a href="${item.href}" class="nav-link${active}" title="${item.label}" aria-label="${item.label}">
          ${lucideIconMarkup(iconName)}
        </a>
      `;
    })
    .join('');

  const rightContent = includeUserInfo
    ? '<div class="user-info" id="user-info"></div>'
    : rightLinks
        .map((item) => `<a href="${item.href}" class="nav-link">${item.label}</a>`)
        .join('');

  mountEl.innerHTML = `
    <nav class="sidebar">
      <div class="sidebar-top">
        ${feedPanelToggleHtml}
        <div class="sidebar-logo-wrap">
          <button
            type="button"
            id="sidebar-create-menu-btn"
            class="logo nav-link nav-action-btn"
            title="新建"
            aria-label="新建"
            aria-haspopup="menu"
            aria-expanded="false"
          >
            ${lucideIconMarkup('square-plus')}
          </button>
          <div id="sidebar-create-menu" class="sidebar-create-menu hidden" role="menu" aria-label="新建菜单">
            <button type="button" class="sidebar-create-menu-item" role="menuitem" data-create-action="add-feed">
              ${lucideIconMarkup('rss')}
              <span>添加 Feed</span>
            </button>
            <button type="button" class="sidebar-create-menu-item" role="menuitem" data-create-action="add-crawler">
              ${lucideIconMarkup('wand')}
              <span>添加爬虫</span>
            </button>
            <button type="button" class="sidebar-create-menu-item" role="menuitem" data-create-action="add-group">
              ${lucideIconMarkup('folder-plus')}
              <span>添加组</span>
            </button>
          </div>
        </div>
        <div class="nav-links">${linksHtml}</div>
      </div>
      <div class="sidebar-bottom">
        <div class="nav-right sidebar-user">${rightContent}</div>
      </div>
    </nav>
  `;

  // 兜底渲染用户区：确保无页面脚本时（如 admin）也有 user/logout 图标。
  if (includeUserInfo) {
    const userInfoEl = mountEl.querySelector('#user-info');
    if (userInfoEl && !userInfoEl.innerHTML.trim()) {
      const token = localStorage.getItem('anonymousUserToken');
      const userId = localStorage.getItem('anonymousUserId');
      if (token && userId) {
        userInfoEl.innerHTML = `
          <a href="profile.html" class="user-nav-lucide" title="个人中心" aria-label="个人中心">
            <span class="nav-icon"><i data-lucide="user"></i></span>
          </a>
          <a href="#" class="user-nav-lucide" id="header-logout-link" title="注销" aria-label="注销">
            <span class="nav-icon"><i data-lucide="log-out"></i></span>
          </a>
        `;
        const logoutLink = userInfoEl.querySelector('#header-logout-link');
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
      } else {
        userInfoEl.innerHTML = `
          <a href="register.html" id="register-link" class="user-nav-lucide" title="注册" aria-label="注册"><span class="nav-icon"><i data-lucide="user-plus"></i></span></a>
          <a href="login.html" id="login-link" class="user-nav-lucide" title="登录" aria-label="登录"><span class="nav-icon"><i data-lucide="user"></i></span></a>
        `;
      }
    }
    if (typeof window.refreshLucideIcons === 'function') {
      window.refreshLucideIcons();
    }
  }

  bindSidebarCreateMenu();
  if (typeof window.refreshLucideIcons === 'function') {
    window.refreshLucideIcons();
  }
})();

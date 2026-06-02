(() => {
  const page = (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const mountEl = document.getElementById('global-header');
  if (!mountEl) return;

  /** 左侧主导航：按链接 href 映射 Lucide 图标名（kebab-case）ddd */
  const leftNavLucideByHref = {
    'my-feeds.html': 'cast',
    'article-reader.html': 'book-open',
    'visual-parser.html': 'wand',
    'crawler-strategy.html': 'activity',
    'membership.html': 'gem',
    'settings.html': 'settings',
    'admin.html': 'monitor-cog',
  };

  function lucideIconMarkup(iconName) {
    const name = String(iconName || 'circle').trim();
    return `<span class="nav-icon"><i data-lucide="${name}"></i></span>`;
  }

  const pageConfig = {
    'index.html': {
      leftLinks: [
        { href: 'article-reader.html', label: '文章阅读' },
        { href: 'my-feeds.html', label: '我的feeds' },
        { href: 'visual-parser.html', label: '可视化解析' },
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
        { href: 'visual-parser.html', label: '可视化解析' },
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
        { href: 'visual-parser.html', label: '可视化解析' },
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
        { href: 'visual-parser.html', label: '可视化解析', active: true },
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
        { href: 'visual-parser.html', label: '可视化解析' },
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
        { href: 'visual-parser.html', label: '可视化解析' },
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
        { href: 'visual-parser.html', label: '可视化解析' },
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
        { href: 'visual-parser.html', label: '可视化解析' },
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
        { href: 'visual-parser.html', label: '可视化解析' },
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
        { href: 'visual-parser.html', label: '可视化解析' },
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
        { href: 'visual-parser.html', label: '可视化解析' },
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

  const linksHtml = leftLinks
    .map((item) => {
      const active = item.active ? ' active' : '';
      const iconName = leftNavLucideByHref[item.href] || 'layout-grid';
      const linkHtml = `
        <a href="${item.href}" class="nav-link${active}" title="${item.label}" aria-label="${item.label}">
          ${lucideIconMarkup(iconName)}
        </a>
      `;
      if (page === 'article-reader.html' && item.href === 'article-reader.html') {
        return `${linkHtml}
        <button
          type="button"
          id="reader-feed-panel-toggle-btn"
          class="nav-link nav-action-btn"
          title="切换文章面板"
          aria-label="切换文章面板"
          aria-expanded="false"
        >
          ${lucideIconMarkup('layout-panel-left')}
        </button>
      `;
      }
      return linkHtml;
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
        <a href="index.html" class="logo nav-link" title="FeedGen 首页" aria-label="FeedGen 首页">
          ${lucideIconMarkup('plus')}
        </a>
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
})();

// DOM元素
const pageUrlInput = document.getElementById('page-url');
const createFeedBtn = document.getElementById('create-feed-btn');
const resultSection = document.getElementById('result-section');
const loadingSection = document.getElementById('loading-section');
const errorSection = document.getElementById('error-section');
const feedUrlElement = document.getElementById('feed-url');
const copyUrlBtn = document.getElementById('copy-url-btn');
const errorTextElement = document.getElementById('error-text');
const retryBtn = document.getElementById('retry-btn');

// 登录态信息（沿用现有 localStorage key，避免影响其他页面）
let anonymousUserToken = localStorage.getItem('anonymousUserToken');
let anonymousUserId = localStorage.getItem('anonymousUserId');

const ANON_USERNAME_KEY = 'anonymousUsername';
/** 勾选「记住登录」后保存，用于下次打开页面自动 POST /auth/login */
const REMEMBER_LOGIN_KEY = 'feedgen_auto_login';

/** 使用本地保存的账号密码尝试登录，成功则写入 token */
async function tryAutoLoginFromRemembered() {
  const raw = localStorage.getItem(REMEMBER_LOGIN_KEY);
  if (!raw) return false;
  let cred;
  try {
    cred = JSON.parse(raw);
  } catch {
    localStorage.removeItem(REMEMBER_LOGIN_KEY);
    return false;
  }
  if (!cred || typeof cred.username !== 'string' || typeof cred.password !== 'string') {
    return false;
  }
  try {
    const res = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: cred.username.trim(), password: cred.password }),
    });
    const data = await res.json();
    if (!res.ok) return false;
    anonymousUserToken = data.token;
    anonymousUserId = String(data.user.id);
    localStorage.setItem('anonymousUserToken', anonymousUserToken);
    localStorage.setItem('anonymousUserId', anonymousUserId);
    if (data.user.username) {
      localStorage.setItem(ANON_USERNAME_KEY, data.user.username);
    }
    return true;
  } catch {
    return false;
  }
}

/** 从 JWT payload 读取 username（仅展示用，不做鉴权） */
function readUsernameFromToken(token) {
  if (!token || typeof token !== 'string') return '';
  const parts = token.split('.');
  if (parts.length !== 3) return '';
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const json = JSON.parse(atob(b64));
    return typeof json.username === 'string' && json.username ? json.username : '';
  } catch {
    return '';
  }
}

/** 解析得到展示用用户名：优先 localStorage，其次 JWT，并回写 localStorage */
function resolveGuestUsername(token) {
  let uname = localStorage.getItem(ANON_USERNAME_KEY) || '';
  if (!uname && token) {
    uname = readUsernameFromToken(token);
    if (uname) localStorage.setItem(ANON_USERNAME_KEY, uname);
  }
  return uname;
}

// 页面加载：优先「记住登录」自动登录；若未登录，仅显示登录入口
document.addEventListener('DOMContentLoaded', () => {
  anonymousUserToken = localStorage.getItem('anonymousUserToken');
  anonymousUserId = localStorage.getItem('anonymousUserId');

  updateUserInfoDisplay();

  (async () => {
    try {
      const loggedIn = await tryAutoLoginFromRemembered();
      if (loggedIn) {
        updateUserInfoDisplay();
        syncGuestUsernameFromServer();
        return;
      }

      updateUserInfoDisplay();
      if (anonymousUserToken && anonymousUserId) {
        syncGuestUsernameFromServer();
      }
    } catch (err) {
      console.error('init session', err);
      updateUserInfoDisplay();
    }
  })();
});

// 从 /auth/me 拉取数据库中的 username 并刷新导航栏
async function syncGuestUsernameFromServer() {
  try {
    const token = localStorage.getItem('anonymousUserToken');
    if (!token) return;
    const response = await fetch(`${API_BASE_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (response.ok && data.user && data.user.username) {
      const u = String(data.user.username);
      localStorage.setItem(ANON_USERNAME_KEY, u);
      updateUserInfoDisplay(u);
    }
  } catch (_) {
    /* 忽略网络错误，仍显示「游客」 */
  }
}

/** 清空节点子元素（兼容无 replaceChildren 的环境） */
function clearEl(el) {
  if (el.replaceChildren) {
    el.replaceChildren();
  } else {
    while (el.firstChild) el.removeChild(el.firstChild);
  }
}

/**
 * 更新 #user-info
 * @param {string} [usernameFromDb] 若传入（如刚创建匿名用户或 /me 返回），优先展示并写入 localStorage
 */
function updateUserInfoDisplay(usernameFromDb) {
  const userInfoElement = document.getElementById('user-info');
  if (!userInfoElement) return;

  const token = localStorage.getItem('anonymousUserToken');
  const userId = localStorage.getItem('anonymousUserId');
  anonymousUserToken = token;
  anonymousUserId = userId;

  if (token && userId) {
    let uname = '';
    if (usernameFromDb != null && String(usernameFromDb).trim() !== '') {
      uname = String(usernameFromDb).trim();
      localStorage.setItem(ANON_USERNAME_KEY, uname);
    } else {
      uname = resolveGuestUsername(token);
    }

    clearEl(userInfoElement);
    const wrap = document.createElement('span');
    wrap.className = 'guest-nav-label';
    wrap.appendChild(document.createTextNode('用户'));
    if (uname) {
      wrap.appendChild(document.createTextNode('（'));
      const nameEl = document.createElement('a');
      nameEl.href = 'profile.html';
      nameEl.className = 'guest-username guest-username-link';
      nameEl.setAttribute('aria-label', '修改账户资料');
      nameEl.textContent = uname;
      wrap.appendChild(nameEl);
      wrap.appendChild(document.createTextNode('）'));
    }
    const profileLink = document.createElement('a');
    profileLink.href = 'profile.html';
    profileLink.className = 'user-nav-lucide';
    profileLink.title = '个人中心';
    profileLink.setAttribute('aria-label', '个人中心');
    profileLink.innerHTML = '<span class="nav-icon"><i data-lucide="user"></i></span>';

    const logoutLink = document.createElement('a');
    logoutLink.href = '#';
    logoutLink.id = 'logout-link';
    logoutLink.className = 'user-nav-lucide';
    logoutLink.title = '注销';
    logoutLink.setAttribute('aria-label', '注销');
    logoutLink.innerHTML = '<span class="nav-icon"><i data-lucide="log-out"></i></span>';
    logoutLink.addEventListener('click', (e) => {
      e.preventDefault();
      logout();
    });
    userInfoElement.append(wrap, profileLink, logoutLink);
  } else {
    // 如果未登录，显示注册与登录入口
    userInfoElement.innerHTML = `
      <a href="register.html" id="register-link" class="user-nav-lucide" title="注册" aria-label="注册"><span class="nav-icon"><i data-lucide="user-plus"></i></span></a>
      <a href="login.html" id="login-link" class="user-nav-lucide" title="登录" aria-label="登录"><span class="nav-icon"><i data-lucide="user"></i></span></a>
    `;
  }
  if (typeof window.refreshLucideIcons === 'function') {
    window.refreshLucideIcons();
  }
}

// 注销功能
function logout() {
  // 清除本地存储的用户信息
  localStorage.removeItem('anonymousUserToken');
  localStorage.removeItem('anonymousUserId');
  localStorage.removeItem(ANON_USERNAME_KEY);
  localStorage.removeItem(REMEMBER_LOGIN_KEY);

  // 重置变量
  anonymousUserToken = null;
  anonymousUserId = null;
  
  // 更新UI显示
  updateUserInfoDisplay();
}

// 创建Feed
async function createFeed() {
  const pageUrl = pageUrlInput.value.trim();
  
  if (!pageUrl) {
    showError('请输入有效的网页URL');
    return;
  }
  
  if (!isValidUrl(pageUrl)) {
    showError('请输入有效的URL格式');
    return;
  }

  if (!anonymousUserToken || !anonymousUserId) {
    showError('请先登录后再创建 Feed');
    setTimeout(() => {
      window.location.href = 'login.html';
    }, 600);
    return;
  }
  
  // 对于特定网站，执行智能解析
  if (pageUrl.includes('aibase.com')) {
    await analyzePageStructure(pageUrl);
  } else {
    // 对于其他网站，使用原有逻辑
    try {
      showLoading();
      
      // 使用匿名用户token创建Feed
      const response = await fetch(`${API_BASE_URL}/feeds`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${anonymousUserToken}`
        },
        body: JSON.stringify({
          name: `Feed from ${extractDomain(pageUrl)}`,
          targetUrl: pageUrl,
          description: `Auto-generated feed for ${pageUrl}`
        })
      });
      
      const data = await response.json();
      
      if (response.ok) {
        // 显示结果
        const feedId = data.feed.id;
        const feedUrl = `${window.location.protocol}//${window.location.hostname}:3000/api/feeds/${feedId}/rss`;
        feedUrlElement.textContent = feedUrl;
        showResult(feedUrl);
        
        // 如果是特定网站，自动爬取内容
        if (pageUrl.includes('www.aibase.com')) {
          await extractAndSaveArticles(pageUrl, feedId, anonymousUserToken);
        }
      } else {
        throw new Error(data.error || '创建Feed失败');
      }
    } catch (error) {
      showError(error.message);
    }
  }
}

// 提取并保存文章内容
async function extractAndSaveArticles(baseUrl, feedId, token) {
  try {
    // 发送请求到后端进行网页抓取和解析
    const response = await fetch(`${API_BASE_URL}/feeds/${feedId}/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        url: baseUrl,
        selectors: {
          container: 'flex group justify-between md:flex-row flex-col-reverse hover:bg-[#F0F3FA] rounded-lg md:p-4 py-2 px-0 group',
          title: 'h3',
          description: '.text-[15px].line-clamp-2.text-surface-500'
        }
      })
    });
    
    const result = await response.json();
    
    if (response.ok) {
      console.log(`成功提取并保存了 ${result.articles.length} 篇文章`);
    } else {
      console.error('提取文章失败:', result.error);
    }
  } catch (error) {
    console.error('提取文章过程中发生错误:', error);
  }
}

// 自动检测选择器规则
function detectItemSelector() {
  // 常见的文章/新闻项目选择器
  return [
    '.post', '.article', '.entry', '.story', '.news-item',
    '.list-item', '.item', '.card', '.media', '.panel',
    '[class*="post"]', '[class*="article"]', '[class*="news"]',
    '[class*="item"]', '[class*="entry"]'
  ].join(', ');
}

function detectTitleSelector() {
  // 常见的标题选择器
  return [
    'h1', 'h2', 'h3', '.title', '.headline', '.post-title',
    '.entry-title', '.article-title', '[class*="title"]',
    '[class*="headline"]', '[class*="heading"]'
  ].join(', ');
}

function detectLinkSelector() {
  // 常见的链接选择器
  return [
    'a[href]', '.link', '[class*="link"]', 'a:has(h1)', 'a:has(h2)',
    'a:has(h3)', '.more-link', '.read-more', '[class*="more"]'
  ].join(', ');
}

function detectDescriptionSelector() {
  // 常见的描述选择器
  return [
    '.excerpt', '.summary', '.description', '.content', '.text',
    'p', '[class*="excerpt"]', '[class*="summary"]', '[class*="desc"]'
  ].join(', ');
}

function detectDateSelector() {
  // 常见的日期选择器
  return [
    'time', '.date', '.published', '.updated', '[class*="date"]',
    '[class*="time"]', '[class*="publish"]'
  ].join(', ');
}

// 提取域名
function extractDomain(url) {
  try {
    const domain = new URL(url).hostname.replace('www.', '');
    return domain.charAt(0).toUpperCase() + domain.slice(1);
  } catch (e) {
    return 'Unknown';
  }
}

// 验证URL格式
function isValidUrl(string) {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

// 事件监听器
createFeedBtn.addEventListener('click', function() {
  const pageUrl = pageUrlInput.value.trim();
  
  if (!pageUrl) {
    showError('请输入有效的网页URL');
    return;
  }
  
  if (!isValidUrl(pageUrl)) {
    showError('请输入有效的URL格式');
    return;
  }
  
  // 直接跳转到可视化解析页面
  window.location.href = `visual-parser.html?url=${encodeURIComponent(pageUrl)}`;
});

copyUrlBtn.addEventListener('click', () => {
  const feedUrl = feedUrlElement.textContent;
  navigator.clipboard.writeText(feedUrl)
    .then(() => {
      // 临时改变按钮文本
      const originalText = copyUrlBtn.textContent;
      copyUrlBtn.textContent = '已复制!';
      setTimeout(() => {
        copyUrlBtn.textContent = originalText;
      }, 2000);
    })
    .catch(err => {
      console.error('复制失败:', err);
      alert('复制失败，请手动复制URL');
    });
});

retryBtn.addEventListener('click', () => {
  hideError();
  createFeed();
});

// 显示/隐藏UI函数
function showLoading() {
  loadingSection.classList.remove('hidden');
  resultSection.classList.add('hidden');
  errorSection.classList.add('hidden');
  createFeedBtn.disabled = true;
}

function hideLoading() {
  loadingSection.classList.add('hidden');
  createFeedBtn.disabled = false;
}

function showResult(feedUrl) {
  hideLoading();
  resultSection.classList.remove('hidden');
  errorSection.classList.add('hidden');
}

function showError(message) {
  hideLoading();
  errorTextElement.textContent = message;
  errorSection.classList.remove('hidden');
  resultSection.classList.add('hidden');
}

function hideError() {
  errorSection.classList.add('hidden');
}

// 输入框回车事件
pageUrlInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    createFeed();
  }
});

// 智能解析页面结构
async function analyzePageStructure(url) {
  try {
    showAnalysisSection();
    
    const response = await fetch(`${API_BASE_URL}/feeds/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${anonymousUserToken}`
      },
      body: JSON.stringify({ url })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      showSelectorOptions(data.selectors);
    } else {
      throw new Error(data.error || '页面分析失败');
    }
  } catch (error) {
    showError(error.message);
  }
}

// 显示分析进度界面
function showAnalysisSection() {
  document.getElementById('analysis-section').classList.remove('hidden');
  document.getElementById('selector-section').classList.add('hidden');
  resultSection.classList.add('hidden');
  errorSection.classList.add('hidden');
  createFeedBtn.disabled = true;
}

// 显示选择器选项
function showSelectorOptions(selectors) {
  const analysisSection = document.getElementById('analysis-section');
  const selectorSection = document.getElementById('selector-section');
  const container = document.getElementById('selector-options-container');
  
  analysisSection.classList.add('hidden');
  selectorSection.classList.remove('hidden');
  
  // 清空容器
  container.innerHTML = '';
  
  // 为每个选择器选项创建UI
  selectors.forEach((option, index) => {
    const optionElement = document.createElement('div');
    optionElement.className = 'selector-option';
    optionElement.innerHTML = `
      <div class="selector-option-header">
        <div class="selector-option-title">${option.name}</div>
        <div class="selector-option-count">${option.count} 个项目</div>
      </div>
      <div class="selector-option-preview">
        ${option.preview.map(item => `
          <div class="preview-item">
            <div class="preview-title">${item.title}</div>
            <div class="preview-desc">${item.description}</div>
          </div>
        `).join('')}
      </div>
      <button class="select-btn" onclick="selectOption(${index})">选择此列表</button>
    `;
    
    container.appendChild(optionElement);
  });
}

// 选择某个选项
function selectOption(index) {
  // 这里可以处理用户选择的选项
  // 暂时模拟选择后的操作
  const selectedOption = document.querySelectorAll('.selector-option')[index];
  selectedOption.classList.add('selected');
  
  // 禁用其他按钮
  document.querySelectorAll('.select-btn').forEach((btn, i) => {
    if (i !== index) {
      btn.disabled = true;
    }
  });
  
  // 模拟创建feed的过程
  setTimeout(() => {
    // 这里应该调用实际的创建feed API
    createFeedFromSelection(index);
  }, 1000);
}

// 根据选择创建Feed
async function createFeedFromSelection(optionIndex) {
  const pageUrl = pageUrlInput.value.trim();
  
  try {
    showLoading();
    
    // 使用匿名用户token创建Feed
    const response = await fetch(`${API_BASE_URL}/feeds`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${anonymousUserToken}`
      },
      body: JSON.stringify({
        name: `Feed from ${extractDomain(pageUrl)}`,
        targetUrl: pageUrl,
        description: `Auto-generated feed for ${pageUrl}`
      })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      // 显示结果
      const feedId = data.feed.id;
      const feedUrl = `${window.location.protocol}//${window.location.hostname}:3000/api/feeds/${feedId}/rss`;
      feedUrlElement.textContent = feedUrl;
      showResult(feedUrl);
      
      // 使用选择的选项配置爬取规则
      // 这里可以发送请求到后端使用选定的选择器规则爬取内容
      await applySelectorRules(pageUrl, feedId, optionIndex);
    } else {
      throw new Error(data.error || '创建Feed失败');
    }
  } catch (error) {
    showError(error.message);
  }
}

// 应用选择器规则
async function applySelectorRules(baseUrl, feedId, optionIndex) {
  try {
    // 发送请求到后端应用选择器规则并爬取内容
    const response = await fetch(`${API_BASE_URL}/feeds/${feedId}/apply-selectors`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${anonymousUserToken}`
      },
      body: JSON.stringify({
        url: baseUrl,
        optionIndex: optionIndex
      })
    });
    
    const result = await response.json();
    
    if (response.ok) {
      console.log(`成功应用选择器规则并保存了 ${result.articles.length} 篇文章`);
    } else {
      console.error('应用选择器规则失败:', result.error);
    }
  } catch (error) {
    console.error('应用选择器规则过程中发生错误:', error);
  }
}

const ANON_USERNAME_KEY = 'anonymousUsername';
const REMEMBER_LOGIN_KEY = 'feedgen_auto_login';

function collectBrowserFingerprint() {
  try {
    return {
      collectedAt: new Date().toISOString(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      language: typeof navigator !== 'undefined' ? navigator.language : '',
      languages: typeof navigator !== 'undefined' ? navigator.languages : [],
      platform: typeof navigator !== 'undefined' ? navigator.platform : '',
      cookieEnabled: typeof navigator !== 'undefined' ? navigator.cookieEnabled : false,
      timezone:
        typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : '',
      screen: typeof screen !== 'undefined' ? { w: screen.width, h: screen.height } : null,
      localStorage: typeof localStorage !== 'undefined',
      documentCookie: typeof document !== 'undefined' ? document.cookie.length : 0,
    };
  } catch {
    return { collectedAt: new Date().toISOString(), error: 'fingerprint_failed' };
  }
}

/** 聚合设置页：未登录不整页跳转，仅禁用帐号表单；带 #profile-stay-after-save 时保存后不跳首页 */
const isSettingsPage = document.body && document.body.classList.contains('settings-page');

async function loadProfile() {
  const token = localStorage.getItem('anonymousUserToken');
  if (!token) {
    if (isSettingsPage) {
      const form = document.getElementById('profile-form');
      const msg = document.getElementById('profile-msg');
      if (form) {
        form.querySelectorAll('input, button, textarea').forEach((el) => {
          if (el.id === 'profile-stay-after-save') return;
          el.disabled = true;
        });
      }
      if (msg) {
        msg.textContent = '请登录后编辑帐号信息';
        msg.classList.add('error');
      }
      return;
    }
    window.location.href = 'login.html';
    return;
  }
  try {
    const res = await fetch(`${API_BASE_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) {
      if (isSettingsPage) {
        const msg = document.getElementById('profile-msg');
        if (msg) {
          msg.textContent = '无法加载帐号信息，请重新登录';
          msg.classList.add('error');
        }
        return;
      }
      window.location.href = 'login.html';
      return;
    }
    document.getElementById('profile-username').value = data.user.username || '';
    document.getElementById('profile-email').value = data.user.email || '';
    if (isSettingsPage) {
      const form = document.getElementById('profile-form');
      if (form) {
        form.querySelectorAll('input, button, textarea').forEach((el) => {
          if (el.id === 'profile-stay-after-save') return;
          el.disabled = false;
        });
      }
      const msg = document.getElementById('profile-msg');
      if (msg && msg.classList.contains('error')) {
        msg.textContent = '';
        msg.classList.remove('error');
      }
    }
  } catch {
    if (isSettingsPage) {
      const msg = document.getElementById('profile-msg');
      if (msg) {
        msg.textContent = '网络错误，请稍后重试';
        msg.classList.add('error');
      }
      return;
    }
    window.location.href = 'login.html';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadProfile();

  document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msgEl = document.getElementById('profile-msg');
    msgEl.textContent = '';
    msgEl.classList.remove('error', 'ok');

    const token = localStorage.getItem('anonymousUserToken');
    if (!token) {
      window.location.href = 'login.html';
      return;
    }

    const username = document.getElementById('profile-username').value.trim();
    const email = document.getElementById('profile-email').value.trim();
    const p1 = document.getElementById('profile-password').value;
    const p2 = document.getElementById('profile-password2').value;
    const remember = document.getElementById('profile-remember').checked;

    if (!username || !email) {
      msgEl.textContent = '请填写用户名与邮箱';
      msgEl.classList.add('error');
      return;
    }

    if (p1 || p2) {
      if (p1 !== p2) {
        msgEl.textContent = '两次密码不一致';
        msgEl.classList.add('error');
        return;
      }
      if (p1.length < 6) {
        msgEl.textContent = '密码至少 6 位';
        msgEl.classList.add('error');
        return;
      }
    }

    const body = {
      username,
      email,
      browser_fingerprint: collectBrowserFingerprint(),
    };
    if (p1) body.password = p1;

    try {
      const res = await fetch(`${API_BASE_URL}/auth/profile`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        msgEl.textContent = data.error || '保存失败';
        msgEl.classList.add('error');
        return;
      }

      localStorage.setItem('anonymousUserToken', data.token);
      if (data.user && data.user.username) {
        localStorage.setItem(ANON_USERNAME_KEY, data.user.username);
      }

      if (remember && p1) {
        localStorage.setItem(
          REMEMBER_LOGIN_KEY,
          JSON.stringify({ username: data.user.username, password: p1 })
        );
      } else if (!remember) {
        localStorage.removeItem(REMEMBER_LOGIN_KEY);
      }

      const stayAfterSave = document.getElementById('profile-stay-after-save');
      if (stayAfterSave) {
        msgEl.textContent = '已保存';
        msgEl.classList.add('ok');
        await loadProfile();
        if (typeof window.refreshLucideIcons === 'function') window.refreshLucideIcons();
      } else {
        msgEl.textContent = '已保存，正在返回首页…';
        msgEl.classList.add('ok');
        setTimeout(() => {
          window.location.href = 'index.html';
        }, 800);
      }
    } catch (err) {
      msgEl.textContent = err.message || '网络错误';
      msgEl.classList.add('error');
    }
  });
});

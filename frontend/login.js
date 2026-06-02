const ANON_USERNAME_KEY = 'anonymousUsername';
const REMEMBER_LOGIN_KEY = 'feedgen_auto_login';

async function validateExistingSession() {
  const token = localStorage.getItem('anonymousUserToken');
  if (!token) return;
  try {
    const res = await fetch(`${API_BASE_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      window.location.href = 'article-reader.html';
    }
  } catch {
    // 忽略网络错误，允许用户继续手动登录
  }
}

function setMsg(text, isError) {
  const msgEl = document.getElementById('login-msg');
  msgEl.textContent = text || '';
  msgEl.classList.toggle('error', !!isError);
  msgEl.classList.toggle('ok', !isError && !!text);
}

document.addEventListener('DOMContentLoaded', async () => {
  await validateExistingSession();

  const formEl = document.getElementById('login-form');
  const usernameEl = document.getElementById('login-username');
  const passwordEl = document.getElementById('login-password');
  const rememberEl = document.getElementById('login-remember');
  const submitBtn = document.getElementById('login-submit');

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg('', false);

    const username = usernameEl.value.trim();
    const password = passwordEl.value;
    const remember = rememberEl.checked;

    if (!username || !password) {
      setMsg('请输入用户名和密码', true);
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = '登录中...';

    try {
      const res = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setMsg(data.error || '登录失败，请检查用户名和密码', true);
        return;
      }

      localStorage.setItem('anonymousUserToken', data.token);
      localStorage.setItem('anonymousUserId', String(data.user.id));
      localStorage.setItem(ANON_USERNAME_KEY, data.user.username || username);

      if (remember) {
        localStorage.setItem(REMEMBER_LOGIN_KEY, JSON.stringify({ username, password }));
      } else {
        localStorage.removeItem(REMEMBER_LOGIN_KEY);
      }

      setMsg('登录成功，正在跳转首页...', false);
      setTimeout(() => {
        window.location.href = 'article-reader.html';
      }, 450);
    } catch (err) {
      setMsg(err.message || '网络异常，请稍后重试', true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '登录';
    }
  });
});

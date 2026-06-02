const ANON_USERNAME_KEY = 'anonymousUsername';

function setMsg(text, isError) {
  const msgEl = document.getElementById('register-msg');
  msgEl.textContent = text || '';
  msgEl.classList.toggle('error', !!isError);
  msgEl.classList.toggle('ok', !isError && !!text);
}

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
    // 忽略网络错误，允许继续注册
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await validateExistingSession();

  const formEl = document.getElementById('register-form');
  const usernameEl = document.getElementById('register-username');
  const emailEl = document.getElementById('register-email');
  const passwordEl = document.getElementById('register-password');
  const submitBtn = document.getElementById('register-submit');

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg('', false);

    const username = usernameEl.value.trim();
    const email = emailEl.value.trim();
    const password = passwordEl.value;

    if (!username || !email || !password) {
      setMsg('请完整填写用户名、邮箱和密码', true);
      return;
    }
    if (password.length < 6) {
      setMsg('密码至少 6 位', true);
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = '注册中...';

    try {
      const res = await fetch(`${API_BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setMsg(data.error || '注册失败，请稍后重试', true);
        return;
      }

      if (data.token && data.user && data.user.id) {
        localStorage.setItem('anonymousUserToken', data.token);
        localStorage.setItem('anonymousUserId', String(data.user.id));
        localStorage.setItem(ANON_USERNAME_KEY, data.user.username || username);
      }

      setMsg('注册成功，正在进入首页...', false);
      setTimeout(() => {
        window.location.href = 'article-reader.html';
      }, 450);
    } catch (err) {
      setMsg(err.message || '网络异常，请稍后再试', true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '注册';
    }
  });
});

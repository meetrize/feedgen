/**
 * 设置页：多标签切换、URL hash 同步、通用设置读写 localStorage
 */
(function () {
  const TAB_KEYS = ['general', 'account', 'feeds', 'billing', 'ai'];

  const STORAGE = {
    lang: 'feedgen_ui_lang',
    crawlInterval: 'feedgen_pref_default_crawl_interval_sec',
    retentionDays: 'feedgen_pref_data_retention_days',
  };

  const DEFAULTS = {
    lang: 'zh-CN',
    crawlInterval: '1800',
    retentionDays: '30',
  };

  function readHashTab() {
    const h = (window.location.hash || '').replace(/^#/, '').toLowerCase();
    return TAB_KEYS.includes(h) ? h : 'general';
  }

  function showTab(key) {
    const k = TAB_KEYS.includes(key) ? key : 'general';

    document.querySelectorAll('[data-settings-tab]').forEach((btn) => {
      const active = btn.getAttribute('data-settings-tab') === k;
      btn.classList.toggle('settings-tab--active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    document.querySelectorAll('[data-settings-panel]').forEach((panel) => {
      const on = panel.getAttribute('data-settings-panel') === k;
      panel.classList.toggle('hidden', !on);
      panel.hidden = !on;
    });

    const hash = k === 'general' ? '' : `#${k}`;
    if (window.location.hash !== hash) {
      const name = (window.location.pathname.split('/').pop() || 'settings.html').split('?')[0];
      window.history.replaceState(null, '', `${name}${hash}`);
    }

    if (typeof window.refreshLucideIcons === 'function') {
      window.refreshLucideIcons();
    }

    if (k === 'ai') {
      loadTranslationToForm();
    }
  }

  function loadGeneralToForm() {
    const langEl = document.getElementById('settings-ui-lang');
    const crawlEl = document.getElementById('settings-crawl-interval');
    const retEl = document.getElementById('settings-retention-days');
    if (!langEl || !crawlEl || !retEl) return;

    langEl.value = localStorage.getItem(STORAGE.lang) || DEFAULTS.lang;
    crawlEl.value = localStorage.getItem(STORAGE.crawlInterval) || DEFAULTS.crawlInterval;
    retEl.value = localStorage.getItem(STORAGE.retentionDays) || DEFAULTS.retentionDays;

    document.documentElement.setAttribute('lang', langEl.value === 'en-US' ? 'en' : 'zh-CN');
  }

  function authHeaders() {
    const token = localStorage.getItem('anonymousUserToken');
    return token
      ? {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        }
      : null;
  }

  function setTranslationMsg(text, type) {
    const msgEl = document.getElementById('settings-translation-msg');
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.classList.remove('error', 'ok');
    if (text && type) msgEl.classList.add(type);
  }

  function setTranslationStatus(text) {
    const statusEl = document.getElementById('settings-translation-status');
    if (statusEl) statusEl.textContent = text || '';
  }

  function setTranslationFormDisabled(disabled, reason) {
    const form = document.getElementById('settings-translation-form');
    if (!form) return;
    form.querySelectorAll('input, select, button').forEach((el) => {
      el.disabled = disabled;
    });
    if (reason) setTranslationMsg(reason, 'error');
  }

  async function loadTranslationToForm() {
    const secretIdEl = document.getElementById('settings-tmt-secret-id');
    const secretKeyEl = document.getElementById('settings-tmt-secret-key');
    const regionEl = document.getElementById('settings-tmt-region');
    const enabledEl = document.getElementById('settings-tmt-enabled');
    const hintEl = document.getElementById('settings-tmt-secret-key-hint');
    if (!secretIdEl || !secretKeyEl || !regionEl || !enabledEl) return;

    const headers = authHeaders();
    if (!headers) {
      setTranslationFormDisabled(true, '请登录后配置腾讯翻译');
      setTranslationStatus('当前未登录');
      return;
    }

    try {
      const res = await fetch(`${API_BASE_URL}/settings/translation`, { headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTranslationFormDisabled(true, data.error || '无法加载翻译配置');
        return;
      }

      secretIdEl.value = data.secretId || '';
      secretKeyEl.value = '';
      secretKeyEl.placeholder = data.secretKeyMasked
        ? `已配置：${data.secretKeyMasked}（留空则保留）`
        : '腾讯云 API 密钥 SecretKey';
      regionEl.value = data.region || 'ap-guangzhou';
      enabledEl.checked = data.enabled !== false;

      if (hintEl) {
        hintEl.textContent = data.secretKeyMasked
          ? `当前密钥：${data.secretKeyMasked}。若不修改 SecretKey，保存时请留空。`
          : '请填写腾讯云 API 密钥 SecretKey。';
      }

      if (data.configured) {
        setTranslationStatus('你已配置个人腾讯翻译密钥');
      } else {
        setTranslationStatus('尚未配置你的腾讯翻译密钥');
      }

      setTranslationFormDisabled(false);
      setTranslationMsg('');
    } catch {
      setTranslationFormDisabled(true, '网络错误，无法加载翻译配置');
    }
  }

  async function saveTranslationFromForm() {
    const secretIdEl = document.getElementById('settings-tmt-secret-id');
    const secretKeyEl = document.getElementById('settings-tmt-secret-key');
    const regionEl = document.getElementById('settings-tmt-region');
    const enabledEl = document.getElementById('settings-tmt-enabled');
    if (!secretIdEl || !secretKeyEl || !regionEl || !enabledEl) return;

    const headers = authHeaders();
    if (!headers) {
      setTranslationMsg('请登录后保存', 'error');
      return;
    }

    setTranslationMsg('');

    const secretId = String(secretIdEl.value || '').trim();
    const secretKey = String(secretKeyEl.value || '').trim();
    const region = String(regionEl.value || 'ap-guangzhou').trim();
    const enabled = !!enabledEl.checked;

    if (!secretId) {
      setTranslationMsg('请填写 SecretId', 'error');
      return;
    }

    try {
      const res = await fetch(`${API_BASE_URL}/settings/translation`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ secretId, secretKey, region, enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTranslationMsg(data.error || '保存失败', 'error');
        return;
      }

      secretKeyEl.value = '';
      secretKeyEl.placeholder = data.secretKeyMasked
        ? `已配置：${data.secretKeyMasked}（留空则保留）`
        : '腾讯云 API 密钥 SecretKey';
      setTranslationStatus('你已配置个人腾讯翻译密钥');
      setTranslationMsg(data.message || '你的翻译配置已保存', 'ok');
    } catch {
      setTranslationMsg('网络错误，保存失败', 'error');
    }
  }

  async function testTranslationConfig() {
    const headers = authHeaders();
    if (!headers) {
      setTranslationMsg('请登录后测试', 'error');
      return;
    }

    setTranslationMsg('正在测试翻译接口…');

    try {
      const res = await fetch(`${API_BASE_URL}/settings/translation/test`, {
        method: 'POST',
        headers,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTranslationMsg(data.error || '测试失败', 'error');
        return;
      }
      setTranslationMsg(`测试成功：Hello → ${data.sample || '（无结果）'}`, 'ok');
    } catch {
      setTranslationMsg('网络错误，测试失败', 'error');
    }
  }

  function saveGeneralFromForm() {
    const msgEl = document.getElementById('settings-general-msg');
    const langEl = document.getElementById('settings-ui-lang');
    const crawlEl = document.getElementById('settings-crawl-interval');
    const retEl = document.getElementById('settings-retention-days');
    if (!msgEl || !langEl || !crawlEl || !retEl) return;

    msgEl.textContent = '';
    msgEl.classList.remove('error', 'ok');

    const lang = langEl.value || DEFAULTS.lang;
    const crawl = parseInt(String(crawlEl.value || '').trim(), 10);
    const ret = parseInt(String(retEl.value || '').trim(), 10);

    if (!Number.isFinite(crawl) || crawl < 60 || crawl > 604800) {
      msgEl.textContent = '爬虫频率须为 60～604800 之间的整数（秒）';
      msgEl.classList.add('error');
      return;
    }
    if (!Number.isFinite(ret) || ret < 1 || ret > 3650) {
      msgEl.textContent = '保存时间须为 1～3650 之间的整数（天）';
      msgEl.classList.add('error');
      return;
    }

    localStorage.setItem(STORAGE.lang, lang);
    localStorage.setItem(STORAGE.crawlInterval, String(crawl));
    localStorage.setItem(STORAGE.retentionDays, String(ret));

    document.documentElement.setAttribute('lang', lang === 'en-US' ? 'en' : 'zh-CN');

    msgEl.textContent = '通用设置已保存到本机';
    msgEl.classList.add('ok');
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-settings-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        showTab(btn.getAttribute('data-settings-tab'));
      });
    });

    window.addEventListener('hashchange', () => {
      showTab(readHashTab());
    });

    showTab(readHashTab());
    loadGeneralToForm();

    const generalForm = document.getElementById('settings-general-form');
    if (generalForm) {
      generalForm.addEventListener('submit', (e) => {
        e.preventDefault();
        saveGeneralFromForm();
      });
    }

    const langEl = document.getElementById('settings-ui-lang');
    if (langEl) {
      langEl.addEventListener('change', () => {
        const v = langEl.value;
        document.documentElement.setAttribute('lang', v === 'en-US' ? 'en' : 'zh-CN');
      });
    }

    const translationForm = document.getElementById('settings-translation-form');
    if (translationForm) {
      translationForm.addEventListener('submit', (e) => {
        e.preventDefault();
        saveTranslationFromForm();
      });
    }

    const translationTestBtn = document.getElementById('settings-translation-test');
    if (translationTestBtn) {
      translationTestBtn.addEventListener('click', () => {
        testTranslationConfig();
      });
    }

    if (readHashTab() === 'ai') {
      loadTranslationToForm();
    }
  });
})();

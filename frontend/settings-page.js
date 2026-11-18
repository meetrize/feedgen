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

  function normalizeTranslationProvider(value) {
    const v = String(value || '').trim().toLowerCase();
    if (v === 'mtran') return 'mtran';
    if (v === 'gemini') return 'gemini';
    if (v === 'openai' || v === 'openai_compat' || v === 'meo-bridge') return 'openai';
    if (v === 'index' || v === 'index_translate' || v === 'index-translate' || v === 'bilibili') {
      return 'index';
    }
    return 'tencent';
  }

  function translationStatusText(provider, data) {
    if (provider === 'mtran') {
      return `已配置本机 MTranServer：${data?.baseUrl || 'http://127.0.0.1:8989'}`;
    }
    if (provider === 'gemini') {
      return `已配置 Gemini（${data?.geminiModel || 'gemini-3.8-flash'}），经 7890 代理调用`;
    }
    if (provider === 'openai') {
      return `已配置 OpenAI 兼容：${data?.openaiModel || data?.secretId || 'bridge__deepseek'} @ ${data?.openaiBaseUrl || data?.baseUrl || 'http://192.168.31.60:3921/v1'}`;
    }
    if (provider === 'index') {
      return `已配置 Index-Translate：${data?.indexModel || data?.secretId || 'Index-Translate-2B'} @ ${data?.indexBaseUrl || data?.baseUrl || 'https://index-translate.bilibili.com/v1'}`;
    }
    return '你已配置个人腾讯翻译密钥';
  }

  function syncTranslationProviderFields(provider) {
    const normalized = normalizeTranslationProvider(provider);
    const tencentFields = document.getElementById('settings-translation-tencent-fields');
    const mtranFields = document.getElementById('settings-translation-mtran-fields');
    const geminiFields = document.getElementById('settings-translation-gemini-fields');
    const openaiFields = document.getElementById('settings-translation-openai-fields');
    const indexFields = document.getElementById('settings-translation-index-fields');
    if (tencentFields) tencentFields.classList.toggle('hidden', normalized !== 'tencent');
    if (mtranFields) mtranFields.classList.toggle('hidden', normalized !== 'mtran');
    if (geminiFields) geminiFields.classList.toggle('hidden', normalized !== 'gemini');
    if (openaiFields) openaiFields.classList.toggle('hidden', normalized !== 'openai');
    if (indexFields) indexFields.classList.toggle('hidden', normalized !== 'index');
  }

  async function loadTranslationToForm() {
    const providerEl = document.getElementById('settings-translation-provider');
    const secretIdEl = document.getElementById('settings-tmt-secret-id');
    const secretKeyEl = document.getElementById('settings-tmt-secret-key');
    const regionEl = document.getElementById('settings-tmt-region');
    const enabledEl = document.getElementById('settings-tmt-enabled');
    const hintEl = document.getElementById('settings-tmt-secret-key-hint');
    const baseUrlEl = document.getElementById('settings-mtran-base-url');
    const apiTokenEl = document.getElementById('settings-mtran-api-token');
    const apiTokenHintEl = document.getElementById('settings-mtran-api-token-hint');
    const geminiKeyEl = document.getElementById('settings-gemini-api-key');
    const geminiKeyHintEl = document.getElementById('settings-gemini-api-key-hint');
    const geminiModelLabelEl = document.getElementById('settings-gemini-model-label');
    const openaiBaseUrlEl = document.getElementById('settings-openai-base-url');
    const openaiKeyEl = document.getElementById('settings-openai-api-key');
    const openaiKeyHintEl = document.getElementById('settings-openai-api-key-hint');
    const openaiModelEl = document.getElementById('settings-openai-model');
    const indexBaseUrlEl = document.getElementById('settings-index-base-url');
    const indexModelEl = document.getElementById('settings-index-model');
    if (
      !providerEl ||
      !secretIdEl ||
      !secretKeyEl ||
      !regionEl ||
      !enabledEl ||
      !baseUrlEl ||
      !apiTokenEl ||
      !geminiKeyEl ||
      !openaiBaseUrlEl ||
      !openaiKeyEl ||
      !openaiModelEl ||
      !indexBaseUrlEl ||
      !indexModelEl
    ) {
      return;
    }

    const headers = authHeaders();
    if (!headers) {
      setTranslationFormDisabled(true, '请登录后配置翻译服务');
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

      const provider = normalizeTranslationProvider(data.provider);
      providerEl.value = provider;
      syncTranslationProviderFields(provider);

      secretIdEl.value = provider === 'openai' || provider === 'index' ? '' : data.secretId || '';
      secretKeyEl.value = '';
      secretKeyEl.placeholder = data.secretKeyMasked
        ? `已配置：${data.secretKeyMasked}（留空则保留）`
        : '腾讯云 API 密钥 SecretKey';
      regionEl.value = data.region || 'ap-guangzhou';
      enabledEl.checked = data.enabled !== false;
      baseUrlEl.value =
        provider === 'mtran'
          ? data.baseUrl || 'http://127.0.0.1:8989'
          : 'http://127.0.0.1:8989';
      apiTokenEl.value = '';
      apiTokenEl.placeholder = data.apiTokenMasked
        ? `已配置：${data.apiTokenMasked}（留空则保留）`
        : '未设置 MT_API_TOKEN 时可留空';

      geminiKeyEl.value = '';
      geminiKeyEl.placeholder = data.geminiApiKeyMasked
        ? `已配置：${data.geminiApiKeyMasked}（留空则保留）`
        : 'Google AI Studio API Key';
      if (geminiModelLabelEl && data.geminiModel) {
        geminiModelLabelEl.textContent = data.geminiModel;
      }

      openaiBaseUrlEl.value =
        data.openaiBaseUrl ||
        (provider === 'openai' ? data.baseUrl : '') ||
        'http://192.168.31.60:3921/v1';
      openaiKeyEl.value = '';
      openaiKeyEl.placeholder = data.openaiApiKeyMasked
        ? `已配置：${data.openaiApiKeyMasked}（留空则保留）`
        : 'Bearer Token / API Key';
      openaiModelEl.value =
        data.openaiModel ||
        (provider === 'openai' ? data.secretId : '') ||
        'bridge__deepseek';

      indexBaseUrlEl.value =
        data.indexBaseUrl ||
        (provider === 'index' ? data.baseUrl : '') ||
        'https://index-translate.bilibili.com/v1';
      indexModelEl.value =
        data.indexModel ||
        (provider === 'index' ? data.secretId : '') ||
        'Index-Translate-2B';

      if (hintEl) {
        hintEl.textContent = data.secretKeyMasked
          ? `当前密钥：${data.secretKeyMasked}。若不修改 SecretKey，保存时请留空。`
          : '请填写腾讯云 API 密钥 SecretKey。';
      }
      if (apiTokenHintEl) {
        apiTokenHintEl.textContent = data.apiTokenMasked
          ? `当前 Token：${data.apiTokenMasked}。若不修改请留空；清空请先保存空值。`
          : '若本机服务配置了 MT_API_TOKEN，在此填写。';
      }
      if (geminiKeyHintEl) {
        if (data.geminiApiKeyMasked) {
          geminiKeyHintEl.textContent = `当前 Key：${data.geminiApiKeyMasked}。若不修改请留空。`;
        } else if (data.geminiHasEnvKey) {
          geminiKeyHintEl.textContent =
            '服务端已配置 GEMINI_API_KEY 环境变量；此处可覆盖为个人 Key，留空则使用环境变量。';
        } else {
          geminiKeyHintEl.textContent =
            '填写 Google AI Studio 免费 API Key。也可先在服务端配置环境变量 GEMINI_API_KEY。';
        }
      }
      if (openaiKeyHintEl) {
        if (data.openaiApiKeyMasked) {
          openaiKeyHintEl.textContent = `当前 Key：${data.openaiApiKeyMasked}。若不修改请留空。`;
        } else if (data.openaiHasEnvKey) {
          openaiKeyHintEl.textContent =
            '服务端已配置 OPENAI_TRANSLATE_API_KEY；此处可覆盖为个人 Key，留空则使用环境变量。';
        } else {
          openaiKeyHintEl.textContent = '填写 OpenAI 兼容接口的 API Key。';
        }
      }

      if (data.configured) {
        setTranslationStatus(translationStatusText(provider, data));
      } else {
        setTranslationStatus('尚未配置翻译服务');
      }

      setTranslationFormDisabled(false);
      setTranslationMsg('');
    } catch {
      setTranslationFormDisabled(true, '网络错误，无法加载翻译配置');
    }
  }

  async function saveTranslationFromForm() {
    const providerEl = document.getElementById('settings-translation-provider');
    const secretIdEl = document.getElementById('settings-tmt-secret-id');
    const secretKeyEl = document.getElementById('settings-tmt-secret-key');
    const regionEl = document.getElementById('settings-tmt-region');
    const enabledEl = document.getElementById('settings-tmt-enabled');
    const baseUrlEl = document.getElementById('settings-mtran-base-url');
    const apiTokenEl = document.getElementById('settings-mtran-api-token');
    const geminiKeyEl = document.getElementById('settings-gemini-api-key');
    const openaiBaseUrlEl = document.getElementById('settings-openai-base-url');
    const openaiKeyEl = document.getElementById('settings-openai-api-key');
    const openaiModelEl = document.getElementById('settings-openai-model');
    const indexBaseUrlEl = document.getElementById('settings-index-base-url');
    const indexModelEl = document.getElementById('settings-index-model');
    if (
      !providerEl ||
      !secretIdEl ||
      !secretKeyEl ||
      !regionEl ||
      !enabledEl ||
      !baseUrlEl ||
      !apiTokenEl ||
      !geminiKeyEl ||
      !openaiBaseUrlEl ||
      !openaiKeyEl ||
      !openaiModelEl ||
      !indexBaseUrlEl ||
      !indexModelEl
    ) {
      return;
    }

    const headers = authHeaders();
    if (!headers) {
      setTranslationMsg('请登录后保存', 'error');
      return;
    }

    setTranslationMsg('');

    const provider = normalizeTranslationProvider(providerEl.value);
    const enabled = !!enabledEl.checked;
    const region = String(regionEl.value || 'ap-guangzhou').trim();
    const apiToken = String(apiTokenEl.value || '').trim();

    let secretId = String(secretIdEl.value || '').trim();
    let secretKey = String(secretKeyEl.value || '').trim();
    let baseUrl = String(baseUrlEl.value || '').trim() || 'http://127.0.0.1:8989';

    if (provider === 'gemini') {
      secretKey = String(geminiKeyEl.value || '').trim();
      secretId = '';
    } else if (provider === 'openai') {
      secretKey = String(openaiKeyEl.value || '').trim();
      secretId = String(openaiModelEl.value || '').trim() || 'bridge__deepseek';
      baseUrl =
        String(openaiBaseUrlEl.value || '').trim().replace(/\/+$/, '') ||
        'http://192.168.31.60:3921/v1';
    } else if (provider === 'index') {
      secretKey = '';
      secretId = String(indexModelEl.value || '').trim() || 'Index-Translate-2B';
      baseUrl =
        String(indexBaseUrlEl.value || '').trim().replace(/\/+$/, '') ||
        'https://index-translate.bilibili.com/v1';
    }

    if (provider === 'tencent' && !secretId) {
      setTranslationMsg('请填写 SecretId', 'error');
      return;
    }
    if (provider === 'mtran' && !baseUrl) {
      setTranslationMsg('请填写本机服务地址', 'error');
      return;
    }
    if (provider === 'openai' && !baseUrl) {
      setTranslationMsg('请填写 OpenAI 兼容接口地址', 'error');
      return;
    }
    if (provider === 'index' && !baseUrl) {
      setTranslationMsg('请填写 Index-Translate 接口地址', 'error');
      return;
    }

    try {
      const res = await fetch(`${API_BASE_URL}/settings/translation`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          provider,
          secretId,
          secretKey,
          region,
          baseUrl,
          apiToken,
          enabled,
        }),
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
      apiTokenEl.value = '';
      apiTokenEl.placeholder = data.apiTokenMasked
        ? `已配置：${data.apiTokenMasked}（留空则保留）`
        : '未设置 MT_API_TOKEN 时可留空';
      geminiKeyEl.value = '';
      geminiKeyEl.placeholder = data.geminiApiKeyMasked
        ? `已配置：${data.geminiApiKeyMasked}（留空则保留）`
        : 'Google AI Studio API Key';
      openaiKeyEl.value = '';
      openaiKeyEl.placeholder = data.openaiApiKeyMasked
        ? `已配置：${data.openaiApiKeyMasked}（留空则保留）`
        : 'Bearer Token / API Key';
      if (data.openaiBaseUrl) openaiBaseUrlEl.value = data.openaiBaseUrl;
      if (data.openaiModel) openaiModelEl.value = data.openaiModel;
      if (data.indexBaseUrl) indexBaseUrlEl.value = data.indexBaseUrl;
      if (data.indexModel) indexModelEl.value = data.indexModel;
      syncTranslationProviderFields(provider);
      setTranslationStatus(translationStatusText(provider, data));
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
        body: '{}',
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

    const providerEl = document.getElementById('settings-translation-provider');
    if (providerEl) {
      providerEl.addEventListener('change', () => {
        syncTranslationProviderFields(normalizeTranslationProvider(providerEl.value));
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

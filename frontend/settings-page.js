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
  });
})();

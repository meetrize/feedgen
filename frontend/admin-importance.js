/**
 * Admin — 重要度星级保底规则
 * 依赖：config.js (API_BASE_URL)、admin.js 登录态 (feedgen_admin_token)
 */
(function () {
  const TOKEN_KEY = 'feedgen_admin_token';
  let rulesCache = [];

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function authHeaders() {
    return {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
    };
  }

  function esc(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function setMsg(text, isError) {
    const el = document.getElementById('importance-rules-msg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('error', 'ok');
    if (text) el.classList.add(isError ? 'error' : 'ok');
  }

  function setModalMsg(text, isError) {
    const el = document.getElementById('importance-rule-modal-msg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('error', 'ok');
    if (text) el.classList.add(isError ? 'error' : 'ok');
  }

  async function api(path, options) {
    const res = await fetch(`${API_BASE_URL}/admin/importance${path}`, {
      ...options,
      headers: { ...authHeaders(), ...(options && options.headers) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }

  function keywordsToLines(list) {
    return Array.isArray(list) ? list.join('\n') : '';
  }

  function linesToKeywords(text) {
    return String(text || '')
      .split(/[\n,，]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function previewKeywords(list, max) {
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) return '—';
    const shown = arr.slice(0, max || 4).join('、');
    return arr.length > (max || 4) ? `${shown}…(+${arr.length - (max || 4)})` : shown;
  }

  function renderRules(rules) {
    rulesCache = Array.isArray(rules) ? rules : [];
    const tbody = document.querySelector('#table-importance-rules tbody');
    if (!tbody) return;
    if (!rulesCache.length) {
      tbody.innerHTML = '<tr><td colspan="10">暂无规则</td></tr>';
      return;
    }
    tbody.innerHTML = rulesCache
      .map((r) => {
        const key = esc(r.rule_key);
        return `<tr data-rule-key="${key}">
          <td><input type="checkbox" data-toggle-enabled="${key}" ${r.enabled ? 'checked' : ''}></td>
          <td>${esc(r.sort_order ?? '')}</td>
          <td><code>${key}</code></td>
          <td title="${esc(r.description || '')}">${esc(r.name)}</td>
          <td><strong>${esc(r.floor_stars)}</strong></td>
          <td title="${esc((r.subject_keywords || []).join('、'))}">${esc(previewKeywords(r.subject_keywords))}</td>
          <td title="${esc((r.signal_keywords || []).join('、'))}">${esc(previewKeywords(r.signal_keywords))}</td>
          <td title="${esc((r.exclude_keywords || []).join('、'))}">${esc(previewKeywords(r.exclude_keywords, 3))}</td>
          <td>${r.skip_local_agency ? '是' : '—'}</td>
          <td style="white-space:nowrap;">
            <button type="button" class="secondary-btn" data-edit-rule="${key}" style="font-size:0.78rem;padding:0.2rem 0.45rem;">编辑</button>
            <button type="button" class="secondary-btn" data-delete-rule="${key}" style="font-size:0.78rem;padding:0.2rem 0.45rem;color:#c0392b;">删除</button>
          </td>
        </tr>`;
      })
      .join('');
  }

  async function loadImportancePanel() {
    setMsg('加载中…', false);
    try {
      const data = await api('/star-floor-rules');
      renderRules(data.rules || []);
      setMsg(`共 ${rulesCache.length} 条规则`, false);
    } catch (e) {
      setMsg(e.message || '加载失败', true);
    }
  }

  function openModal(rule) {
    const modal = document.getElementById('importance-rule-modal');
    const isEdit = !!rule;
    document.getElementById('importance-rule-modal-title').textContent = isEdit
      ? `编辑规则：${rule.rule_key}`
      : '新建规则';
    document.getElementById('importance-rule-edit-key').value = isEdit ? rule.rule_key : '';
    const keyEl = document.getElementById('importance-rule-key');
    keyEl.value = isEdit ? rule.rule_key : '';
    keyEl.disabled = isEdit;
    document.getElementById('importance-rule-name').value = isEdit ? rule.name || '' : '';
    document.getElementById('importance-rule-desc').value = isEdit ? rule.description || '' : '';
    document.getElementById('importance-rule-stars').value = String(
      isEdit ? rule.floor_stars || 5 : 5,
    );
    document.getElementById('importance-rule-sort').value = String(
      isEdit ? rule.sort_order ?? 100 : 100,
    );
    document.getElementById('importance-rule-enabled').checked = isEdit ? !!rule.enabled : true;
    document.getElementById('importance-rule-skip-local').checked = isEdit
      ? !!rule.skip_local_agency
      : false;
    document.getElementById('importance-rule-subjects').value = keywordsToLines(
      isEdit ? rule.subject_keywords : [],
    );
    document.getElementById('importance-rule-signals').value = keywordsToLines(
      isEdit ? rule.signal_keywords : [],
    );
    document.getElementById('importance-rule-excludes').value = keywordsToLines(
      isEdit ? rule.exclude_keywords : [],
    );
    setModalMsg('');
    modal.classList.add('open');
  }

  function closeModal() {
    document.getElementById('importance-rule-modal')?.classList.remove('open');
  }

  function collectForm() {
    return {
      rule_key: document.getElementById('importance-rule-key').value.trim(),
      name: document.getElementById('importance-rule-name').value.trim(),
      description: document.getElementById('importance-rule-desc').value.trim() || null,
      floor_stars: Number(document.getElementById('importance-rule-stars').value),
      sort_order: Number(document.getElementById('importance-rule-sort').value),
      enabled: document.getElementById('importance-rule-enabled').checked,
      skip_local_agency: document.getElementById('importance-rule-skip-local').checked,
      subject_keywords: linesToKeywords(document.getElementById('importance-rule-subjects').value),
      signal_keywords: linesToKeywords(document.getElementById('importance-rule-signals').value),
      exclude_keywords: linesToKeywords(document.getElementById('importance-rule-excludes').value),
    };
  }

  async function saveRule() {
    const editKey = document.getElementById('importance-rule-edit-key').value.trim();
    const body = collectForm();
    if (!body.name) {
      setModalMsg('请填写名称', true);
      return;
    }
    if (!body.signal_keywords.length) {
      setModalMsg('信号词至少需要一个', true);
      return;
    }
    if (!editKey && !body.rule_key) {
      setModalMsg('请填写 rule_key', true);
      return;
    }
    setModalMsg('保存中…', false);
    try {
      if (editKey) {
        await api(`/star-floor-rules/${encodeURIComponent(editKey)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
      } else {
        await api('/star-floor-rules', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
      closeModal();
      await loadImportancePanel();
      setMsg('已保存', false);
    } catch (e) {
      setModalMsg(e.message || '保存失败', true);
    }
  }

  async function toggleEnabled(ruleKey, enabled) {
    try {
      await api(`/star-floor-rules/${encodeURIComponent(ruleKey)}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      setMsg(enabled ? `已启用 ${ruleKey}` : `已停用 ${ruleKey}`, false);
    } catch (e) {
      setMsg(e.message || '更新失败', true);
      await loadImportancePanel();
    }
  }

  async function deleteRule(ruleKey) {
    if (!window.confirm(`确定删除规则 ${ruleKey}？`)) return;
    try {
      await api(`/star-floor-rules/${encodeURIComponent(ruleKey)}`, { method: 'DELETE' });
      await loadImportancePanel();
      setMsg(`已删除 ${ruleKey}`, false);
    } catch (e) {
      setMsg(e.message || '删除失败', true);
    }
  }

  async function resetDefaults() {
    if (
      !window.confirm(
        '将用内置默认覆盖同名规则（政策/央行/非农/地缘/灾害等）。自定义 rule_key 不会删除。是否继续？',
      )
    ) {
      return;
    }
    try {
      setMsg('正在恢复默认…', false);
      const data = await api('/star-floor-rules/reset-defaults', {
        method: 'POST',
        body: JSON.stringify({ wipe_custom: false }),
      });
      renderRules(data.rules || []);
      setMsg('已恢复默认规则', false);
    } catch (e) {
      setMsg(e.message || '恢复失败', true);
    }
  }

  async function previewTitle() {
    const title = document.getElementById('importance-preview-title')?.value?.trim() || '';
    const out = document.getElementById('importance-preview-result');
    if (!out) return;
    if (!title) {
      out.textContent = '请输入标题';
      return;
    }
    out.textContent = '试算中…';
    try {
      const data = await api('/star-floor-rules/preview', {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
      const r = data.result || {};
      const lines = [
        `保底星级：${r.floor_stars == null ? '无（不抬升）' : r.floor_stars}`,
        `命中规则数：${(r.matched_rules || []).length}`,
      ];
      for (const m of r.matched_rules || []) {
        lines.push(
          `- [${m.floor_stars}★] ${m.rule_key} ${m.name}` +
            `\n    主体: ${(m.matched_subjects || []).join('、') || '—'}` +
            `\n    信号: ${(m.matched_signals || []).join('、') || '—'}`,
        );
      }
      if ((r.skipped_local_keys || []).length) {
        lines.push(`地方机构跳过: ${(r.skipped_local_keys || []).join(', ')}`);
      }
      out.textContent = lines.join('\n');
    } catch (e) {
      out.textContent = e.message || '试算失败';
    }
  }

  function bindEvents() {
    document.getElementById('importance-rules-refresh')?.addEventListener('click', () => {
      void loadImportancePanel();
    });
    document.getElementById('importance-rules-create')?.addEventListener('click', () => {
      openModal(null);
    });
    document.getElementById('importance-rules-reset')?.addEventListener('click', () => {
      void resetDefaults();
    });
    document.getElementById('importance-rule-cancel')?.addEventListener('click', closeModal);
    document.getElementById('importance-rule-save')?.addEventListener('click', () => {
      void saveRule();
    });
    document.getElementById('importance-preview-btn')?.addEventListener('click', () => {
      void previewTitle();
    });
    document.getElementById('importance-preview-title')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void previewTitle();
      }
    });
    document.getElementById('importance-rule-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal();
    });

    document.querySelector('#table-importance-rules')?.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const editKey = t.getAttribute('data-edit-rule');
      if (editKey) {
        const rule = rulesCache.find((r) => r.rule_key === editKey);
        if (rule) openModal(rule);
        return;
      }
      const delKey = t.getAttribute('data-delete-rule');
      if (delKey) {
        void deleteRule(delKey);
      }
    });

    document.querySelector('#table-importance-rules')?.addEventListener('change', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;
      const key = t.getAttribute('data-toggle-enabled');
      if (!key) return;
      void toggleEnabled(key, t.checked);
    });
  }

  document.addEventListener('DOMContentLoaded', bindEvents);

  window.loadImportancePanel = loadImportancePanel;
})();

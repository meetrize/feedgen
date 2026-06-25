(function (global) {
  function escapeHtml(text) {
    if (global.escapeHtml && global.escapeHtml !== escapeHtml) {
      return global.escapeHtml(text);
    }
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function faviconUrlFromSite(feedUrl) {
    const raw = String(feedUrl || '').trim();
    if (!raw) return '';
    try {
      const u = new URL(raw);
      return `${u.origin}/favicon.ico`;
    } catch {
      return '';
    }
  }

  function probeFaviconUrl(faviconUrl) {
    const url = String(faviconUrl || '').trim();
    if (!url) return Promise.resolve(false);
    return new Promise((resolve) => {
      const img = new Image();
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.referrerPolicy = 'no-referrer';
      img.src = `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`;
      setTimeout(() => finish(false), 5000);
    });
  }

  function buildFeedFaviconMarkup(feedData, opts) {
    const cellClass = (opts && opts.cellClass) || 'article-reader-favicon-cell';
    const customText = String(feedData?.favicon_custom_text || feedData?.faviconCustomText || '').trim().slice(0, 2);
    const customBg = String(feedData?.favicon_custom_bg || feedData?.faviconCustomBg || '').trim() || '#2874a6';
    const directUrl = String(feedData?.favicon_url || feedData?.faviconUrl || '').trim();
    const fallbackUrl = faviconUrlFromSite(feedData?.url || '');
    const finalUrl = directUrl || fallbackUrl;
    const feedName = String(feedData?.title || feedData?.tooltip || (opts && opts.tooltip) || '').trim();
    const dataAttr = feedName ? ` data-feed-name="${escapeHtml(feedName)}"` : '';
    if (finalUrl) {
      return `<span class="${escapeHtml(cellClass)}"${dataAttr}><img src="${escapeHtml(finalUrl)}" alt="favicon" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none';this.parentElement.classList.add('is-fallback');"></span>`;
    }
    const text = (customText || String(feedData?.title || 'F').trim().slice(0, 1) || 'F').toUpperCase();
    return `<span class="${escapeHtml(cellClass)}" style="background:${escapeHtml(customBg)};color:#fff;"${dataAttr}>${escapeHtml(text)}</span>`;
  }

  global.FeedFavicon = {
    faviconUrlFromSite,
    probeFaviconUrl,
    buildFeedFaviconMarkup,
  };
})(typeof window !== 'undefined' ? window : globalThis);

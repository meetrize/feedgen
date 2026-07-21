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

  /** 中国大陆常见后缀，用于决定是否走 Google Favicon */
  function isDomesticHost(hostname) {
    const host = String(hostname || '')
      .trim()
      .toLowerCase()
      .replace(/\.$/, '');
    if (!host) return false;
    if (host === 'localhost' || /^[\d.]+$/.test(host)) return true;
    return (
      host.endsWith('.cn') ||
      host.endsWith('.中国') ||
      host.endsWith('.公司') ||
      host.endsWith('.网络')
    );
  }

  function parseSiteUrl(feedUrl) {
    const raw = String(feedUrl || '').trim();
    if (!raw) return null;
    try {
      const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
      return new URL(withProtocol);
    } catch {
      return null;
    }
  }

  /**
   * 按优先级构造第三方 Favicon API 地址：
   * 1) 0x3  2) 牛三维  3) 境外站点再试 Google
   */
  function buildApiFaviconUrls(feedUrl) {
    const u = parseSiteUrl(feedUrl);
    if (!u) return [];
    const host = u.hostname;
    const siteUrl = `${u.protocol}//${u.hostname}`;
    const list = [
      `https://0x3.com/icon?host=${encodeURIComponent(host)}`,
      `https://ico.n3v.cn/get.php?url=${encodeURIComponent(siteUrl)}`,
    ];
    if (!isDomesticHost(host)) {
      list.push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`);
    }
    return list;
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
      img.onload = () => finish(Boolean(img.naturalWidth));
      img.onerror = () => finish(false);
      img.referrerPolicy = 'no-referrer';
      img.src = `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`;
      setTimeout(() => finish(false), 5000);
    });
  }

  /** 从网页 head 中解析 favicon / apple-touch-icon 等图标链接 */
  function findFaviconFromHtml(html, baseUrl) {
    const rawHtml = String(html || '').trim();
    if (!rawHtml) return '';
    try {
      const parser = new DOMParser();
      const htmlDoc = parser.parseFromString(rawHtml, 'text/html');
      const head = htmlDoc.querySelector('head') || htmlDoc;
      const links = Array.from(head.querySelectorAll('link[href]'));
      const scored = [];
      links.forEach((link) => {
        const rel = String(link.getAttribute('rel') || '').toLowerCase();
        const href = String(link.getAttribute('href') || '').trim();
        if (!href || !rel.includes('icon')) return;
        let score = 10;
        if (rel.includes('apple-touch-icon')) score += 30;
        if (rel.includes('shortcut')) score += 5;
        const sizes = String(link.getAttribute('sizes') || '').toLowerCase();
        const sizeMatch = sizes.match(/(\d+)x(\d+)/);
        if (sizeMatch) {
          score += Math.min(Number(sizeMatch[1]) || 0, 256) / 8;
        }
        if (/\.svg(?:[?#]|$)/i.test(href)) score += 20;
        else if (/\.png(?:[?#]|$)/i.test(href)) score += 15;
        else if (/\.ico(?:[?#]|$)/i.test(href)) score += 8;
        scored.push({ href, score });
      });
      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (!best) return '';
      return new URL(best.href, baseUrl || global.location?.href || 'https://example.com').href;
    } catch {
      return '';
    }
  }

  /**
   * 解析可用的 favicon 地址。
   * options.fetchHtml(siteRootUrl) → Promise<html>，用于 API 全部失败后的源码解析。
   * options.signal 可选 AbortSignal。
   */
  async function resolveFaviconUrl(feedUrl, options) {
    const opts = options || {};
    const signal = opts.signal;
    const throwIfAborted = () => {
      if (signal && signal.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
    };

    const u = parseSiteUrl(feedUrl);
    if (!u) return { url: '', source: '' };
    const siteRootUrl = `${u.protocol}//${u.hostname}/`;

    const apiUrls = buildApiFaviconUrls(feedUrl);
    for (const candidate of apiUrls) {
      throwIfAborted();
      if (await probeFaviconUrl(candidate)) {
        return { url: candidate, source: 'api' };
      }
    }

    if (typeof opts.fetchHtml === 'function') {
      throwIfAborted();
      try {
        const html = await opts.fetchHtml(siteRootUrl);
        throwIfAborted();
        const fromHtml = findFaviconFromHtml(html, siteRootUrl);
        if (fromHtml) {
          const ok = await probeFaviconUrl(fromHtml);
          if (ok || fromHtml) {
            return { url: fromHtml, source: 'html' };
          }
        }
      } catch (error) {
        if (error && error.name === 'AbortError') throw error;
      }
    }

    return { url: '', source: '' };
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
    isDomesticHost,
    buildApiFaviconUrls,
    probeFaviconUrl,
    findFaviconFromHtml,
    resolveFaviconUrl,
    buildFeedFaviconMarkup,
  };
})(typeof window !== 'undefined' ? window : globalThis);

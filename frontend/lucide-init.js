/**
 * Lucide 图标初始化：在 DOM 就绪后扫描 [data-lucide]，替换为 SVG。
 * 动态插入带 data-lucide 的节点后，请调用 window.refreshLucideIcons()。
 */
(function initLucideIcons() {
  function refreshLucideIcons() {
    if (typeof lucide === 'undefined' || typeof lucide.createIcons !== 'function') return;
    lucide.createIcons({
      attrs: {
        width: 20,
        height: 20,
        'stroke-width': 1.8,
      },
    });
  }

  window.refreshLucideIcons = refreshLucideIcons;

  function run() {
    refreshLucideIcons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();

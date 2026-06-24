/**
 * 在 Playwright 浏览器上下文中执行，须保持纯 JS（避免 TS 编译注入 __name 等 helper）
 */
function extractYouTubeChannelVideosInBrowser() {
  var items = [];
  var seen = new Set();

  function add(title, url, meta, thumbnail) {
    var t = (title || '').trim();
    var u = (url || '').trim();
    if (!t || !u || seen.has(u)) return;
    seen.add(u);
    items.push({
      title: t,
      url: u,
      meta: (meta || '').trim(),
      thumbnail: (thumbnail || '').trim(),
    });
  }

  function pickVideo(vr) {
    var titleObj = vr.title || {};
    var runs = titleObj.runs || [];
    var title = runs.map(function (r) { return r.text || ''; }).join('') || titleObj.simpleText || '';
    var nav = vr.navigationEndpoint || {};
    var path = (((nav.commandMetadata || {}).webCommandMetadata) || {}).url || '';
    var url = path ? new URL(path, location.origin).href : '';
    var viewCount = ((vr.viewCountText || {}).simpleText) || '';
    var published = ((vr.publishedTimeText || {}).simpleText) || '';
    var meta = [viewCount, published].filter(Boolean).join(' • ');
    var thumbs = ((vr.thumbnail || {}).thumbnails) || [];
    var thumbnail = thumbs.length ? (thumbs[thumbs.length - 1].url || '') : '';
    add(title, url, meta, thumbnail);
  }

  function walk(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 28) return;
    if (obj.videoRenderer && typeof obj.videoRenderer === 'object') pickVideo(obj.videoRenderer);
    if (obj.gridVideoRenderer && typeof obj.gridVideoRenderer === 'object') pickVideo(obj.gridVideoRenderer);
    if (obj.richItemRenderer && typeof obj.richItemRenderer === 'object') {
      var content = obj.richItemRenderer.content;
      if (content && typeof content === 'object') walk(content, depth + 1);
    }
    var values = Object.values(obj);
    for (var i = 0; i < values.length; i++) {
      var value = values[i];
      if (value && typeof value === 'object') walk(value, depth + 1);
    }
  }

  if (window.ytInitialData) walk(window.ytInitialData, 0);

  if (items.length < 3) {
    var html = document.documentElement.innerHTML;
    var match = html.match(/var ytInitialData = ({[\s\S]+?});<\/script>/)
      || html.match(/ytInitialData\s*=\s*({[\s\S]+?});/);
    var ytJson = match && match[1];
    if (ytJson) {
      try { walk(JSON.parse(ytJson), 0); } catch (e) {}
    }
  }

  if (items.length < 3) {
    var lines = (document.body && document.body.innerText ? document.body.innerText : '')
      .split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    var durationRe = /^\d{1,2}:\d{2}(:\d{2})?$/;
    var viewRe = /(观看|views|次观看|万|亿|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years|前|ago)/i;
    for (var j = 0; j < lines.length - 1; j++) {
      var line = lines[j] || '';
      var next = lines[j + 1] || '';
      if (!durationRe.test(line)) continue;
      if (!next || next.length < 4 || viewRe.test(next)) continue;
      var metaCandidate = lines[j + 2] || '';
      var metaLine = viewRe.test(metaCandidate) ? metaCandidate : '';
      var anchors = Array.from(document.querySelectorAll('a[href*="/watch"], a[href*="/shorts/"]'));
      var href = '';
      for (var k = 0; k < anchors.length; k++) {
        if (((anchors[k].textContent || '').trim()) === next) {
          href = anchors[k].href || '';
          break;
        }
      }
      if (href) add(next, href, metaLine);
    }
  }

  return items.slice(0, 80);
}

extractYouTubeChannelVideosInBrowser();

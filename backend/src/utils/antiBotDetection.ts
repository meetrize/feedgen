/**
 * 在 Playwright page.evaluate 中运行的反爬/验证码页检测。
 * 须保持纯浏览器端逻辑（无外部 import），供 visualCrawler 与 page-renderer 复用。
 */
export function detectAntiBotSignalsInPage(): string[] {
  const bodyText = (document.body?.innerText || '').toLowerCase();
  const titleText = (document.title || '').toLowerCase();
  const rawHtml = (document.documentElement?.outerHTML || '').slice(0, 120000).toLowerCase();
  const cleanHtml = rawHtml
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // 强信号：出现即判定为验证/挑战页
  const strongSignals: Array<[string, string]> = [
    ['geetest', 'geetest'],
    ['访问受限', '访问受限'],
    ['请完成验证', '请完成验证'],
    ['sec_sdk', 'sec_sdk'],
    ['webcast.amemv.com', 'webcast.amemv.com'],
    ['robot', 'are you a robot'],
    ['unusual activity', 'unusual activity'],
    ['人机验证页', 'please verify you are a human'],
  ];
  for (const [label, token] of strongSignals) {
    if (bodyText.includes(token) || titleText.includes(token) || cleanHtml.includes(token)) {
      return [label];
    }
  }

  // captcha 关键词仅在页面可见文本中出现才判定（HTML 里引用 recaptcha.js 不算）
  if (bodyText.includes('captcha') || titleText.includes('captcha')) return ['captcha'];

  // 弱信号：仅检查可见正文，避免隐藏登录框里的 verifyImgCode / 验证码 等误报
  const titleHits: string[] = [];
  const bodyHits: string[] = [];
  const weakTokens: Array<[string, string]> = [
    ['verify', 'verify you are human'],
    ['verify', 'please verify'],
    ['人机验证', '人机验证'],
    ['滑动验证', '滑动验证'],
    ['安全验证', '安全验证'],
    ['访问验证', '访问验证'],
    ['完成验证', '完成验证'],
  ];
  for (const [label, token] of weakTokens) {
    if (titleText.includes(token)) titleHits.push(label);
    if (bodyText.includes(token)) bodyHits.push(label);
  }

  if (titleHits.length > 0) return Array.from(new Set(titleHits));
  if (bodyHits.length >= 2) return Array.from(new Set(bodyHits));

  return [];
}

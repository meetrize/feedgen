import fs from 'fs';
import { execSync } from 'child_process';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, LaunchOptions, Page } from 'playwright';
import { withPlaywrightProxy } from './proxyConfig';

// 注册 stealth 插件（全局一次），自动修补 40+ 浏览器指纹检测点：
// navigator.webdriver, navigator.plugins, navigator.hardwareConcurrency, navigator.vendor,
// navigator.permissions, chrome.runtime, chrome.app, chrome.csi, chrome.loadTimes,
// canvas/webgl 指纹, iframe.contentWindow, media.codecs, user-agent-override 等
const stealthPlugin = StealthPlugin();
chromium.use(stealthPlugin);

export { chromium };

const DEFAULT_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
];

const ENHANCED_LAUNCH_ARGS = [
  ...DEFAULT_LAUNCH_ARGS,
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
];

export function getDefaultLaunchArgs(enhanced = false): string[] {
  return enhanced ? [...ENHANCED_LAUNCH_ARGS] : [...DEFAULT_LAUNCH_ARGS];
}

/** 启动前检查中文字体；CentOS 7 默认无 CJK 字体时 Playwright 截图中文会显示为方块 */
export function warnIfMissingChineseFonts(): void {
  try {
    const out = execSync('fc-list :lang=zh 2>/dev/null | head -1', { encoding: 'utf8', timeout: 3000 }).trim();
    if (!out) {
      console.warn(
        '[browser] 未检测到中文字体，Playwright 页面截图中文可能显示为方块。' +
          '请执行: feedgen playwright 或 yum install -y google-noto-sans-cjk-fonts wqy-microhei-fonts'
      );
    }
  } catch {
    // fc-list 不可用时跳过
  }
}

/** CentOS 7 兼容版 Chromium（glibc 2.17 可用） */
const COMPAT_CHROMIUM_PATH =
  '/root/.cache/ms-playwright-old/chromium-1033/chrome-linux/chrome';

/** CentOS 7 等旧系统需通过环境变量指定兼容版 Chromium 可执行文件路径 */
export function getChromiumLaunchOptions(overrides: LaunchOptions = {}): LaunchOptions {
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() ||
    process.env.CHROMIUM_EXECUTABLE_PATH?.trim() ||
    (fs.existsSync(COMPAT_CHROMIUM_PATH) ? COMPAT_CHROMIUM_PATH : '');
  const options: LaunchOptions = {
    headless: true,
    args: getDefaultLaunchArgs(),
    ...overrides,
  };
  if (executablePath && fs.existsSync(executablePath)) {
    options.executablePath = executablePath;
  }
  return options;
}

export async function launchChromium(overrides: LaunchOptions = {}): Promise<Browser> {
  warnIfMissingChineseFonts();
  return chromium.launch(getChromiumLaunchOptions(overrides));
}

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

const DEFAULT_EXTRA_HEADERS: Record<string, string> = {
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua': '"Not.A/Brand";v="8", "Chromium";v="123", "Google Chrome";v="123"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
};

export interface StealthContextOptions {
  authCookie?: string;
  extraHTTPHeaders?: Record<string, string>;
  viewport?: { width: number; height: number };
  locale?: string;
  timezoneId?: string;
  userAgent?: string;
  useProxy?: boolean;
}
/**
 * 创建带有防检测头部的浏览器上下文。
 * 合并默认真实请求头部与可选的 auth cookie 及自定义覆盖项。
 */
export async function createStealthContext(
  browser: Browser,
  options?: StealthContextOptions
): Promise<BrowserContext> {
  const headers: Record<string, string> = { ...DEFAULT_EXTRA_HEADERS };
  if (options?.authCookie?.trim()) {
    headers.Cookie = options.authCookie.trim();
  }
  if (options?.extraHTTPHeaders) {
    Object.assign(headers, options.extraHTTPHeaders);
  }

  return browser.newContext(withPlaywrightProxy({
    userAgent: options?.userAgent || DESKTOP_UA,
    viewport: options?.viewport || { width: 1440, height: 900 },
    locale: options?.locale || 'zh-CN',
    timezoneId: options?.timezoneId || 'Asia/Shanghai',
    extraHTTPHeaders: headers,
  }, options?.useProxy));
}

/**
 * 补充中文语言环境的反检测补丁。
 * stealth 插件已自动处理 navigator.webdriver / plugins / hardwareConcurrency / vendor / permissions /
 * chrome.runtime / canvas / webgl 等 40+ 检测点。
 * 这里仅覆盖 stealth 插件未专门针对的中文 locale 相关属性。
 */
export async function applySupplementaryPatches(page: Page): Promise<void> {
  await page.addInitScript(`
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
  `);
}

import fs from 'fs';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, LaunchOptions, Page } from 'playwright';

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

/** CentOS 7 等旧系统需通过环境变量指定兼容版 Chromium 可执行文件路径 */
export function getChromiumLaunchOptions(overrides: LaunchOptions = {}): LaunchOptions {
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() ||
    process.env.CHROMIUM_EXECUTABLE_PATH?.trim();
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

  return browser.newContext({
    userAgent: options?.userAgent || DESKTOP_UA,
    viewport: options?.viewport || { width: 1440, height: 900 },
    locale: options?.locale || 'zh-CN',
    timezoneId: options?.timezoneId || 'Asia/Shanghai',
    extraHTTPHeaders: headers,
  });
}

/**
 * 补充中文语言环境的反检测补丁。
 * stealth 插件已自动处理 navigator.webdriver / plugins / hardwareConcurrency / vendor / permissions /
 * chrome.runtime / canvas / webgl 等 40+ 检测点。
 * 这里仅覆盖 stealth 插件未专门针对的中文 locale 相关属性。
 */
export async function applySupplementaryPatches(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
  });
}

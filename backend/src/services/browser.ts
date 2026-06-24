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

export function getLivePreviewLaunchOptions(overrides: LaunchOptions = {}): LaunchOptions {
  const base = getChromiumLaunchOptions({
    headless: true,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      ...getDefaultLaunchArgs(),
      '--headless=new',
      '--disable-blink-features=AutomationControlled',
    ],
    ...overrides,
  });
  return base;
}

/** 将 `key1=val1; key2=val2` 写入 Playwright Cookie 存储（比 HTTP Cookie 头更可靠） */
export async function injectAuthCookies(
  context: BrowserContext,
  cookieString: string,
  pageUrl: string,
): Promise<number> {
  const trimmed = cookieString.trim();
  if (!trimmed) return 0;

  let hostname = 'localhost';
  try {
    hostname = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    /* ignore */
  }

  const baseHost = hostname.replace(/^www\./, '');
  const domainCandidates = new Set<string>();
  if (hostname) domainCandidates.add(hostname);
  if (baseHost) {
    domainCandidates.add(baseHost);
    domainCandidates.add('.' + baseHost);
    domainCandidates.add('www.' + baseHost);
  }

  const secure = pageUrl.startsWith('https');
  const playwrightCookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    sameSite: 'Lax';
  }> = [];

  for (const part of trimmed.split(';')) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    const name = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (!name) continue;
    for (const domain of domainCandidates) {
      playwrightCookies.push({
        name,
        value,
        domain,
        path: '/',
        secure,
        sameSite: 'Lax',
      });
    }
  }

  if (playwrightCookies.length === 0) return 0;
  await context.addCookies(playwrightCookies);
  return playwrightCookies.length;
}

export function isDouyinHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'douyin.com' || host.endsWith('.douyin.com')
      || host === 'iesdouyin.com' || host.endsWith('.iesdouyin.com');
  } catch {
    return false;
  }
}

export async function launchChromium(overrides: LaunchOptions = {}): Promise<Browser> {
  warnIfMissingChineseFonts();
  return chromium.launch(getChromiumLaunchOptions(overrides));
}

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

const CHROMIUM_108_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.5359.29 Safari/537.36';

const SHARED_ACCEPT_HEADER =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8';

export type FingerprintProfileId = 'default' | 'chromium108';

export interface FingerprintProfile {
  id: FingerprintProfileId;
  label: string;
  description: string;
  userAgent: string;
  secChUa: string;
  secChUaPlatform: string;
  navigatorPlatform: string;
  defaultLocale: string;
  defaultLanguages: string[];
  defaultAcceptLanguage: string;
}

const FINGERPRINT_PROFILES: FingerprintProfile[] = [
  {
    id: 'default',
    label: '默认（Mac Chrome 123）',
    description: '适用于中文站点（抖音、YouTube 等）',
    userAgent: DESKTOP_UA,
    secChUa: '"Not.A/Brand";v="8", "Chromium";v="123", "Google Chrome";v="123"',
    secChUaPlatform: '"macOS"',
    navigatorPlatform: 'MacIntel',
    defaultLocale: 'zh-CN',
    defaultLanguages: ['zh-CN', 'zh', 'en-US', 'en'],
    defaultAcceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
  },
  {
    id: 'chromium108',
    label: 'Chromium 108（Windows）',
    description: '与服务器兼容版 Chromium 108 对齐，适用于彭博等英文站点',
    userAgent: CHROMIUM_108_UA,
    secChUa: '" Not A;Brand";v="99", "Chromium";v="108", "Google Chrome";v="108"',
    secChUaPlatform: '"Windows"',
    navigatorPlatform: 'Win32',
    defaultLocale: 'en-US',
    defaultLanguages: ['en-US', 'en'],
    defaultAcceptLanguage: 'en-US,en;q=0.9',
  },
];

export function normalizeFingerprintProfile(id?: string | null): FingerprintProfileId {
  if (id === 'chromium108') return 'chromium108';
  return 'default';
}

export function getFingerprintProfile(id?: string | null): FingerprintProfile {
  const normalized = normalizeFingerprintProfile(id);
  return FINGERPRINT_PROFILES.find((profile) => profile.id === normalized) || FINGERPRINT_PROFILES[0]!;
}

export function listFingerprintProfiles(): Array<Pick<FingerprintProfile, 'id' | 'label' | 'description'>> {
  return FINGERPRINT_PROFILES.map(({ id, label, description }) => ({ id, label, description }));
}

export function isBloombergHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'bloomberg.com' || host.endsWith('.bloomberg.com');
  } catch {
    return false;
  }
}

function buildProfileExtraHeaders(
  profile: FingerprintProfile,
  acceptLanguage?: string | null,
): Record<string, string> {
  return {
    Accept: SHARED_ACCEPT_HEADER,
    'Accept-Language': acceptLanguage?.trim() || profile.defaultAcceptLanguage,
    'sec-ch-ua': profile.secChUa,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': profile.secChUaPlatform,
  };
}

function parseAcceptLanguageToNavigatorLanguages(acceptLanguage?: string | null): string[] | null {
  const raw = (acceptLanguage || '').trim();
  if (!raw) return null;
  const langs = raw
    .split(',')
    .map((part) => part.trim().split(';')[0]?.trim())
    .filter((lang): lang is string => !!lang);
  return langs.length > 0 ? Array.from(new Set(langs)) : null;
}

export interface StealthContextOptions {
  authCookie?: string;
  extraHTTPHeaders?: Record<string, string>;
  viewport?: { width: number; height: number };
  locale?: string;
  timezoneId?: string;
  userAgent?: string;
  useProxy?: boolean;
  fingerprintProfile?: string | null;
  acceptLanguage?: string | null;
}
/**
 * 创建带有防检测头部的浏览器上下文。
 * 合并默认真实请求头部与可选的 auth cookie 及自定义覆盖项。
 */
export async function createStealthContext(
  browser: Browser,
  options?: StealthContextOptions
): Promise<BrowserContext> {
  const profile = getFingerprintProfile(options?.fingerprintProfile);
  const acceptLanguage =
    options?.acceptLanguage
    || options?.extraHTTPHeaders?.['Accept-Language']
    || profile.defaultAcceptLanguage;
  const headers: Record<string, string> = buildProfileExtraHeaders(profile, acceptLanguage);
  if (options?.authCookie?.trim()) {
    headers.Cookie = options.authCookie.trim();
  }
  if (options?.extraHTTPHeaders) {
    Object.assign(headers, options.extraHTTPHeaders);
  }

  return browser.newContext(withPlaywrightProxy({
    userAgent: options?.userAgent || profile.userAgent,
    viewport: options?.viewport || { width: 1440, height: 900 },
    locale: options?.locale || profile.defaultLocale,
    timezoneId: options?.timezoneId || 'Asia/Shanghai',
    extraHTTPHeaders: headers,
  }, options?.useProxy));
}

export interface SupplementaryPatchOptions {
  fingerprintProfile?: string | null;
  acceptLanguage?: string | null;
}

/**
 * 按指纹配置补充 locale / platform，与 HTTP 头、UA 保持一致。
 */
export async function applySupplementaryPatches(
  page: Page,
  options?: SupplementaryPatchOptions,
): Promise<void> {
  const profile = getFingerprintProfile(options?.fingerprintProfile);
  const languages =
    parseAcceptLanguageToNavigatorLanguages(options?.acceptLanguage)
    || profile.defaultLanguages;

  await page.addInitScript((params: { platform: string; langs: string[] }) => {
    Object.defineProperty(navigator, 'languages', { get: () => params.langs });
    Object.defineProperty(navigator, 'platform', { get: () => params.platform });
  }, {
    platform: profile.navigatorPlatform,
    langs: languages,
  });
}

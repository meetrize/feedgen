import * as cheerio from 'cheerio';
import axios from 'axios';
import { launchChromium, getDefaultLaunchArgs, applySupplementaryPatches } from './browser';

interface SelectorRules {
  item: string;
  title: string;
  link: string;
  description?: string;
  pubDate?: string;
}

interface CrawlResult {
  title: string;
  link: string;
  description?: string;
  pubDate?: Date;
  author?: string;
}

export class CrawlerService {
  /**
   * 原生 Feed 抓取（RSS/Atom）
   */
  static async crawlNativeFeed(feedUrl: string): Promise<CrawlResult[]> {
    const response = await axios.get(feedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FeedGen Bot/1.0)'
      },
      timeout: 15000
    });

    const xml = String(response.data || '');
    const $ = cheerio.load(xml, { xmlMode: true });
    const results: CrawlResult[] = [];

    // RSS
    $('item').each((_, item) => {
      const el = $(item);
      const title = el.find('title').first().text().trim();
      const link = el.find('link').first().text().trim() || el.find('guid').first().text().trim();
      const description = el.find('description').first().text().trim();
      const pubRaw = el.find('pubDate').first().text().trim();
      const author = el.find('dc\\:creator').first().text().trim() || el.find('author').first().text().trim();
      if (!title || !link) return;
      const result: CrawlResult = {
        title,
        link,
      };
      if (description) result.description = description;
      if (pubRaw) result.pubDate = new Date(pubRaw);
      if (author) result.author = author;
      results.push(result);
    });

    // Atom（当 RSS 没解析到时再尝试）
    if (!results.length) {
      $('entry').each((_, entry) => {
        const el = $(entry);
        const title = el.find('title').first().text().trim();
        let link = el.find('link[rel="alternate"]').attr('href') || '';
        if (!link) link = el.find('link').first().attr('href') || '';
        const summary = el.find('summary').first().text().trim() || el.find('content').first().text().trim();
        const pubRaw = el.find('updated').first().text().trim() || el.find('published').first().text().trim();
        const author = el.find('author > name').first().text().trim();
        if (!title || !link) return;
        const result: CrawlResult = {
          title,
          link,
        };
        if (summary) result.description = summary;
        if (pubRaw) result.pubDate = new Date(pubRaw);
        if (author) result.author = author;
        results.push(result);
      });
    }

    return results;
  }

  /**
   * 静态页面爬取（使用Cheerio）
   */
  static async crawlStaticPage(url: string, selectors: SelectorRules): Promise<CrawlResult[]> {
    try {
      console.log(`Crawling static page: ${url}`);
      
      // 发起HTTP请求获取页面内容
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; FeedGen Bot/1.0)'
        },
        timeout: 10000
      });
      
      const $ = cheerio.load(response.data);
      const results: CrawlResult[] = [];

      // 将Tailwind类选择器转换为标准CSS选择器
      const convertToSelector = (selectorStr: string): string => {
        if (!selectorStr) return '';
        
        // 如果已经是标准CSS选择器，直接返回
        if (selectorStr.startsWith('.') || selectorStr.startsWith('#') || /^[a-zA-Z]/.test(selectorStr)) {
          return selectorStr;
        }
        
        // 将空格分隔的Tailwind类转换为CSS类选择器
        const classes = selectorStr.split(/\s+/).filter(cls => cls.trim());
        if (classes.length === 0) return '';
        
        // 将每个类名转换为CSS类选择器
        return '.' + classes.join('.');
      };

      // 转换选择器
      const itemSelector = convertToSelector(selectors.item);
      const titleSelector = convertToSelector(selectors.title);
      const linkSelector = convertToSelector(selectors.link);
      const descriptionSelector = selectors.description ? convertToSelector(selectors.description) : '';

      // 查找所有匹配的项目
      try {
        $(itemSelector).each((_, item) => {
          const $item = $(item);
          const title = $item.find(titleSelector).first().text().trim();
          const linkEl = $item.find(linkSelector).first();
          let link = linkEl.attr('href') || linkEl.text().trim();
          const description = descriptionSelector ? $item.find(descriptionSelector).first().text().trim() : '';

          // 处理相对链接
          if (link && !link.startsWith('http')) {
            try {
              const baseUrl = new URL(url);
              link = new URL(link, baseUrl.origin).href;
            } catch (e) {
              // 如果URL构建失败，跳过该项目
              return;
            }
          }

          if (title && link) {
            const result: CrawlResult = {
              title,
              link,
              description,
            };
            if (description) result.description = description;
            results.push(result);
          }
        });
      } catch (selectorError) {
        console.error(`Error processing selectors:`, selectorError);
        // 如果选择器有问题，尝试使用更通用的选择器
        console.log('Trying fallback selectors...');
        $(selectors.item.replace(/\s+/g, '.')).each((_, item) => {
          const $item = $(item);
          const title = $item.find(selectors.title).first().text().trim();
          const linkEl = $item.find(selectors.link).first();
          let link = linkEl.attr('href') || linkEl.text().trim();
          const description = selectors.description ? $item.find(selectors.description).first().text().trim() : '';

          // 处理相对链接
          if (link && !link.startsWith('http')) {
            try {
              const baseUrl = new URL(url);
              link = new URL(link, baseUrl.origin).href;
            } catch (e) {
              // 如果URL构建失败，跳过该项目
              return;
            }
          }

          if (title && link) {
            const result: CrawlResult = {
              title,
              link,
              description,
            };
            if (description) result.description = description;
            results.push(result);
          }
        });
      }

      return results;
    } catch (error) {
      console.error(`Error crawling static page ${url}:`, error);
      throw error;
    }
  }

  /**
   * 动态页面爬取（使用Playwright）
   */
  static async crawlDynamicPage(url: string, selectors: SelectorRules): Promise<CrawlResult[]> {
    let browser;
    try {
      console.log(`Crawling dynamic page: ${url}`);
      
      // 检查Playwright是否可用
      try {
        browser = await launchChromium({ args: getDefaultLaunchArgs() });
      } catch (launchError: any) {
        console.warn('Playwright browser not available, falling back to static crawling:', launchError.message);
        // 如果浏览器不可用，回退到静态爬取
        return this.crawlStaticPage(url, selectors);
      }
      
      const page = await browser.newPage();
      
      // stealth 插件已自动注册反检测补丁
      await applySupplementaryPatches(page);
      
      // 使用真实浏览器 UA，避免暴露 bot 身份
      await page.setExtraHTTPHeaders({
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
      });
      
      // 访问页面
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      
      // 等待页面加载完成
      await page.waitForSelector(selectors.item, { timeout: 10000 });
      
      // 执行爬取逻辑
      const results: any[] = await page.evaluate((rules: SelectorRules) => {
        const items: HTMLElement[] = Array.from(document.querySelectorAll(rules.item));
        
        return items.map(item => {
          const titleEl = item.querySelector(rules.title);
          const linkEl = item.querySelector(rules.link);
          const descEl = rules.description ? item.querySelector(rules.description) : null;
          const dateEl = rules.pubDate ? item.querySelector(rules.pubDate) : null;
          
          return {
            title: titleEl?.textContent?.trim() || '',
            link: linkEl?.getAttribute('href') || linkEl?.textContent?.trim() || '',
            description: descEl?.textContent?.trim() || '',
            pubDate: dateEl?.textContent?.trim() || undefined
          };
        }).filter(item => item.title && item.link); // 过滤掉标题或链接为空的项
      }, selectors);
      
      return results.map((item: any) => ({
        ...item,
        pubDate: item.pubDate ? new Date(item.pubDate) : undefined
      }));
    } catch (error) {
      console.error(`Error crawling dynamic page ${url}:`, error);
      // 如果动态爬取失败，尝试静态爬取作为备选方案
      try {
        return await this.crawlStaticPage(url, selectors);
      } catch (fallbackError) {
        console.error(`Fallback static crawling also failed:`, fallbackError);
        throw error; // 抛出原始错误
      }
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (closeError) {
          console.error('Error closing browser:', closeError);
        }
      }
    }
  }

  /**
   * 智能爬取（根据页面特征自动选择爬取方式）
   */
  static async crawl(url: string, selectors: SelectorRules, isDynamic: boolean = false): Promise<CrawlResult[]> {
    if (isDynamic) {
      return this.crawlDynamicPage(url, selectors);
    } else {
      return this.crawlStaticPage(url, selectors);
    }
  }

  /**
   * 验证选择器规则
   */
  static async validateSelectors(url: string, selectors: SelectorRules): Promise<boolean> {
    try {
      // 尝试使用提供的选择器进行一次测试爬取
      const testResults = await this.crawl(url, selectors);
      return testResults.length > 0;
    } catch (error) {
      console.error('Selector validation failed:', error);
      return false;
    }
  }
}
import { Feed } from 'feed';

interface FeedInfo {
  id: number;
  name: string;
  targetUrl: string;
}

interface FeedItem {
  title: string;
  link: string;
  description?: string;
  content?: string;
  pubDate?: Date;
}

export class FeedGeneratorService {
  /**
   * 生成RSS 2.0格式的Feed
   */
  static generateRSS(
    feedInfo: FeedInfo,
    items: FeedItem[],
    baseUrl: string
  ): string {
    const feed = new Feed({
      title: feedInfo.name,
      description: `Converted feed for ${feedInfo.targetUrl}`,
      id: `${baseUrl}/feeds/${feedInfo.id}`,
      link: feedInfo.targetUrl,
      language: 'zh-CN',
      image: `${baseUrl}/logo.png`,
      favicon: `${baseUrl}/favicon.ico`,
      copyright: `All rights reserved by original publishers`,
      generator: 'FeedGen Service',
      feedLinks: {
        rss: `${baseUrl}/api/feeds/${feedInfo.id}/rss.xml`,
        json: `${baseUrl}/api/feeds/${feedInfo.id}/json`,
      },
      author: {
        name: 'FeedGen Service',
        email: 'admin@feedgen.example.com',
        link: baseUrl,
      },
    });

    items.forEach(item => {
      feed.addItem({
        title: item.title,
        id: item.link,
        link: item.link,
        description: item.description || '',
        content: item.content || '',
        date: item.pubDate || new Date(),
      });
    });

    return feed.rss2();
  }

  /**
   * 生成Atom 1.0格式的Feed
   */
  static generateAtom(
    feedInfo: FeedInfo,
    items: FeedItem[],
    baseUrl: string
  ): string {
    const feed = new Feed({
      title: feedInfo.name,
      description: `Converted feed for ${feedInfo.targetUrl}`,
      id: `${baseUrl}/feeds/${feedInfo.id}`,
      link: feedInfo.targetUrl,
      language: 'zh-CN',
      image: `${baseUrl}/logo.png`,
      favicon: `${baseUrl}/favicon.ico`,
      copyright: `All rights reserved by original publishers`,
      generator: 'FeedGen Service',
      feedLinks: {
        atom: `${baseUrl}/api/feeds/${feedInfo.id}/atom.xml`,
        json: `${baseUrl}/api/feeds/${feedInfo.id}/json`,
      },
      author: {
        name: 'FeedGen Service',
        email: 'admin@feedgen.example.com',
        link: baseUrl,
      },
    });

    items.forEach(item => {
      feed.addItem({
        title: item.title,
        id: item.link,
        link: item.link,
        description: item.description || '',
        content: item.content || '',
        date: item.pubDate || new Date(),
      });
    });

    return feed.atom1();
  }

  /**
   * 生成JSON格式的Feed
   */
  static generateJSON(
    feedInfo: FeedInfo,
    items: FeedItem[],
    baseUrl: string
  ): string {
    const feedData = {
      version: 'https://jsonfeed.org/version/1.1',
      title: feedInfo.name,
      home_page_url: feedInfo.targetUrl,
      feed_url: `${baseUrl}/api/feeds/${feedInfo.id}/json`,
      description: `Converted feed for ${feedInfo.targetUrl}`,
      language: 'zh-CN',
      items: items.map(item => ({
        id: item.link,
        url: item.link,
        title: item.title,
        summary: item.description || '',
        content_html: item.content || '',
        date_published: item.pubDate ? item.pubDate.toISOString() : new Date().toISOString(),
      })),
    };

    return JSON.stringify(feedData, null, 2);
  }
}
/**
 * 分析页面结构以找出可能的文章列表
 */
export async function analyzePageStructure(url: string): Promise<any[]> {
  const { CrawlerService } = await import('./crawler');
  
  // 获取页面内容
  const axios = await import('axios');
  const cheerio = await import('cheerio');
  
  try {
    const response = await axios.default.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FeedGen Bot/1.0)'
      },
      timeout: 10000
    });
    
    const $ = cheerio.default.load(response.data);
    
    // 常见的文章/新闻项目选择器
    const commonSelectors = [
      { name: '新闻列表项 (.news-item)', selector: '.news-item', type: 'list' },
      { name: '文章卡片 (.article-card)', selector: '.article-card', type: 'card' },
      { name: '列表项 (.list-item)', selector: '.list-item', type: 'list' },
      { name: '帖子 (.post)', selector: '.post', type: 'post' },
      { name: '文章 (.article)', selector: '.article', type: 'article' },
      { name: '卡片 (.card)', selector: '.card', type: 'card' },
      { name: '面板 (.panel)', selector: '.panel', type: 'panel' },
      { name: '媒体项 (.media)', selector: '.media', type: 'media' },
      { name: 'Flex容器 ([class*="flex"] [class*="row"])', selector: '[class*="flex"] > div, [class*="row"] > div', type: 'flex' },
      { name: 'Grid项目 ([class*="grid"] [class*="col"])', selector: '[class*="grid"] > div, [class*="col"] > div', type: 'grid' },
      { name: '链接列表 (ul li a)', selector: 'ul li a', type: 'link-list' },
      { name: '新闻块 (.news-block)', selector: '.news-block', type: 'block' },
      { name: '资讯项 (.info-item)', selector: '.info-item', type: 'info' },
      { name: '条目 (.entry)', selector: '.entry', type: 'entry' },
      { name: '故事 (.story)', selector: '.story', type: 'story' }
    ];
    
    const results = [];
    
    // 测试每个选择器
    for (const selectorInfo of commonSelectors) {
      const items = $(selectorInfo.selector);
      if (items.length >= 2 && items.length <= 50) { // 至少2个，最多50个，避免误判
        const previewItems: Array<{ title: string; description: string }> = [];
        
        // 获取前3个项目作为预览
        items.each((index, element) => {
          if (index < 3) {
            const $el = $(element);
            
            // 尝试获取标题
            let title = '';
            const titleSelectors = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', '.title', '.headline', '.post-title', '.entry-title', '.article-title', '[class*="title"]', '[class*="headline"]', '[class*="heading"]', 'a'];
            for (const sel of titleSelectors) {
              const titleEl = $el.find(sel).first();
              if (titleEl.length && titleEl.text().trim()) {
                title = titleEl.text().trim().substring(0, 100);
                break;
              }
            }
            
            // 尝试获取描述
            let description = '';
            const descSelectors = ['.excerpt', '.summary', '.description', '.content', '.text', 'p', '[class*="excerpt"]', '[class*="summary"]', '[class*="desc"]', '[class*="content"]'];
            for (const sel of descSelectors) {
              const descEl = $el.find(sel).first();
              if (descEl.length && descEl.text().trim()) {
                description = descEl.text().trim().substring(0, 150);
                break;
              }
            }
            
            if (title) {
              previewItems.push({
                title: title,
                description: description
              });
            }
          }
        });
        
        if (previewItems.length > 0) {
          results.push({
            name: selectorInfo.name,
            count: items.length,
            selector: selectorInfo.selector,
            type: selectorInfo.type,
            preview: previewItems
          });
        }
      }
    }
    
    // 按项目数量排序，优先显示数量适中的结果
    results.sort((a, b) => {
      // 优先考虑数量在3-20之间的结果
      const scoreA = a.count >= 3 && a.count <= 20 ? 100 - Math.abs(a.count - 10) : Math.max(0, 20 - a.count);
      const scoreB = b.count >= 3 && b.count <= 20 ? 100 - Math.abs(b.count - 10) : Math.max(0, 20 - b.count);
      return scoreB - scoreA;
    });
    
    // 返回前5个最佳匹配
    return results.slice(0, 5);
  } catch (error) {
    console.error('Error analyzing page structure:', error);
    throw error;
  }
}

/**
 * 获取选择器选项
 */
export async function getSelectorOptions(url: string): Promise<any[]> {
  const selectors = await analyzePageStructure(url);
  
  // 将分析结果转换为可直接使用的规则
  return selectors.map(selector => {
    // 根据检测到的容器选择器，推断标题、链接和描述选择器
    const itemSelector = selector.selector;
    
    // 基于常见模式构建详细的选择器规则
    return {
      name: selector.name,
      selectors: {
        item: itemSelector,
        title: 'h1, h2, h3, h4, h5, h6, .title, .headline, .post-title, .entry-title, .article-title, [class*="title"], [class*="headline"], [class*="heading"], a',
        link: 'a',
        description: '.excerpt, .summary, .description, .content, .text, p, [class*="excerpt"], [class*="summary"], [class*="desc"], [class*="content"]'
      },
      count: selector.count,
      preview: selector.preview
    };
  });
}

/**
 * 验证URL格式
 */
export function isValidUrl(string: string): boolean {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

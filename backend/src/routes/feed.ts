import { FastifyPluginAsync } from 'fastify';
import type { Feed } from '@prisma/client';

// 从server.ts导入prisma实例
import { prisma } from '../server';
import { recordCrawlerTaskHistory } from '../services/crawlerTaskHistory';
import { translateAllArticlesForFeed, translateNewArticlesForFeed } from '../services/translation/articleTranslation';
import { articlesForDbInsert } from '../utils/articleInsertOrder';
import { pubDateForDb } from '../utils/pubDate';
import { applyPageLanguageToUrl } from '../utils/pageLanguage';

async function nextFeedSortOrder(userId: number): Promise<number> {
  const agg = await prisma.feed.aggregate({
    where: { user_id: userId },
    _max: { sort_order: true },
  });
  return (agg._max.sort_order ?? -1) + 1;
}

// 验证URL格式
function isValidUrl(string: string): boolean {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

const feedRoutes: FastifyPluginAsync = async (fastify) => {
  async function ensureLegacyUserPlanForUser(userId: number) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { current_plan_id: true },
    });
    const planId = user?.current_plan_id;
    if (planId == null) return;

    const config = await prisma.membership_plan_configs.findUnique({ where: { id: planId } });
    if (!config) return;

    await prisma.user_plans.upsert({
      where: { id: config.id },
      create: {
        id: config.id,
        name: config.name,
        description: config.description,
        max_feeds: config.max_feeds,
        duration_days: config.history_days || 365,
        updated_at: new Date(),
      },
      update: {
        name: config.name,
        description: config.description,
        max_feeds: config.max_feeds,
        duration_days: config.history_days || 365,
        updated_at: new Date(),
      },
    });
  }

  // 获取用户的所有feeds
  fastify.get('/', async (req: any, res: any) => {
    try {
      // 检查认证
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Authentication required' });
      }

      const token = authHeader.substring(7); // 移除 "Bearer " 前缀
      const decoded: any = await req.jwtVerify();
      const userId = decoded.userId;

      const feeds = await prisma.feed.findMany({
        where: { user_id: userId },
        orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
      });

      const feedIds = feeds.map((f: Feed) => f.id);
      const lastFinishedByFeed = new Map<number, Date>();
      if (feedIds.length > 0) {
        const aggregates = await prisma.crawlerTaskHistory.groupBy({
          by: ['feed_id'],
          where: {
            feed_id: { in: feedIds },
            finished_at: { not: null },
          },
          _max: { finished_at: true },
        });
        for (const row of aggregates) {
          if (row._max.finished_at != null) {
            lastFinishedByFeed.set(row.feed_id, row._max.finished_at);
          }
        }
      }

      const feedsOut = feeds.map((f: Feed) => ({
        ...f,
        last_crawl_finished_at: lastFinishedByFeed.get(f.id) ?? null,
      }));

      return { feeds: feedsOut };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Failed to fetch feeds' });
    }
  });

  // 创建新的feed
  fastify.post('/', async (req: any, res: any) => {
    try {
      // 检查认证
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Authentication required' });
      }

      const token = authHeader.substring(7); // 移除 "Bearer " 前缀
      const decoded: any = await req.jwtVerify();
      const userId = decoded.userId;
      
      const { name, targetUrl, description, feed_type, source_type, group_id, favicon_url, favicon_custom_text, favicon_custom_bg, use_proxy, needs_translation } = req.body as {
        name: string;
        targetUrl: string;
        description?: string;
        feed_type?: string;
        source_type?: string;
        group_id?: number | null;
        favicon_url?: string | null;
        favicon_custom_text?: string | null;
        favicon_custom_bg?: string | null;
        use_proxy?: boolean;
        needs_translation?: boolean;
      };

      await ensureLegacyUserPlanForUser(userId);

      const normalizedSourceType = source_type === 'parsed' ? 'parsed' : 'native';
      const faviconUrl = favicon_url ? String(favicon_url).trim() : '';
      if (faviconUrl && !isValidUrl(faviconUrl)) {
        return res.status(400).send({ error: 'favicon_url 必须是合法 URL' });
      }
      const faviconBg = favicon_custom_bg ? String(favicon_custom_bg).trim() : '';
      if (faviconBg && !/^#[0-9a-fA-F]{6}$/.test(faviconBg)) {
        return res.status(400).send({ error: 'favicon_custom_bg 必须为 #RRGGBB' });
      }

      const sortOrder = await nextFeedSortOrder(userId);

      const newFeed = await prisma.feed.create({
        data: {
          user_id: userId,
          title: name,
          description: description || '',
          url: targetUrl,
          feed_type: feed_type || 'rss',
          source_type: normalizedSourceType,
          group_id: group_id == null ? null : Number(group_id),
          favicon_url: faviconUrl ? faviconUrl.slice(0, 2000) : null,
          favicon_custom_text: favicon_custom_text ? String(favicon_custom_text).trim().slice(0, 12) : null,
          favicon_custom_bg: faviconBg ? faviconBg.slice(0, 16) : null,
          sort_order: sortOrder,
          use_proxy: use_proxy === true,
          needs_translation: needs_translation === true,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date()
        },
      });

      return { feed: newFeed };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Failed to create feed' });
    }
  });

  // 更新feed
  fastify.put('/:id', async (req: any, res: any) => {
    try {
      // 检查认证
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Authentication required' });
      }

      const token = authHeader.substring(7); // 移除 "Bearer " 前缀
      const decoded: any = await req.jwtVerify();
      const userId = decoded.userId;
      
      const feedId = parseInt(req.params.id as string);
      const {
        name,
        targetUrl,
        description,
        feed_type,
        source_type,
        group_id,
        status,
        is_active,
        update_interval,
        selector_rules,
        favicon_url,
        favicon_custom_text,
        favicon_custom_bg,
        sort_order,
        use_proxy,
        needs_translation,
      } = req.body as {
        name?: string;
        targetUrl?: string;
        description?: string;
        feed_type?: string;
        source_type?: string;
        group_id?: number | null;
        status?: string;
        is_active?: boolean;
        update_interval?: number;
        selector_rules?: unknown | null;
        favicon_url?: string | null;
        favicon_custom_text?: string | null;
        favicon_custom_bg?: string | null;
        sort_order?: number;
        use_proxy?: boolean;
        needs_translation?: boolean;
      };

      // 检查feed是否属于当前用户
      const existingFeed = await prisma.feed.findFirst({
        where: { id: feedId, user_id: userId },
      });

      if (!existingFeed) {
        return res.status(404).send({ error: 'Feed not found' });
      }

      const updateData: any = {};
      if (name !== undefined) {
        const t = name.trim().slice(0, 255);
        if (!t) {
          return res.status(400).send({ error: '标题不能为空' });
        }
        updateData.title = t;
      }
      if (targetUrl !== undefined) {
        if (targetUrl !== null && String(targetUrl).trim() !== '' && !isValidUrl(String(targetUrl).trim())) {
          return res.status(400).send({ error: '源站 URL 格式无效' });
        }
        updateData.url = targetUrl === null || String(targetUrl).trim() === '' ? null : String(targetUrl).trim().slice(0, 500);
      }
      if (description !== undefined) updateData.description = description;
      if (feed_type !== undefined) updateData.feed_type = String(feed_type).slice(0, 50);
      if (source_type !== undefined) {
        const st = String(source_type).trim();
        if (st !== 'native' && st !== 'parsed') {
          return res.status(400).send({ error: 'source_type 仅支持 native 或 parsed' });
        }
        updateData.source_type = st;
      }
      if (group_id !== undefined) {
        if (group_id === null) {
          updateData.group_id = null;
        } else {
          const gid = Number(group_id);
          if (!Number.isFinite(gid)) {
            return res.status(400).send({ error: 'group_id 无效' });
          }
          const group = await prisma.userFeedGroup.findFirst({
            where: { id: gid, user_id: userId },
            select: { id: true },
          });
          if (!group) {
            return res.status(404).send({ error: '分组不存在' });
          }
          updateData.group_id = gid;
        }
      }
      if (typeof is_active === 'boolean') {
        updateData.is_active = is_active;
      } else if (status !== undefined) {
        updateData.is_active = status === 'active';
      }
      if (update_interval !== undefined) {
        const n = Number(update_interval);
        if (!Number.isFinite(n) || n < 60 || n > 604800) {
          return res.status(400).send({ error: '更新间隔需在 60～604800 秒之间' });
        }
        updateData.update_interval = Math.floor(n);
      }
      if (selector_rules !== undefined) {
        if (selector_rules === null) {
          updateData.selector_rules = null;
        } else if (typeof selector_rules === 'object') {
          updateData.selector_rules = selector_rules as object;
        } else {
          return res.status(400).send({ error: 'selector_rules 须为 JSON 对象或 null' });
        }
      }
      if (favicon_url !== undefined) {
        const fav = favicon_url == null ? '' : String(favicon_url).trim();
        if (fav && !isValidUrl(fav)) {
          return res.status(400).send({ error: 'favicon_url 必须是合法 URL' });
        }
        updateData.favicon_url = fav ? fav.slice(0, 2000) : null;
      }
      if (favicon_custom_text !== undefined) {
        const text = favicon_custom_text == null ? '' : String(favicon_custom_text).trim();
        updateData.favicon_custom_text = text ? text.slice(0, 12) : null;
      }
      if (favicon_custom_bg !== undefined) {
        const color = favicon_custom_bg == null ? '' : String(favicon_custom_bg).trim();
        if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) {
          return res.status(400).send({ error: 'favicon_custom_bg 必须为 #RRGGBB' });
        }
        updateData.favicon_custom_bg = color || null;
      }
      if (sort_order !== undefined) {
        const n = Number(sort_order);
        if (!Number.isFinite(n) || n < 0 || n > 999999) {
          return res.status(400).send({ error: '排序值须为 0～999999 的整数' });
        }
        updateData.sort_order = Math.floor(n);
      }
      if (typeof use_proxy === 'boolean') {
        updateData.use_proxy = use_proxy;
      }
      if (typeof needs_translation === 'boolean') {
        updateData.needs_translation = needs_translation;
      }
      updateData.updated_at = new Date();

      const updatedFeed = await prisma.feed.update({
        where: { id: feedId },
        data: updateData,
      });

      return { feed: updatedFeed };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Failed to update feed' });
    }
  });

  // 手动触发 Feed 全量翻译（英文源 needs_translation）
  fastify.post('/:id/translate', async (req: any, res: any) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Authentication required' });
      }

      const decoded: any = await req.jwtVerify();
      const userId = decoded.userId;
      const feedId = parseInt(req.params.id as string);

      const existingFeed = await prisma.feed.findFirst({
        where: { id: feedId, user_id: userId },
        select: { id: true, needs_translation: true },
      });

      if (!existingFeed) {
        return res.status(404).send({ error: 'Feed not found' });
      }
      if (!existingFeed.needs_translation) {
        return res.status(400).send({ error: '该 Feed 未开启需要翻译' });
      }

      const result = await translateAllArticlesForFeed(feedId);
      return {
        message: `翻译完成：成功 ${result.translated} 篇，失败 ${result.failed} 篇`,
        ...result,
      };
    } catch (error) {
      req.log.error(error);
      const message = error instanceof Error ? error.message : '翻译失败';
      return res.status(500).send({ error: message });
    }
  });

  // 删除feed
  fastify.delete('/:id', async (req: any, res: any) => {
    try {
      // 检查认证
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Authentication required' });
      }

      const token = authHeader.substring(7); // 移除 "Bearer " 前缀
      const decoded: any = await req.jwtVerify();
      const userId = decoded.userId;
      
      const feedId = parseInt(req.params.id as string);

      // 检查feed是否属于当前用户
      const existingFeed = await prisma.feed.findFirst({
        where: { id: feedId, user_id: userId },
      });

      if (!existingFeed) {
        return res.status(404).send({ error: 'Feed not found' });
      }

      await prisma.feed.delete({
        where: { id: feedId },
      });

      return { message: 'Feed deleted successfully' };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Failed to delete feed' });
    }
  });

  // 通过可视化解析器创建feed
  fastify.post('/create-visual', async (req: any, res: any) => {
    try {
      const {
        url, title, selectorRules, group_id, use_proxy
      } = req.body as {
        url: string;
        title?: string;
        selectorRules: {
          listSelector: string;
          authCookie?: string;
          pageLanguage?: string;
          fingerprintProfile?: string;
          fields: Record<string, string | undefined>;
        };
        group_id?: number | null;
        use_proxy?: boolean;
      };

      if (!url || !selectorRules?.listSelector) {
        return res.status(400).send({ error: '缺少URL或列表选择器' });
      }

      // 获取或创建用户（支持可选认证）
      let userId: number;
      try {
        const decoded: any = await req.jwtVerify();
        userId = decoded.userId;
      } catch {
        // 未认证时创建匿名用户并分配免费套餐
        const anonUser = await prisma.user.create({
          data: {
            username: `user_${Date.now()}`,
            email: `anonymous_${Date.now()}_${Math.floor(Math.random() * 10000)}@example.com`,
            password_hash: '',
            is_anonymous: true,
            current_plan_id: 1,
          }
        });
        userId = anonUser.id;
      }

      // 确保旧套餐表与当前会员配置同步，避免数据库触发器按旧额度限制创建 Feed。
      await ensureLegacyUserPlanForUser(userId);

      let resolvedGroupId: number | null = null;
      if (group_id != null) {
        const gid = Number(group_id);
        if (!Number.isFinite(gid)) {
          return res.status(400).send({ error: 'group_id 无效' });
        }
        const group = await prisma.userFeedGroup.findFirst({
          where: { id: gid, user_id: userId },
          select: { id: true },
        });
        if (!group) {
          return res.status(404).send({ error: '分组不存在' });
        }
        resolvedGroupId = gid;
      }

      const sortOrder = await nextFeedSortOrder(userId);
      const authCookieValue = selectorRules.authCookie?.trim()
        ? String(selectorRules.authCookie).trim().slice(0, 8000)
        : null;
      const pageLanguage = selectorRules.pageLanguage?.trim() || '';
      const fingerprintProfile = selectorRules.fingerprintProfile?.trim() || '';
      const resolvedUrl = applyPageLanguageToUrl(url, pageLanguage);
      const storedSelectorRules = {
        ...selectorRules,
        ...(pageLanguage ? { pageLanguage } : {}),
        ...(fingerprintProfile ? { fingerprintProfile } : {}),
      };

      // 创建Feed记录
      const feed = await prisma.feed.create({
        data: {
          user_id: userId,
          title: title || new URL(resolvedUrl).hostname + ' Feed',
          description: `自动从 ${resolvedUrl} 生成的Feed`,
          url: resolvedUrl,
          feed_type: 'rss',
          source_type: 'parsed',
          group_id: resolvedGroupId,
          auth_cookie: authCookieValue,
          use_proxy: use_proxy === true,
          is_active: true,
          selector_rules: storedSelectorRules as any,
          update_interval: 1800,
          sort_order: sortOrder,
          created_at: new Date(),
          updated_at: new Date(),
        }
      });

      // 立即执行第一次爬取
      let articleCount = 0;
      const insertedForTranslation: Array<{ id: number; title: string; description: string | null }> = [];
      const crawlStartedAt = new Date();
      try {
        const { crawlWithVisualSelectors } = await import('../services/visualCrawler');
        const articles = await crawlWithVisualSelectors(resolvedUrl, storedSelectorRules, use_proxy === true);

        for (const item of articlesForDbInsert(articles)) {
          // 按URL去重
          if (item.url) {
            const existing = await prisma.article.findFirst({
              where: { feed_id: feed.id, url: item.url }
            });
            if (existing) continue;
          }

          try {
            const created = await prisma.article.create({
              data: {
                feed_id: feed.id,
                title: item.title || '无标题',
                description: item.description || null,
                url: item.url || null,
                thumbnail_url: item.thumbnail_url || null,
                author: item.author || null,
                pub_date: pubDateForDb(item.pub_date),
                created_at: new Date(),
                updated_at: new Date(),
              }
            });
            insertedForTranslation.push({
              id: created.id,
              title: created.title,
              description: created.description,
            });
            articleCount++;
          } catch (createErr) {
            console.warn(`首次爬取单条入库跳过: ${item.title}`, createErr);
          }
        }

        await translateNewArticlesForFeed(feed.id, insertedForTranslation);

        // 更新最后爬取时间
        await prisma.feed.update({
          where: { id: feed.id },
          data: { last_fetched_at: new Date() }
        });
        await recordCrawlerTaskHistory({
          feedId: feed.id,
          mode: 'api_visual',
          status: 'success',
          startedAt: crawlStartedAt,
          finishedAt: new Date(),
          newArticlesCount: articleCount,
        });
      } catch (crawlError) {
        console.error('首次爬取失败（Feed已创建）:', crawlError);
        await recordCrawlerTaskHistory({
          feedId: feed.id,
          mode: 'api_visual',
          status: 'failed',
          startedAt: crawlStartedAt,
          finishedAt: new Date(),
          errorMessage: crawlError instanceof Error ? crawlError.message : String(crawlError),
        });
      }

      const host = req.headers.host || req.hostname;
      const rssUrl = `${req.protocol}://${host}/api/feeds/${feed.id}/rss`;

      return {
        feed: feed,
        rssUrl: rssUrl,
        articleCount: articleCount,
        message: `Feed创建成功，已抓取 ${articleCount} 篇文章`
      };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Feed创建失败: ' + (error as Error).message });
    }
  });

  // 获取特定feed的RSS
  fastify.get('/:id/rss', async (req: any, res: any) => {
    try {
      const feedId = parseInt(req.params.id as string);

      const feed = await prisma.feed.findUnique({
        where: { id: feedId },
        include: {
          articles: {
            orderBy: { pub_date: 'desc' },
            take: 50
          }
        }
      });

      if (!feed) {
        return res.status(404).send({ error: 'Feed not found' });
      }

      const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      let rssItems = '';
      if (feed.articles && feed.articles.length > 0) {
        rssItems = feed.articles.map((article: any) => {
          let itemXml = `
  <item>
    <title><![CDATA[${article.title || ''}]]></title>
    <description><![CDATA[${article.content || article.description || ''}]]></description>
    <link>${escapeXml(article.url || '')}</link>
    <guid isPermaLink="${article.url ? 'true' : 'false'}">${escapeXml(article.url || String(article.id))}</guid>
    <pubDate>${article.pub_date ? new Date(article.pub_date).toUTCString() : new Date().toUTCString()}</pubDate>`;
          if (article.author) {
            itemXml += `\n    <dc:creator><![CDATA[${article.author}]]></dc:creator>`;
          }
          if (article.thumbnail_url) {
            itemXml += `\n    <media:content url="${escapeXml(article.thumbnail_url)}" medium="image" />`;
            itemXml += `\n    <media:thumbnail url="${escapeXml(article.thumbnail_url)}" />`;
          }
          itemXml += `\n  </item>`;
          return itemXml;
        }).join('\n');
      }

      const rssContent = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="/api/feeds/rss-style.xsl"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title><![CDATA[${feed.title}]]></title>
  <description><![CDATA[${feed.description || ''}]]></description>
  <link>${escapeXml(feed.url || '')}</link>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
  <ttl>30</ttl>
  ${rssItems}
</channel>
</rss>`;

      res.header('Content-Type', 'application/rss+xml; charset=utf-8');
      return rssContent;
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Failed to generate RSS feed' });
    }
  });
  
  // RSS XSLT 样式表（让浏览器渲染为可点击的HTML页面）
  fastify.get('/rss-style.xsl', async (req: any, res: any) => {
    const xsl = `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:media="http://search.yahoo.com/mrss/">
<xsl:output method="html" encoding="UTF-8" indent="yes"/>
<xsl:template match="/">
<html lang="zh-CN">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title><xsl:value-of select="/rss/channel/title"/> - RSS Feed</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f7fa;color:#2c3e50;line-height:1.6}
    .header{background:linear-gradient(135deg,#2c3e50,#3498db);color:#fff;padding:2rem;text-align:center}
    .header h1{font-size:1.6rem;margin-bottom:.5rem}
    .header p{opacity:.85;font-size:.95rem}
    .header a{color:#fff;text-decoration:underline}
    .container{max-width:800px;margin:0 auto;padding:1.5rem 1rem}
    .feed-info{background:#fff;border-radius:8px;padding:1rem 1.25rem;margin-bottom:1.5rem;box-shadow:0 1px 3px rgba(0,0,0,.08);font-size:.9rem;color:#666}
    .feed-info strong{color:#2c3e50}
    .item{background:#fff;border-radius:8px;padding:1.25rem;margin-bottom:1rem;box-shadow:0 1px 3px rgba(0,0,0,.08);transition:box-shadow .2s}
    .item:hover{box-shadow:0 3px 10px rgba(0,0,0,.12)}
    .item-title{font-size:1.1rem;font-weight:600;margin-bottom:.5rem}
    .item-title a{color:#2c3e50;text-decoration:none}
    .item-title a:hover{color:#3498db;text-decoration:underline}
    .item-meta{font-size:.8rem;color:#95a5a6;margin-bottom:.5rem;display:flex;gap:1rem;flex-wrap:wrap}
    .item-desc{font-size:.92rem;color:#555;line-height:1.7}
    .item-media{display:flex;gap:1rem;align-items:flex-start}
    .item-media img{width:120px;height:80px;object-fit:cover;border-radius:6px;flex-shrink:0}
    .item-link{display:inline-block;margin-top:.6rem;font-size:.85rem;color:#3498db;text-decoration:none}
    .item-link:hover{text-decoration:underline}
    .badge{display:inline-block;background:#e8f4f8;color:#2980b9;padding:2px 8px;border-radius:4px;font-size:.75rem}
  </style>
</head>
<body>
  <div class="header">
    <h1><xsl:value-of select="/rss/channel/title"/></h1>
    <p><xsl:value-of select="/rss/channel/description"/></p>
    <p style="margin-top:.5rem;font-size:.85rem">
      <xsl:text>源站: </xsl:text>
      <a><xsl:attribute name="href"><xsl:value-of select="/rss/channel/link"/></xsl:attribute><xsl:value-of select="/rss/channel/link"/></a>
    </p>
  </div>
  <div class="container">
    <div class="feed-info">
      <span class="badge">RSS Feed</span>
      <xsl:text> 共 </xsl:text><strong><xsl:value-of select="count(/rss/channel/item)"/></strong><xsl:text> 篇文章 · 最后更新: </xsl:text><xsl:value-of select="/rss/channel/lastBuildDate"/>
    </div>
    <xsl:for-each select="/rss/channel/item">
      <div class="item">
        <div class="item-media">
          <xsl:if test="media:thumbnail/@url">
            <img><xsl:attribute name="src"><xsl:value-of select="media:thumbnail/@url"/></xsl:attribute><xsl:attribute name="alt"><xsl:value-of select="title"/></xsl:attribute></img>
          </xsl:if>
          <div>
            <div class="item-title">
              <a target="_blank" rel="noopener noreferrer">
                <xsl:attribute name="href"><xsl:value-of select="link"/></xsl:attribute>
                <xsl:value-of select="title"/>
              </a>
            </div>
            <div class="item-meta">
              <span><xsl:value-of select="pubDate"/></span>
              <xsl:if test="dc:creator">
                <span>作者: <xsl:value-of select="dc:creator"/></span>
              </xsl:if>
            </div>
            <div class="item-desc"><xsl:value-of select="description"/></div>
            <a class="item-link" target="_blank" rel="noopener noreferrer">
              <xsl:attribute name="href"><xsl:value-of select="link"/></xsl:attribute>
              阅读全文 →
            </a>
          </div>
        </div>
      </div>
    </xsl:for-each>
  </div>
</body>
</html>
</xsl:template>
</xsl:stylesheet>`;
    res.header('Content-Type', 'application/xslt+xml; charset=utf-8');
    return xsl;
  });

  // 特定网站爬取功能
  fastify.post('/:id/scrape', async (req: any, res: any) => {
    try {
      // 检查认证
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Authentication required' });
      }

      const token = authHeader.substring(7); // 移除 "Bearer " 前缀
      const decoded: any = await req.jwtVerify();
      const userId = decoded.userId;
      
      const feedId = parseInt(req.params.id as string);
      const { url, selectors } = req.body as {
        url: string;
        selectors: {
          container: string;
          title: string;
          description: string
        }
      };

      // 检查feed是否属于当前用户
      const feed = await prisma.feed.findFirst({
        where: { id: feedId, user_id: userId },
      });

      if (!feed) {
        return res.status(404).send({ error: 'Feed not found' });
      }

      // 使用爬虫服务进行爬取
      const { CrawlerService } = await import('../services/crawler');
      
      // 构建选择器规则
      const selectorRules = {
        item: selectors.container,
        title: selectors.title,
        link: 'a', // 默认使用a标签作为链接
        description: selectors.description
      };

      const scrapeStartedAt = new Date();
      let articles: any[] = [];
      try {
        const crawledData = await CrawlerService.crawlDynamicPage(url, selectorRules);

        const insertedForTranslation: Array<{ id: number; title: string; description: string | null }> = [];
        // 保存爬取的数据到数据库（倒序入库，与源站列表顺序一致）
        for (const item of articlesForDbInsert(crawledData)) {
          // 处理相对链接
          let fullUrl = item.link;
          if (item.link && !item.link.startsWith('http')) {
            try {
              const baseUrl = new URL(url);
              fullUrl = new URL(item.link, baseUrl.origin).href;
            } catch (e) {
              // 如果URL构建失败，跳过该项目
              continue;
            }
          }

          const article = await prisma.article.create({
            data: {
              feed_id: feedId,
              title: item.title,
              content: item.description,
              description: item.description,
              url: fullUrl,
              pub_date: pubDateForDb(item.pubDate),
              created_at: new Date(),
              updated_at: new Date()
            }
          });
          
          articles.push(article);
          insertedForTranslation.push({
            id: article.id,
            title: article.title,
            description: article.description,
          });
        }

        await translateNewArticlesForFeed(feedId, insertedForTranslation);

        await recordCrawlerTaskHistory({
          feedId,
          mode: 'api_scrape',
          status: 'success',
          startedAt: scrapeStartedAt,
          finishedAt: new Date(),
          newArticlesCount: articles.length,
        });

        return {
          message: `Successfully scraped and saved ${articles.length} articles`,
          articles: articles
        };
      } catch (innerErr) {
        await recordCrawlerTaskHistory({
          feedId,
          mode: 'api_scrape',
          status: 'failed',
          startedAt: scrapeStartedAt,
          finishedAt: new Date(),
          errorMessage: innerErr instanceof Error ? innerErr.message : String(innerErr),
        });
        throw innerErr;
      }
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Failed to scrape website' });
    }
  });

  // 分析页面结构以找出可能的文章列表
  fastify.post('/analyze', async (req: any, res: any) => {
    try {
      // 检查认证
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Authentication required' });
      }

      const token = authHeader.substring(7); // 移除 "Bearer " 前缀
      const decoded: any = await req.jwtVerify();
      const userId = decoded.userId;
      
      const { url } = req.body as { url: string };

      if (!url || !isValidUrl(url)) {
        return res.status(400).send({ error: 'Invalid URL provided' });
      }

      // 使用爬虫服务分析页面结构
      const { analyzePageStructure } = await import('../services/feedGenerator');
      
      const selectors = await analyzePageStructure(url);
      
      return { selectors };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Failed to analyze page structure' });
    }
  });
  
  // 应用选择器规则到feed
  fastify.post('/:id/apply-selectors', async (req: any, res: any) => {
    try {
      // 检查认证
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Authentication required' });
      }

      const token = authHeader.substring(7); // 移除 "Bearer " 前缀
      const decoded: any = await req.jwtVerify();
      const userId = decoded.userId;
      
      const feedId = parseInt(req.params.id as string);
      const { url, optionIndex } = req.body as {
        url: string;
        optionIndex: number;
      };

      // 检查feed是否属于当前用户
      const feed = await prisma.feed.findFirst({
        where: { id: feedId, user_id: userId },
      });

      if (!feed) {
        return res.status(404).send({ error: 'Feed not found' });
      }

      // 获取预定义的选择器选项
      const { getSelectorOptions } = await import('../services/feedGenerator');
      const options = await getSelectorOptions(url);
      
      if (optionIndex < 0 || optionIndex >= options.length) {
        return res.status(400).send({ error: 'Invalid option index' });
      }
      
      const selectedOption = options[optionIndex];
      
      // 使用爬虫服务进行爬取
      const { CrawlerService } = await import('../services/crawler');
      
      // 构建选择器规则
      const selectorRules = {
        item: selectedOption.selectors.item,
        title: selectedOption.selectors.title,
        link: selectedOption.selectors.link || 'a',
        description: selectedOption.selectors.description
      };

      const applyStartedAt = new Date();
      let articles: any[] = [];
      try {
        const crawledData = await CrawlerService.crawlDynamicPage(url, selectorRules);

        const insertedForTranslation: Array<{ id: number; title: string; description: string | null }> = [];
        // 保存爬取的数据到数据库（倒序入库，与源站列表顺序一致）
        for (const item of articlesForDbInsert(crawledData)) {
          // 处理相对链接
          let fullUrl = item.link;
          if (item.link && !item.link.startsWith('http')) {
            try {
              const baseUrl = new URL(url);
              fullUrl = new URL(item.link, baseUrl.origin).href;
            } catch (e) {
              // 如果URL构建失败，跳过该项目
              continue;
            }
          }

          const article = await prisma.article.create({
            data: {
              feed_id: feedId,
              title: item.title,
              content: item.description,
              description: item.description,
              url: fullUrl,
              pub_date: pubDateForDb(item.pubDate),
              created_at: new Date(),
              updated_at: new Date()
            }
          });
          
          articles.push(article);
          insertedForTranslation.push({
            id: article.id,
            title: article.title,
            description: article.description,
          });
        }

        await translateNewArticlesForFeed(feedId, insertedForTranslation);

        await recordCrawlerTaskHistory({
          feedId,
          mode: 'api_apply_selectors',
          status: 'success',
          startedAt: applyStartedAt,
          finishedAt: new Date(),
          newArticlesCount: articles.length,
        });

        return {
          message: `Successfully applied selectors and saved ${articles.length} articles`,
          articles: articles
        };
      } catch (innerErr) {
        await recordCrawlerTaskHistory({
          feedId,
          mode: 'api_apply_selectors',
          status: 'failed',
          startedAt: applyStartedAt,
          finishedAt: new Date(),
          errorMessage: innerErr instanceof Error ? innerErr.message : String(innerErr),
        });
        throw innerErr;
      }
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Failed to apply selectors' });
    }
  });
};

export { feedRoutes };

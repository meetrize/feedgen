import { prisma } from '../../server';
import { isLocalProxyAvailable } from '../proxyConfig';
import {
  fetchBloombergFulltext,
  isBloombergArticleUrl,
} from './extractBloomberg';
import {
  extractJsonLdArticleBody,
  extractWithReadability,
  sanitizeArticleHtml,
  type ExtractedFulltext,
} from './extractFulltext';
import { fetchHtmlHttp, fetchHtmlPlaywright, looksBlocked } from './fetchPageHtml';
import {
  DEFAULT_FULLTEXT_CONFIG,
  FULLTEXT_JOB_KEY,
  FulltextConfig,
  parseFulltextConfig,
} from './fulltextConfig';

export type FulltextStatus = 'pending' | 'success' | 'failed' | 'skipped' | 'blocked';

async function loadConfig(): Promise<FulltextConfig> {
  const job = await prisma.systemJob.findUnique({
    where: { key: FULLTEXT_JOB_KEY },
    select: { config: true, enabled: true },
  });
  const cfg = parseFulltextConfig(job?.config);
  if (job && job.enabled === false) cfg.enabled = false;
  return cfg;
}

export async function getFulltextConfig(): Promise<FulltextConfig> {
  try {
    return await loadConfig();
  } catch {
    return { ...DEFAULT_FULLTEXT_CONFIG };
  }
}

async function setArticleStatus(articleId: number, status: FulltextStatus | null) {
  await prisma.article.update({
    where: { id: articleId },
    data: { fulltext_status: status, updated_at: new Date() },
  });
}

async function upsertFulltext(
  articleId: number,
  data: {
    status: FulltextStatus;
    body_html?: string | null;
    body_text?: string | null;
    word_count?: number;
    byte_size?: number;
    extractor?: string | null;
    http_status?: number | null;
    final_url?: string | null;
    error?: string | null;
    fetched_at?: Date | null;
  },
) {
  const now = new Date();
  await prisma.articleFulltext.upsert({
    where: { article_id: articleId },
    create: {
      article_id: articleId,
      status: data.status,
      body_html: data.body_html ?? null,
      body_text: data.body_text ?? null,
      word_count: data.word_count ?? 0,
      byte_size: data.byte_size ?? 0,
      extractor: data.extractor ?? null,
      http_status: data.http_status ?? null,
      final_url: data.final_url ?? null,
      error: data.error ?? null,
      fetched_at: data.fetched_at ?? (data.status === 'success' ? now : null),
      created_at: now,
      updated_at: now,
    },
    update: {
      status: data.status,
      body_html: data.body_html ?? null,
      body_text: data.body_text ?? null,
      word_count: data.word_count ?? 0,
      byte_size: data.byte_size ?? 0,
      extractor: data.extractor ?? null,
      http_status: data.http_status ?? null,
      final_url: data.final_url ?? null,
      error: data.error ?? null,
      fetched_at: data.fetched_at ?? (data.status === 'success' ? now : undefined),
      updated_at: now,
      // 正文更新后清空译文，避免与旧段落错位
      ...(data.status === 'success' && data.body_html != null
        ? {
            body_html_zh: null,
            body_text_zh: null,
            translation_status: null,
            translation_error: null,
            translation_segments: null,
            translation_source_hash: null,
            translated_at: null,
          }
        : {}),
    },
  });
  await setArticleStatus(articleId, data.status);
}

function truncateExtract(extracted: ExtractedFulltext, maxBytes: number): ExtractedFulltext {
  const htmlBytes = Buffer.byteLength(extracted.bodyHtml, 'utf8');
  if (htmlBytes <= maxBytes) return extracted;
  // 粗截断 HTML，再重新抽纯文本
  let cut = extracted.bodyHtml;
  while (Buffer.byteLength(cut, 'utf8') > maxBytes && cut.length > 200) {
    cut = cut.slice(0, Math.floor(cut.length * 0.85));
  }
  cut += '\n<!-- truncated -->';
  return sanitizeArticleHtml(cut);
}

function acceptExtract(
  extracted: ExtractedFulltext | null,
  minTextLength: number,
): extracted is ExtractedFulltext {
  return !!extracted && extracted.wordCount >= minTextLength && extracted.bodyText.length >= Math.min(80, minTextLength);
}

/** 若 RSS/描述已是长文，直接落库，免请求 */
export async function tryStoreRssFulltext(
  articleId: number,
  htmlOrText: string,
  opts?: { minTextLength?: number; maxBytes?: number },
): Promise<boolean> {
  const minTextLength = opts?.minTextLength ?? DEFAULT_FULLTEXT_CONFIG.minTextLength;
  const maxBytes = opts?.maxBytes ?? DEFAULT_FULLTEXT_CONFIG.maxBytes;
  const raw = String(htmlOrText || '').trim();
  if (!raw) return false;

  const looksHtml = /<[a-z][\s\S]*>/i.test(raw);
  let extracted = looksHtml ? sanitizeArticleHtml(raw) : sanitizeArticleHtml(`<p>${raw}</p>`);
  if (!acceptExtract(extracted, minTextLength)) return false;
  extracted = truncateExtract(extracted, maxBytes);
  const byteSize = Buffer.byteLength(extracted.bodyHtml, 'utf8');

  await upsertFulltext(articleId, {
    status: 'success',
    body_html: extracted.bodyHtml,
    body_text: extracted.bodyText,
    word_count: extracted.wordCount,
    byte_size: byteSize,
    extractor: 'rss',
    fetched_at: new Date(),
    error: null,
  });
  return true;
}

export async function shouldEnqueueFulltext(
  articleId: number,
  stars: number,
  config?: FulltextConfig,
): Promise<boolean> {
  const cfg = config || (await getFulltextConfig());
  if (!cfg.enabled) return false;
  if (cfg.minStars > 0 && stars < cfg.minStars) return false;

  const existing = await prisma.articleFulltext.findUnique({
    where: { article_id: articleId },
    select: { status: true },
  });
  if (existing?.status === 'success') return false;
  return true;
}

/**
 * 抓取并抽取单篇正文。
 */
export async function fetchArticleFulltext(
  articleId: number,
  options?: { force?: boolean; config?: FulltextConfig },
): Promise<{ status: FulltextStatus; wordCount?: number; error?: string }> {
  const cfg = options?.config || (await getFulltextConfig());
  if (!cfg.enabled && !options?.force) {
    return { status: 'skipped', error: 'fulltext disabled' };
  }

  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: {
      id: true,
      title: true,
      url: true,
      description: true,
      content: true,
      fulltext: { select: { status: true } },
      feeds: { select: { use_proxy: true } },
      public_feed: { select: { use_proxy: true } },
    },
  });

  if (!article) {
    return { status: 'failed', error: 'article not found' };
  }

  if (!options?.force && article.fulltext?.status === 'success') {
    return { status: 'success' };
  }

  await upsertFulltext(articleId, { status: 'pending', error: null });

  const url = String(article.url || '').trim();
  const bloomberg = isBloombergArticleUrl(url);
  // 彭博 RSS 常只有试读段（约几十到百词），默认 minTextLength=200 会误杀
  const rssMin = bloomberg ? Math.min(cfg.minTextLength, 60) : cfg.minTextLength;

  // 1) 已有长描述/旧 content 可当 RSS 全文
  const candidates = [article.content, article.description].filter(Boolean) as string[];
  for (const c of candidates) {
    const ok = await tryStoreRssFulltext(articleId, c, {
      minTextLength: rssMin,
      maxBytes: cfg.maxBytes,
    });
    if (ok) {
      const row = await prisma.articleFulltext.findUnique({
        where: { article_id: articleId },
        select: { word_count: true },
      });
      return { status: 'success', wordCount: row?.word_count };
    }
  }

  if (!url || !/^https?:\/\//i.test(url)) {
    await upsertFulltext(articleId, {
      status: 'skipped',
      error: '无有效原文链接',
      fetched_at: new Date(),
    });
    return { status: 'skipped', error: '无有效原文链接' };
  }

  let useProxy = !!(article.feeds?.use_proxy || article.public_feed?.use_proxy);
  // 彭博直连极易被 PerimeterX 403；本机代理可用时自动启用
  if (!useProxy && bloomberg) {
    useProxy = await isLocalProxyAvailable();
  }

  let html = '';
  let finalUrl = url;
  let httpStatus = 0;
  let extractor: string = 'readability';

  try {
    // 彭博：axios story API → Jina Reader → Playwright（避免裸 HTTP 403 直接判 blocked）
    if (bloomberg) {
      try {
        const bb = await fetchBloombergFulltext(url, useProxy);
        const bbMin = Math.min(cfg.minTextLength, 60);
        if (acceptExtract(bb, bbMin)) {
          const trimmed = truncateExtract(bb, cfg.maxBytes);
          const byteSize = Buffer.byteLength(trimmed.bodyHtml, 'utf8');
          await upsertFulltext(articleId, {
            status: 'success',
            body_html: trimmed.bodyHtml,
            body_text: trimmed.bodyText,
            word_count: trimmed.wordCount,
            byte_size: byteSize,
            extractor: 'bloomberg_api',
            http_status: 200,
            final_url: url,
            error: null,
            fetched_at: new Date(),
          });
          return { status: 'success', wordCount: trimmed.wordCount };
        }
        await upsertFulltext(articleId, {
          status: 'blocked',
          http_status: 403,
          final_url: url,
          extractor: 'bloomberg_api',
          error: '彭博 PerimeterX/付费墙拦截，未能取到正文或试读段（请确认本机代理可用后重试）',
          fetched_at: new Date(),
        });
        return {
          status: 'blocked',
          error: '彭博 PerimeterX/付费墙拦截，未能取到正文或试读段（请确认本机代理可用后重试）',
        };
      } catch (bbErr) {
        const msg = bbErr instanceof Error ? bbErr.message : String(bbErr);
        console.warn(`[fulltext] bloomberg_api failed articleId=${articleId}:`, msg);
        await upsertFulltext(articleId, {
          status: 'blocked',
          http_status: /403/.test(msg) ? 403 : null,
          final_url: url,
          extractor: 'bloomberg_api',
          error: `彭博抓取失败：${msg.slice(0, 500)}`,
          fetched_at: new Date(),
        });
        return { status: 'blocked', error: `彭博抓取失败：${msg}` };
      }
    }

    const httpResult = await fetchHtmlHttp(url, useProxy);
    html = httpResult.html;
    finalUrl = httpResult.finalUrl;
    httpStatus = httpResult.httpStatus;

    if (looksBlocked(html, httpStatus)) {
      if (!cfg.usePlaywrightFallback) {
        await upsertFulltext(articleId, {
          status: 'blocked',
          http_status: httpStatus,
          final_url: finalUrl,
          error: '疑似反爬/付费墙',
          fetched_at: new Date(),
        });
        return { status: 'blocked', error: '疑似反爬/付费墙' };
      }
    }

    let extracted = extractWithReadability(html, finalUrl);
    if (!acceptExtract(extracted, cfg.minTextLength)) {
      const ld = extractJsonLdArticleBody(html);
      if (ld) {
        const fromLd = /</.test(ld) ? sanitizeArticleHtml(ld) : sanitizeArticleHtml(`<p>${ld}</p>`);
        if (acceptExtract(fromLd, cfg.minTextLength)) extracted = fromLd;
      }
    }

    if (!acceptExtract(extracted, cfg.minTextLength) && cfg.usePlaywrightFallback) {
      const pw = await fetchHtmlPlaywright(url);
      html = pw.html;
      finalUrl = pw.finalUrl;
      httpStatus = pw.httpStatus || httpStatus;
      extractor = 'playwright_readability';
      if (looksBlocked(html, httpStatus)) {
        await upsertFulltext(articleId, {
          status: 'blocked',
          http_status: httpStatus,
          final_url: finalUrl,
          error: '疑似反爬/付费墙（Playwright）',
          fetched_at: new Date(),
        });
        return { status: 'blocked', error: '疑似反爬/付费墙' };
      }
      extracted = extractWithReadability(html, finalUrl);
    }

    const extractedCount = extracted && typeof extracted.wordCount === 'number' ? extracted.wordCount : 0;
    if (!acceptExtract(extracted, cfg.minTextLength)) {
      await upsertFulltext(articleId, {
        status: 'failed',
        http_status: httpStatus,
        final_url: finalUrl,
        extractor,
        error: `正文过短或抽取失败（wordCount=${extractedCount}）`,
        fetched_at: new Date(),
      });
      return {
        status: 'failed',
        error: '正文过短或抽取失败',
        wordCount: extractedCount,
      };
    }

    const trimmed = truncateExtract(extracted, cfg.maxBytes);
    const byteSize = Buffer.byteLength(trimmed.bodyHtml, 'utf8');
    await upsertFulltext(articleId, {
      status: 'success',
      body_html: trimmed.bodyHtml,
      body_text: trimmed.bodyText,
      word_count: trimmed.wordCount,
      byte_size: byteSize,
      extractor,
      http_status: httpStatus,
      final_url: finalUrl,
      error: null,
      fetched_at: new Date(),
    });
    return { status: 'success', wordCount: trimmed.wordCount };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const blocked = /403|401|451|captcha|denied/i.test(msg);
    const status: FulltextStatus = blocked ? 'blocked' : 'failed';
    await upsertFulltext(articleId, {
      status,
      http_status: httpStatus || null,
      final_url: finalUrl,
      error: msg.slice(0, 2000),
      fetched_at: new Date(),
    });
    return { status, error: msg };
  }
}

/** 积压补扫：已评分达阈值、尚无 success 正文 */
export async function findFulltextBackfillIds(
  config?: FulltextConfig,
): Promise<number[]> {
  const cfg = config || (await getFulltextConfig());
  const limit = cfg.backfillLimit;
  const retrySince =
    cfg.retryFailedDays > 0
      ? new Date(Date.now() - cfg.retryFailedDays * 24 * 60 * 60 * 1000)
      : null;

  const rows = (await prisma.$queryRawUnsafe(
    `
    SELECT a.id
    FROM articles a
    INNER JOIN article_importance ai ON ai.article_id = a.id
    LEFT JOIN article_fulltexts f ON f.article_id = a.id
    WHERE ($1::int = 0 OR ai.stars >= $1)
      AND COALESCE(f.status, '') IS DISTINCT FROM 'success'
      AND COALESCE(f.status, '') IS DISTINCT FROM 'blocked'
      AND (
        f.article_id IS NULL
        OR f.status IN ('pending', 'skipped')
        OR (
          f.status = 'failed'
          AND ($2::timestamptz IS NULL OR f.updated_at >= $2::timestamptz)
        )
      )
    ORDER BY ai.stars DESC, a.id DESC
    LIMIT $3
    `,
    cfg.minStars,
    retrySince,
    limit,
  )) as Array<{ id: number }>;

  return rows
    .map((r: { id: number }) => Number(r.id))
    .filter((id: number) => Number.isFinite(id) && id > 0);
}

export async function runFulltextBackfill(options?: {
  config?: FulltextConfig;
  onProgress?: (p: {
    progress: number;
    progressText: string;
    stats: Record<string, number>;
  }) => Promise<void> | void;
  shouldCancel?: () => Promise<boolean>;
}): Promise<Record<string, number | boolean>> {
  const cfg = options?.config || (await getFulltextConfig());
  const ids = await findFulltextBackfillIds(cfg);
  let success = 0;
  let failed = 0;
  let skipped = 0;
  let blocked = 0;
  let processed = 0;
  let cancelled = false;

  for (const id of ids) {
    if (options?.shouldCancel && (await options.shouldCancel())) {
      cancelled = true;
      break;
    }
    const result = await fetchArticleFulltext(id, { config: cfg });
    processed += 1;
    if (result.status === 'success') success += 1;
    else if (result.status === 'blocked') blocked += 1;
    else if (result.status === 'skipped') skipped += 1;
    else failed += 1;

    await options?.onProgress?.({
      progress: ids.length ? Math.min(99, Math.round((processed / ids.length) * 100)) : 100,
      progressText: `正文 ${processed}/${ids.length}`,
      stats: { total: ids.length, processed, success, failed, skipped, blocked },
    });
  }

  await options?.onProgress?.({
    progress: cancelled ? 99 : 100,
    progressText: cancelled ? '已取消' : `完成 ${processed} 篇`,
    stats: { total: ids.length, processed, success, failed, skipped, blocked },
  });

  return { total: ids.length, processed, success, failed, skipped, blocked, cancelled };
}

import { createHash } from 'crypto';
import { JSDOM } from 'jsdom';

import { prisma } from '../../server';
import { getEffectiveTranslationConfig } from '../translation/translationConfig';
import { isTranslationEnabled, textTranslateEnToZh } from '../translation/translateClient';

export type FulltextTranslationSegment = {
  en: string;
  zh: string;
  tag?: string;
};

export type FulltextTranslateResult = {
  translation_status: string;
  body_html_zh: string | null;
  body_text_zh: string | null;
  translation_segments: FulltextTranslationSegment[] | null;
  error: string | null;
  translated_at: Date | null;
};

export type FulltextTranslateProgress = {
  articleId: number;
  status: 'idle' | 'running' | 'success' | 'failed' | 'skipped';
  done: number;
  total: number;
  percent: number;
  error: string | null;
  updatedAt: number;
};

const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, li, blockquote';
const TRANSLATE_CONCURRENCY = 2;
const MIN_TRANSLATE_CHARS = 8;

const translateProgressByArticle = new Map<number, FulltextTranslateProgress>();

function setTranslateProgress(
  articleId: number,
  patch: Partial<Omit<FulltextTranslateProgress, 'articleId' | 'percent' | 'updatedAt'>> & {
    done?: number;
    total?: number;
  },
): FulltextTranslateProgress {
  const prev = translateProgressByArticle.get(articleId);
  const total = Math.max(0, Number(patch.total ?? prev?.total ?? 0) || 0);
  const done = Math.max(0, Math.min(total, Number(patch.done ?? prev?.done ?? 0) || 0));
  const next: FulltextTranslateProgress = {
    articleId,
    status: patch.status ?? prev?.status ?? 'idle',
    done,
    total,
    percent: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0,
    error: patch.error !== undefined ? patch.error : prev?.error ?? null,
    updatedAt: Date.now(),
  };
  translateProgressByArticle.set(articleId, next);
  return next;
}

export function getFulltextTranslateProgress(articleId: number): FulltextTranslateProgress | null {
  return translateProgressByArticle.get(articleId) ?? null;
}

function hashSource(html: string): string {
  return createHash('sha256').update(String(html || ''), 'utf8').digest('hex').slice(0, 64);
}

function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function looksMostlyEnglish(text: string): boolean {
  const raw = String(text || '').trim();
  if (raw.length < 20) return false;
  const letters = raw.replace(/\s+/g, '');
  if (!letters) return false;
  const latin = (letters.match(/[A-Za-z]/g) || []).length;
  const cjk = (letters.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjk > latin * 0.35 && cjk > 20) return false;
  return latin / Math.max(letters.length, 1) >= 0.35;
}

type BlockPiece = { tag: string; text: string };

function extractBlocks(bodyHtml: string, bodyTextFallback: string): BlockPiece[] {
  const html = String(bodyHtml || '').trim();
  if (!html) {
    const t = String(bodyTextFallback || '').trim();
    return t ? [{ tag: 'p', text: t }] : [];
  }

  const dom = new JSDOM(`<body>${html}</body>`);
  const nodes = Array.from(dom.window.document.querySelectorAll(BLOCK_SELECTOR));
  const blocks: BlockPiece[] = [];
  for (const el of nodes) {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const tag = (el.tagName || 'P').toLowerCase();
    blocks.push({ tag: ['h1', 'h2', 'h3', 'h4', 'li', 'blockquote'].includes(tag) ? tag : 'p', text });
  }

  if (blocks.length) return blocks;

  const plain = (dom.window.document.body?.textContent || bodyTextFallback || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return [];
  // 无块结构时按空行切
  const parts = plain.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) return parts.map((text) => ({ tag: 'p', text }));
  return [{ tag: 'p', text: plain }];
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx]!, idx);
    }
  };
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => run()));
  return results;
}

function segmentsToHtml(segments: FulltextTranslationSegment[]): string {
  return segments
    .map((seg) => {
      const tag = seg.tag && /^[a-z][a-z0-9]*$/i.test(seg.tag) ? seg.tag.toLowerCase() : 'p';
      return `<${tag}>${escapeHtml(seg.zh || seg.en || '')}</${tag}>`;
    })
    .join('\n');
}

function segmentsToText(segments: FulltextTranslationSegment[]): string {
  return segments
    .map((s) => String(s.zh || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

async function assertArticleAccessible(
  userId: number,
  articleId: number,
): Promise<{
  articleId: number;
  feedId: number | null;
  needsTranslation: boolean;
  bodyHtml: string;
  bodyText: string;
  sourceHash: string;
  translationStatus: string | null;
  translationSourceHash: string | null;
  bodyHtmlZh: string | null;
  bodyTextZh: string | null;
  translationSegments: FulltextTranslationSegment[] | null;
  translatedAt: Date | null;
  translationError: string | null;
}> {
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: {
      id: true,
      feed_id: true,
      feeds: {
        select: {
          user_id: true,
          needs_translation: true,
        },
      },
      public_feed: {
        select: {
          subscriptions: {
            where: { user_id: userId, is_active: true },
            select: { id: true, needs_translation: true },
            take: 1,
          },
        },
      },
      fulltext: {
        select: {
          status: true,
          body_html: true,
          body_text: true,
          body_html_zh: true,
          body_text_zh: true,
          translation_status: true,
          translation_error: true,
          translated_at: true,
          translation_source_hash: true,
          translation_segments: true,
        },
      },
    },
  });

  if (!article) {
    throw Object.assign(new Error('文章不存在'), { statusCode: 404 });
  }

  const ownsPrivate = !!(article.feeds && article.feeds.user_id === userId);
  const sub = article.public_feed?.subscriptions?.[0];
  const ownsPublic = !!sub;
  if (!ownsPrivate && !ownsPublic) {
    throw Object.assign(new Error('无权限操作该文章'), { statusCode: 403 });
  }

  const ft = article.fulltext;
  if (!ft || ft.status !== 'success' || !String(ft.body_html || '').trim()) {
    throw Object.assign(new Error('请先抓取正文后再翻译'), { statusCode: 400 });
  }

  const bodyHtml = String(ft.body_html || '');
  const bodyText = String(ft.body_text || '');
  const needsTranslation = ownsPrivate
    ? article.feeds?.needs_translation === true
    : sub?.needs_translation === true;

  let segments: FulltextTranslationSegment[] | null = null;
  if (Array.isArray(ft.translation_segments)) {
    segments = ft.translation_segments as FulltextTranslationSegment[];
  }

  return {
    articleId: article.id,
    feedId: article.feed_id,
    needsTranslation,
    bodyHtml,
    bodyText,
    sourceHash: hashSource(bodyHtml),
    translationStatus: ft.translation_status || null,
    translationSourceHash: ft.translation_source_hash || null,
    bodyHtmlZh: ft.body_html_zh || null,
    bodyTextZh: ft.body_text_zh || null,
    translationSegments: segments,
    translatedAt: ft.translated_at || null,
    translationError: ft.translation_error || null,
  };
}

function toResult(row: {
  translationStatus: string | null;
  bodyHtmlZh: string | null;
  bodyTextZh: string | null;
  translationSegments: FulltextTranslationSegment[] | null;
  translationError: string | null;
  translatedAt: Date | null;
}): FulltextTranslateResult {
  return {
    translation_status: row.translationStatus || 'none',
    body_html_zh: row.bodyHtmlZh,
    body_text_zh: row.bodyTextZh,
    translation_segments: row.translationSegments,
    error: row.translationError,
    translated_at: row.translatedAt,
  };
}

/**
 * 翻译文章正文（按 HTML 块对齐）。
 * @param options.auto 自动触发时要求 Feed 已开启 needs_translation
 * @param options.force 强制重翻（忽略已有 success）
 */
export async function translateArticleFulltextForUser(
  articleId: number,
  userId: number,
  options?: { force?: boolean; auto?: boolean },
): Promise<FulltextTranslateResult> {
  if (!(await isTranslationEnabled(userId))) {
    throw Object.assign(new Error('请先在设置页配置并启用翻译服务'), { statusCode: 400 });
  }

  const ctx = await assertArticleAccessible(userId, articleId);
  if (options?.auto && !ctx.needsTranslation) {
    throw Object.assign(new Error('该 Feed 未开启需要翻译'), { statusCode: 403 });
  }

  const force = !!options?.force;
  const hashFresh =
    ctx.translationStatus === 'success' &&
    ctx.translationSourceHash === ctx.sourceHash &&
    !!ctx.bodyHtmlZh;

  if (!force && hashFresh) {
    setTranslateProgress(articleId, {
      status: 'success',
      done: 1,
      total: 1,
      error: null,
    });
    return toResult(ctx);
  }

  if (!force && ctx.translationStatus === 'pending') {
    const running = getFulltextTranslateProgress(articleId);
    if (running?.status === 'running') {
      return toResult({
        ...ctx,
        translationStatus: 'pending',
      });
    }
    return toResult({
      ...ctx,
      translationStatus: 'pending',
    });
  }

  if (!looksMostlyEnglish(ctx.bodyText || ctx.bodyHtml)) {
    await prisma.articleFulltext.update({
      where: { article_id: articleId },
      data: {
        translation_status: 'skipped',
        translation_error: '正文非英文，已跳过翻译',
        updated_at: new Date(),
      },
    });
    setTranslateProgress(articleId, {
      status: 'skipped',
      done: 0,
      total: 0,
      error: '正文非英文，已跳过翻译',
    });
    return {
      translation_status: 'skipped',
      body_html_zh: null,
      body_text_zh: null,
      translation_segments: null,
      error: '正文非英文，已跳过翻译',
      translated_at: null,
    };
  }

  const blocks = extractBlocks(ctx.bodyHtml, ctx.bodyText);
  if (!blocks.length) {
    await prisma.articleFulltext.update({
      where: { article_id: articleId },
      data: {
        translation_status: 'failed',
        translation_error: '无可翻译正文段落',
        updated_at: new Date(),
      },
    });
    setTranslateProgress(articleId, {
      status: 'failed',
      done: 0,
      total: 0,
      error: '无可翻译正文段落',
    });
    return {
      translation_status: 'failed',
      body_html_zh: null,
      body_text_zh: null,
      translation_segments: null,
      error: '无可翻译正文段落',
      translated_at: null,
    };
  }

  await prisma.articleFulltext.update({
    where: { article_id: articleId },
    data: {
      translation_status: 'pending',
      translation_error: null,
      updated_at: new Date(),
    },
  });
  setTranslateProgress(articleId, {
    status: 'running',
    done: 0,
    total: blocks.length,
    error: null,
  });

  try {
    const translationConfig = await getEffectiveTranslationConfig(userId);
    // Gemini 免费档：正文批次并发降为 1，具体间隔由 geminiClient 限流
    const concurrency =
      translationConfig?.provider === 'gemini' ? 1 : TRANSLATE_CONCURRENCY;
    let completed = 0;
    const translatedTexts = await mapPool(blocks, concurrency, async (block) => {
      let zh = block.text;
      if (block.text.length >= MIN_TRANSLATE_CHARS && /[A-Za-z]{3,}/.test(block.text)) {
        zh = await textTranslateEnToZh(userId, block.text);
      }
      completed += 1;
      setTranslateProgress(articleId, {
        status: 'running',
        done: completed,
        total: blocks.length,
        error: null,
      });
      return zh;
    });

    const segments: FulltextTranslationSegment[] = blocks.map((block, i) => ({
      tag: block.tag,
      en: block.text,
      zh: String(translatedTexts[i] || block.text).trim() || block.text,
    }));

    const bodyHtmlZh = segmentsToHtml(segments);
    const bodyTextZh = segmentsToText(segments);
    const translatedAt = new Date();

    await prisma.articleFulltext.update({
      where: { article_id: articleId },
      data: {
        body_html_zh: bodyHtmlZh,
        body_text_zh: bodyTextZh,
        translation_status: 'success',
        translation_error: null,
        translated_at: translatedAt,
        translation_source_hash: ctx.sourceHash,
        translation_segments: segments as any,
        updated_at: translatedAt,
      },
    });

    setTranslateProgress(articleId, {
      status: 'success',
      done: blocks.length,
      total: blocks.length,
      error: null,
    });

    return {
      translation_status: 'success',
      body_html_zh: bodyHtmlZh,
      body_text_zh: bodyTextZh,
      translation_segments: segments,
      error: null,
      translated_at: translatedAt,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await prisma.articleFulltext.update({
      where: { article_id: articleId },
      data: {
        translation_status: 'failed',
        translation_error: msg.slice(0, 2000),
        updated_at: new Date(),
      },
    });
    const prev = getFulltextTranslateProgress(articleId);
    setTranslateProgress(articleId, {
      status: 'failed',
      done: prev?.done ?? 0,
      total: prev?.total ?? blocks.length,
      error: msg.slice(0, 500),
    });
    throw Object.assign(new Error(msg), { statusCode: 500 });
  }
}

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import sanitizeHtml from 'sanitize-html';

export type ExtractedFulltext = {
  bodyHtml: string;
  bodyText: string;
  wordCount: number;
  title?: string;
};

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    'img',
    'h1',
    'h2',
    'h3',
    'h4',
    'figure',
    'figcaption',
    'picture',
    'source',
  ]),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    a: ['href', 'name', 'target', 'rel', 'title'],
    source: ['src', 'srcset', 'type'],
    '*': ['class'],
  },
  allowedSchemes: ['http', 'https', 'data', 'mailto'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
  },
};

function countWords(text: string): number {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return 0;
  // 中文按字符近似，英文按词
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = t
    .replace(/[\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return cjk + latin;
}

/** 从任意 HTML 片段清洗并生成纯文本 */
export function sanitizeArticleHtml(html: string): ExtractedFulltext {
  const bodyHtml = sanitizeHtml(String(html || ''), SANITIZE_OPTIONS).trim();
  const dom = new JSDOM(`<body>${bodyHtml}</body>`);
  const bodyText = (dom.window.document.body?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    bodyHtml,
    bodyText,
    wordCount: countWords(bodyText),
  };
}

/** Mozilla Readability 抽取主文 */
export function extractWithReadability(html: string, url: string): ExtractedFulltext | null {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article?.content) return null;
    const cleaned = sanitizeArticleHtml(article.content);
    if (!cleaned.bodyText) return null;
    return {
      ...cleaned,
      ...(article.title ? { title: article.title } : {}),
    };
  } catch {
    return null;
  }
}

/** 尝试 JSON-LD articleBody 作为补强 */
export function extractJsonLdArticleBody(html: string): string | null {
  try {
    const dom = new JSDOM(html);
    const scripts = Array.from(dom.window.document.querySelectorAll('script[type="application/ld+json"]'));
    for (const s of scripts) {
      const raw = s.textContent || '';
      if (!raw.trim()) continue;
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        continue;
      }
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const o = node as Record<string, unknown>;
        const graph = o['@graph'];
        const candidates = Array.isArray(graph) ? graph : [o];
        for (const c of candidates) {
          if (!c || typeof c !== 'object') continue;
          const body = (c as Record<string, unknown>).articleBody;
          if (typeof body === 'string' && body.trim().length > 80) return body.trim();
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

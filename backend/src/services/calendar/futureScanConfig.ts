import {
  DEFAULT_DEDUPE_SYSTEM_PROMPT,
  DEFAULT_DEDUPE_USER_PROMPT_TEMPLATE,
  DEFAULT_EXTRACT_SYSTEM_PROMPT,
  DEFAULT_EXTRACT_USER_PROMPT_TEMPLATE,
  DEFAULT_TITLE_SYSTEM_PROMPT,
  DEFAULT_TITLE_USER_PROMPT_TEMPLATE,
} from './futureScanPrompts';

export const CALENDAR_FUTURE_SCAN_JOB_KEY = 'calendar.future_scan';

export type FutureScanConfig = {
  batchSize: number;
  maxEventsPerArticle: number;
  maxBodyChars: number;
  /** 写入前语义去重（标题措辞不同但同一事件） */
  dedupeEnabled: boolean;
  /** 召回日期窗：start_ts ± N 天 */
  dedupeDayWindow: number;
  /** 单次 AI 判同最多候选条数 */
  dedupeMaxCandidates: number;
  /** AI confidence 阈值 */
  dedupeMinConfidence: number;
  /** 规则相似短路阈值（0–1），达此则不调 AI */
  dedupeRuleSimilarity: number;
  titleSystemPrompt: string;
  titleUserPromptTemplate: string;
  extractSystemPrompt: string;
  extractUserPromptTemplate: string;
  dedupeSystemPrompt: string;
  dedupeUserPromptTemplate: string;
};

export const DEFAULT_FUTURE_SCAN_CONFIG: FutureScanConfig = {
  batchSize: 40,
  maxEventsPerArticle: 8,
  maxBodyChars: 12000,
  dedupeEnabled: true,
  dedupeDayWindow: 2,
  dedupeMaxCandidates: 12,
  dedupeMinConfidence: 0.8,
  dedupeRuleSimilarity: 0.72,
  titleSystemPrompt: DEFAULT_TITLE_SYSTEM_PROMPT,
  titleUserPromptTemplate: DEFAULT_TITLE_USER_PROMPT_TEMPLATE,
  extractSystemPrompt: DEFAULT_EXTRACT_SYSTEM_PROMPT,
  extractUserPromptTemplate: DEFAULT_EXTRACT_USER_PROMPT_TEMPLATE,
  dedupeSystemPrompt: DEFAULT_DEDUPE_SYSTEM_PROMPT,
  dedupeUserPromptTemplate: DEFAULT_DEDUPE_USER_PROMPT_TEMPLATE,
};

function asPositiveInt(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function asUnitFloat(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 0 || v === '0' || v === 'false' || v === 'False') return false;
  if (v === 1 || v === '1' || v === 'true' || v === 'True') return true;
  return fallback;
}

function asPrompt(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || fallback;
}

export function mergeFutureScanConfig(raw: unknown): FutureScanConfig {
  const cfg = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    batchSize: Math.min(200, asPositiveInt(cfg.batchSize, DEFAULT_FUTURE_SCAN_CONFIG.batchSize)),
    maxEventsPerArticle: Math.min(
      30,
      asPositiveInt(cfg.maxEventsPerArticle, DEFAULT_FUTURE_SCAN_CONFIG.maxEventsPerArticle),
    ),
    maxBodyChars: Math.min(
      50000,
      asPositiveInt(cfg.maxBodyChars, DEFAULT_FUTURE_SCAN_CONFIG.maxBodyChars),
    ),
    dedupeEnabled: asBool(cfg.dedupeEnabled, DEFAULT_FUTURE_SCAN_CONFIG.dedupeEnabled),
    dedupeDayWindow: Math.min(
      7,
      asPositiveInt(cfg.dedupeDayWindow, DEFAULT_FUTURE_SCAN_CONFIG.dedupeDayWindow),
    ),
    dedupeMaxCandidates: Math.min(
      30,
      asPositiveInt(cfg.dedupeMaxCandidates, DEFAULT_FUTURE_SCAN_CONFIG.dedupeMaxCandidates),
    ),
    dedupeMinConfidence: asUnitFloat(
      cfg.dedupeMinConfidence,
      DEFAULT_FUTURE_SCAN_CONFIG.dedupeMinConfidence,
    ),
    dedupeRuleSimilarity: asUnitFloat(
      cfg.dedupeRuleSimilarity,
      DEFAULT_FUTURE_SCAN_CONFIG.dedupeRuleSimilarity,
    ),
    titleSystemPrompt: asPrompt(cfg.titleSystemPrompt, DEFAULT_FUTURE_SCAN_CONFIG.titleSystemPrompt),
    titleUserPromptTemplate: asPrompt(
      cfg.titleUserPromptTemplate,
      DEFAULT_FUTURE_SCAN_CONFIG.titleUserPromptTemplate,
    ),
    extractSystemPrompt: asPrompt(
      cfg.extractSystemPrompt,
      DEFAULT_FUTURE_SCAN_CONFIG.extractSystemPrompt,
    ),
    extractUserPromptTemplate: asPrompt(
      cfg.extractUserPromptTemplate,
      DEFAULT_FUTURE_SCAN_CONFIG.extractUserPromptTemplate,
    ),
    dedupeSystemPrompt: asPrompt(
      cfg.dedupeSystemPrompt,
      DEFAULT_FUTURE_SCAN_CONFIG.dedupeSystemPrompt,
    ),
    dedupeUserPromptTemplate: asPrompt(
      cfg.dedupeUserPromptTemplate,
      DEFAULT_FUTURE_SCAN_CONFIG.dedupeUserPromptTemplate,
    ),
  };
}

export function isCalendarFutureScanEnabled(): boolean {
  return process.env.CALENDAR_FUTURE_SCAN_ENABLED !== '0';
}

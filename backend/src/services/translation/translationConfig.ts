import fs from 'fs/promises';
import path from 'path';
import { getPrisma } from '../../server';

export type TranslationProvider = 'tencent' | 'mtran' | 'gemini' | 'openai' | 'index';

export type TranslationConfig = {
  provider: TranslationProvider;
  secretId: string;
  secretKey: string;
  region: string;
  baseUrl: string;
  apiToken: string;
  enabled: boolean;
};

const LEGACY_CONFIG_PATH = path.join(__dirname, '../../../data/translation-config.json');
const DEFAULT_REGION = 'ap-guangzhou';
const DEFAULT_MTRAN_BASE_URL = 'http://127.0.0.1:8989';
const DEFAULT_OPENAI_BASE_URL = 'http://192.168.31.60:3921/v1';
const DEFAULT_OPENAI_MODEL = 'bridge__deepseek';
const DEFAULT_INDEX_BASE_URL = 'https://index-translate.bilibili.com/v1';
const DEFAULT_INDEX_MODEL = 'Index-Translate-2B';

const userConfigCache = new Map<number, TranslationConfig | null>();

export function normalizeProvider(raw: unknown): TranslationProvider {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'mtran') return 'mtran';
  if (value === 'gemini') return 'gemini';
  if (value === 'openai' || value === 'openai_compat' || value === 'meo-bridge') return 'openai';
  if (
    value === 'index' ||
    value === 'index_translate' ||
    value === 'index-translate' ||
    value === 'bilibili'
  ) {
    return 'index';
  }
  return 'tencent';
}

function normalizeMtranBaseUrl(raw: unknown): string {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  return value || DEFAULT_MTRAN_BASE_URL;
}

function normalizeOpenAiBaseUrl(raw: unknown): string {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  return value || String(process.env.OPENAI_TRANSLATE_BASE_URL || DEFAULT_OPENAI_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_OPENAI_BASE_URL;
}

function normalizeOpenAiModel(raw: unknown): string {
  const value = String(raw || '').trim();
  return value || String(process.env.OPENAI_TRANSLATE_MODEL || DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL;
}

function normalizeIndexBaseUrl(raw: unknown): string {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  return (
    value ||
    String(process.env.INDEX_TRANSLATE_BASE_URL || DEFAULT_INDEX_BASE_URL)
      .trim()
      .replace(/\/+$/, '') ||
    DEFAULT_INDEX_BASE_URL
  );
}

function normalizeIndexModel(raw: unknown): string {
  const value = String(raw || '').trim();
  return (
    value ||
    String(process.env.INDEX_TRANSLATE_MODEL || DEFAULT_INDEX_MODEL).trim() ||
    DEFAULT_INDEX_MODEL
  );
}

function normalizeConfig(raw: Partial<TranslationConfig> | null | undefined): TranslationConfig | null {
  if (!raw) return null;
  const provider = normalizeProvider(raw.provider);
  const enabled = raw.enabled !== false;

  if (provider === 'mtran') {
    return {
      provider,
      secretId: String(raw.secretId || '').trim(),
      secretKey: String(raw.secretKey || '').trim(),
      region: String(raw.region || DEFAULT_REGION).trim() || DEFAULT_REGION,
      baseUrl: normalizeMtranBaseUrl(raw.baseUrl),
      apiToken: String(raw.apiToken || '').trim(),
      enabled,
    };
  }

  if (provider === 'gemini') {
    const secretKey =
      String(raw.secretKey || '').trim() || String(process.env.GEMINI_API_KEY || '').trim();
    return {
      provider,
      secretId: '',
      secretKey,
      region: String(raw.region || DEFAULT_REGION).trim() || DEFAULT_REGION,
      baseUrl: String(raw.baseUrl || '').trim().replace(/\/+$/, ''),
      apiToken: String(raw.apiToken || '').trim(),
      enabled,
    };
  }

  if (provider === 'openai') {
    const secretKey =
      String(raw.secretKey || '').trim() || String(process.env.OPENAI_TRANSLATE_API_KEY || '').trim();
    return {
      provider,
      secretId: normalizeOpenAiModel(raw.secretId),
      secretKey,
      region: String(raw.region || DEFAULT_REGION).trim() || DEFAULT_REGION,
      baseUrl: normalizeOpenAiBaseUrl(raw.baseUrl),
      apiToken: String(raw.apiToken || '').trim(),
      enabled,
    };
  }

  if (provider === 'index') {
    return {
      provider,
      secretId: normalizeIndexModel(raw.secretId),
      secretKey: String(raw.secretKey || '').trim(),
      region: String(raw.region || DEFAULT_REGION).trim() || DEFAULT_REGION,
      baseUrl: normalizeIndexBaseUrl(raw.baseUrl),
      apiToken: String(raw.apiToken || '').trim(),
      enabled,
    };
  }

  const secretId = String(raw.secretId || '').trim();
  const secretKey = String(raw.secretKey || '').trim();
  if (!secretId || !secretKey) return null;
  return {
    provider: 'tencent',
    secretId,
    secretKey,
    region: String(raw.region || DEFAULT_REGION).trim() || DEFAULT_REGION,
    baseUrl: String(raw.baseUrl || '').trim().replace(/\/+$/, ''),
    apiToken: String(raw.apiToken || '').trim(),
    enabled,
  };
}

export function maskSecret(value: string): string {
  const v = String(value || '').trim();
  if (!v) return '';
  if (v.length <= 8) return '****';
  return `${'*'.repeat(Math.min(v.length - 4, 12))}${v.slice(-4)}`;
}

function rowToConfig(row: {
  provider?: string | null;
  secret_id: string;
  secret_key: string;
  region: string;
  base_url?: string | null;
  api_token?: string | null;
  enabled: boolean;
}): TranslationConfig {
  const provider = normalizeProvider(row.provider);
  let baseUrl = String(row.base_url || '').trim();
  if (provider === 'mtran') baseUrl = normalizeMtranBaseUrl(row.base_url);
  if (provider === 'openai') baseUrl = normalizeOpenAiBaseUrl(row.base_url);
  if (provider === 'index') baseUrl = normalizeIndexBaseUrl(row.base_url);

  let secretId = row.secret_id || '';
  if (provider === 'openai') secretId = normalizeOpenAiModel(row.secret_id);
  if (provider === 'index') secretId = normalizeIndexModel(row.secret_id);

  return {
    provider,
    secretId,
    secretKey: row.secret_key || '',
    region: row.region || DEFAULT_REGION,
    baseUrl,
    apiToken: String(row.api_token || '').trim(),
    enabled: row.enabled,
  };
}

export async function getUserTranslationConfig(userId: number): Promise<TranslationConfig | null> {
  if (userConfigCache.has(userId)) {
    return userConfigCache.get(userId) ?? null;
  }

  const prisma = await getPrisma();
  const row = await prisma.userTranslationConfig.findUnique({
    where: { user_id: userId },
  });

  const config = row ? rowToConfig(row) : null;
  userConfigCache.set(userId, config);
  return config;
}

export async function getEffectiveTranslationConfig(userId: number): Promise<TranslationConfig | null> {
  return getUserTranslationConfig(userId);
}

export async function saveUserTranslationConfig(
  userId: number,
  input: Partial<TranslationConfig>,
): Promise<TranslationConfig> {
  const current = await getUserTranslationConfig(userId);
  const provider = normalizeProvider(input.provider ?? current?.provider ?? 'tencent');
  const enabled = input.enabled !== undefined ? input.enabled !== false : current?.enabled !== false;
  const region = String(input.region ?? current?.region ?? DEFAULT_REGION).trim() || DEFAULT_REGION;
  let secretId = String(input.secretId ?? current?.secretId ?? '').trim();
  const secretKey = String(input.secretKey ?? current?.secretKey ?? '').trim();
  const apiToken =
    input.apiToken !== undefined
      ? String(input.apiToken || '').trim()
      : String(current?.apiToken || '').trim();

  let baseUrl = '';
  if (provider === 'mtran') {
    baseUrl = normalizeMtranBaseUrl(input.baseUrl ?? current?.baseUrl);
  } else if (provider === 'openai') {
    baseUrl = normalizeOpenAiBaseUrl(input.baseUrl ?? (current?.provider === 'openai' ? current.baseUrl : ''));
    secretId = normalizeOpenAiModel(
      input.secretId ?? (current?.provider === 'openai' ? current.secretId : ''),
    );
  } else if (provider === 'index') {
    baseUrl = normalizeIndexBaseUrl(input.baseUrl ?? (current?.provider === 'index' ? current.baseUrl : ''));
    secretId = normalizeIndexModel(
      input.secretId ?? (current?.provider === 'index' ? current.secretId : ''),
    );
  } else {
    baseUrl = String(input.baseUrl ?? current?.baseUrl ?? '').trim().replace(/\/+$/, '');
  }

  if (provider === 'tencent' && (!secretId || !secretKey)) {
    throw new Error('SecretId 与 SecretKey 不能为空');
  }
  if (provider === 'mtran' && !baseUrl) {
    throw new Error('本机翻译服务地址不能为空');
  }
  if (provider === 'gemini') {
    const resolvedKey = secretKey || String(process.env.GEMINI_API_KEY || '').trim();
    if (!resolvedKey) {
      throw new Error('Gemini API Key 不能为空（可在设置页填写，或配置环境变量 GEMINI_API_KEY）');
    }
  }
  if (provider === 'openai') {
    const resolvedKey = secretKey || String(process.env.OPENAI_TRANSLATE_API_KEY || '').trim();
    if (!resolvedKey) {
      throw new Error(
        'OpenAI 兼容 API Key 不能为空（可在设置页填写，或配置环境变量 OPENAI_TRANSLATE_API_KEY）',
      );
    }
    if (!baseUrl) {
      throw new Error('OpenAI 兼容接口地址不能为空');
    }
  }
  if (provider === 'index' && !baseUrl) {
    throw new Error('Index-Translate 接口地址不能为空');
  }

  const prisma = await getPrisma();
  let persistedSecretKey = secretKey;
  if (provider === 'gemini') {
    persistedSecretKey = secretKey || String(process.env.GEMINI_API_KEY || '').trim();
  } else if (provider === 'openai') {
    persistedSecretKey = secretKey || String(process.env.OPENAI_TRANSLATE_API_KEY || '').trim();
  } else if (provider === 'index') {
    // 公开 API 无需 Key；保留用户填写值（若有）
    persistedSecretKey = secretKey;
  }

  const persistedSecretId =
    provider === 'gemini' ? '' : secretId;

  const row = await prisma.userTranslationConfig.upsert({
    where: { user_id: userId },
    create: {
      user_id: userId,
      provider,
      secret_id: persistedSecretId,
      secret_key: persistedSecretKey,
      region,
      base_url: baseUrl || null,
      api_token: apiToken || null,
      enabled,
    },
    update: {
      provider,
      secret_id: persistedSecretId,
      secret_key: persistedSecretKey,
      region,
      base_url: baseUrl || null,
      api_token: apiToken || null,
      enabled,
      updated_at: new Date(),
    },
  });

  const saved = rowToConfig(row);
  userConfigCache.set(userId, saved);
  return saved;
}

export function invalidateUserTranslationConfigCache(userId?: number): void {
  if (userId == null) {
    userConfigCache.clear();
    return;
  }
  userConfigCache.delete(userId);
}

async function loadLegacyFileConfig(): Promise<TranslationConfig | null> {
  try {
    const raw = await fs.readFile(LEGACY_CONFIG_PATH, 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      console.warn('[TranslationConfig] 读取旧版全局配置失败:', err?.message || err);
    }
    return null;
  }
}

/** 将旧版全局配置文件迁移到指定用户（仅在该用户尚无配置时执行一次） */
export async function migrateLegacyGlobalConfigToUser(userId: number): Promise<boolean> {
  const existing = await getUserTranslationConfig(userId);
  if (existing) return false;

  const legacy = await loadLegacyFileConfig();
  if (!legacy) return false;

  await saveUserTranslationConfig(userId, legacy);
  console.log(`[TranslationConfig] 已将旧版全局翻译配置迁移到用户 ${userId}`);
  return true;
}

/** 启动时将旧版全局配置迁移给所有尚无配置的管理员 */
export async function migrateLegacyGlobalConfigToAdmins(): Promise<void> {
  const legacy = await loadLegacyFileConfig();
  if (!legacy) return;

  const prisma = await getPrisma();
  const admins = await prisma.user.findMany({
    where: { is_admin: true },
    select: { id: true },
  });

  for (const admin of admins) {
    await migrateLegacyGlobalConfigToUser(admin.id);
  }
}

export {
  DEFAULT_MTRAN_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_INDEX_BASE_URL,
  DEFAULT_INDEX_MODEL,
};

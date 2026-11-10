import fs from 'fs/promises';
import path from 'path';
import { getPrisma } from '../../server';

export type TranslationProvider = 'tencent' | 'mtran';

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

const userConfigCache = new Map<number, TranslationConfig | null>();

function normalizeProvider(raw: unknown): TranslationProvider {
  return String(raw || '').trim().toLowerCase() === 'mtran' ? 'mtran' : 'tencent';
}

function normalizeBaseUrl(raw: unknown): string {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  return value || DEFAULT_MTRAN_BASE_URL;
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
      baseUrl: normalizeBaseUrl(raw.baseUrl),
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
  return {
    provider,
    secretId: row.secret_id || '',
    secretKey: row.secret_key || '',
    region: row.region || DEFAULT_REGION,
    baseUrl: provider === 'mtran' ? normalizeBaseUrl(row.base_url) : String(row.base_url || '').trim(),
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
  const secretId = String(input.secretId ?? current?.secretId ?? '').trim();
  const secretKey = String(input.secretKey ?? current?.secretKey ?? '').trim();
  const apiToken =
    input.apiToken !== undefined
      ? String(input.apiToken || '').trim()
      : String(current?.apiToken || '').trim();
  const baseUrl =
    provider === 'mtran'
      ? normalizeBaseUrl(input.baseUrl ?? current?.baseUrl)
      : String(input.baseUrl ?? current?.baseUrl ?? '').trim().replace(/\/+$/, '');

  if (provider === 'tencent' && (!secretId || !secretKey)) {
    throw new Error('SecretId 与 SecretKey 不能为空');
  }
  if (provider === 'mtran' && !baseUrl) {
    throw new Error('本机翻译服务地址不能为空');
  }

  const prisma = await getPrisma();
  const row = await prisma.userTranslationConfig.upsert({
    where: { user_id: userId },
    create: {
      user_id: userId,
      provider,
      secret_id: secretId,
      secret_key: secretKey,
      region,
      base_url: baseUrl || null,
      api_token: apiToken || null,
      enabled,
    },
    update: {
      provider,
      secret_id: secretId,
      secret_key: secretKey,
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

export { DEFAULT_MTRAN_BASE_URL };

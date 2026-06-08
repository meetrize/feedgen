import fs from 'fs/promises';
import path from 'path';
import { getPrisma } from '../../server';

export type TranslationConfig = {
  secretId: string;
  secretKey: string;
  region: string;
  enabled: boolean;
};

const LEGACY_CONFIG_PATH = path.join(__dirname, '../../../data/translation-config.json');
const DEFAULT_REGION = 'ap-guangzhou';

const userConfigCache = new Map<number, TranslationConfig | null>();

function normalizeConfig(raw: Partial<TranslationConfig> | null | undefined): TranslationConfig | null {
  if (!raw) return null;
  const secretId = String(raw.secretId || '').trim();
  const secretKey = String(raw.secretKey || '').trim();
  if (!secretId || !secretKey) return null;
  return {
    secretId,
    secretKey,
    region: String(raw.region || DEFAULT_REGION).trim() || DEFAULT_REGION,
    enabled: raw.enabled !== false,
  };
}

export function maskSecret(value: string): string {
  const v = String(value || '').trim();
  if (!v) return '';
  if (v.length <= 8) return '****';
  return `${'*'.repeat(Math.min(v.length - 4, 12))}${v.slice(-4)}`;
}

function rowToConfig(row: {
  secret_id: string;
  secret_key: string;
  region: string;
  enabled: boolean;
}): TranslationConfig {
  return {
    secretId: row.secret_id,
    secretKey: row.secret_key,
    region: row.region || DEFAULT_REGION,
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

  const secretId = String(input.secretId ?? current?.secretId ?? '').trim();
  const secretKey = String(input.secretKey ?? current?.secretKey ?? '').trim();
  const region = String(input.region ?? current?.region ?? DEFAULT_REGION).trim() || DEFAULT_REGION;
  const enabled = input.enabled !== undefined ? input.enabled !== false : current?.enabled !== false;

  if (!secretId || !secretKey) {
    throw new Error('SecretId 与 SecretKey 不能为空');
  }

  const prisma = await getPrisma();
  const row = await prisma.userTranslationConfig.upsert({
    where: { user_id: userId },
    create: {
      user_id: userId,
      secret_id: secretId,
      secret_key: secretKey,
      region,
      enabled,
    },
    update: {
      secret_id: secretId,
      secret_key: secretKey,
      region,
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

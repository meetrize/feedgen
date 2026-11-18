import { geminiTranslateEnToZh, resolveGeminiApiKey } from './geminiClient';
import { indexTranslateEnToZh, resolveIndexTranslateBaseUrl } from './indexTranslateClient';
import { mtranTranslateEnToZh } from './mtranClient';
import {
  openaiTranslateEnToZh,
  resolveOpenAiApiKey,
  resolveOpenAiBaseUrl,
} from './openaiClient';
import { invalidateTencentClient, tencentTranslateEnToZh } from './tencentClient';
import { getEffectiveTranslationConfig } from './translationConfig';

export function invalidateTranslationClient(userId?: number): void {
  invalidateTencentClient(userId);
}

export async function isTranslationEnabled(userId: number): Promise<boolean> {
  const config = await getEffectiveTranslationConfig(userId);
  if (!config || !config.enabled) return false;
  if (config.provider === 'mtran') return !!config.baseUrl;
  if (config.provider === 'gemini') return !!resolveGeminiApiKey(config);
  if (config.provider === 'openai') {
    return !!(resolveOpenAiApiKey(config) && resolveOpenAiBaseUrl(config));
  }
  if (config.provider === 'index') return !!resolveIndexTranslateBaseUrl(config);
  return !!(config.secretId && config.secretKey);
}

export async function textTranslateEnToZh(userId: number, text: string): Promise<string> {
  const config = await getEffectiveTranslationConfig(userId);
  if (!config) {
    throw new Error('请先在设置页配置翻译服务');
  }
  if (!config.enabled) {
    throw new Error('翻译功能已关闭');
  }

  if (config.provider === 'mtran') {
    return mtranTranslateEnToZh(config, text);
  }

  if (config.provider === 'gemini') {
    return geminiTranslateEnToZh(config, text);
  }

  if (config.provider === 'openai') {
    return openaiTranslateEnToZh(config, text);
  }

  if (config.provider === 'index') {
    return indexTranslateEnToZh(config, text);
  }

  if (!config.secretId || !config.secretKey) {
    throw new Error('请先在设置页配置腾讯翻译 SecretId / SecretKey');
  }
  return tencentTranslateEnToZh(userId, config, text);
}

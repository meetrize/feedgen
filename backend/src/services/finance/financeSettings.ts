import { prisma } from '../../server';

export const DEFAULT_KLINE_URL_TEMPLATE =
  process.env.FINANCE_KLINE_URL_TEMPLATE ||
  'http://127.0.0.1:8765/?symbol={symbol}&period={period}';

export const DEFAULT_KLINE_PERIOD = process.env.FINANCE_KLINE_DEFAULT_PERIOD || '1d';

export const DEFAULT_MAX_CHIPS = 5;
export const DEFAULT_LIST_MAX_CHIPS = 3;

export type FinanceSettings = {
  kline_url_template: string;
  kline_default_period: string;
  max_chips: number;
  list_max_chips: number;
};

const KEYS = {
  kline_url_template: 'kline_url_template',
  kline_default_period: 'kline_default_period',
  max_chips: 'max_chips',
  list_max_chips: 'list_max_chips',
} as const;

export async function getFinanceSettings(): Promise<FinanceSettings> {
  const rows = await prisma.financeAppSetting.findMany({
    where: { key: { in: Object.values(KEYS) } },
  });
  const map = new Map(rows.map((r: { key: string; value: string }) => [r.key, r.value]));

  const maxChips = Number(map.get(KEYS.max_chips));
  const listMax = Number(map.get(KEYS.list_max_chips));

  const template = map.get(KEYS.kline_url_template);
  const period = map.get(KEYS.kline_default_period);
  return {
    kline_url_template:
      typeof template === 'string' && template ? template : DEFAULT_KLINE_URL_TEMPLATE,
    kline_default_period:
      typeof period === 'string' && period ? period : DEFAULT_KLINE_PERIOD,
    max_chips: Number.isFinite(maxChips) && maxChips > 0 ? maxChips : DEFAULT_MAX_CHIPS,
    list_max_chips: Number.isFinite(listMax) && listMax > 0 ? listMax : DEFAULT_LIST_MAX_CHIPS,
  };
}

export async function updateFinanceSettings(
  patch: Partial<FinanceSettings>,
): Promise<FinanceSettings> {
  const entries: Array<[string, string]> = [];
  if (patch.kline_url_template != null) {
    entries.push([KEYS.kline_url_template, String(patch.kline_url_template).trim()]);
  }
  if (patch.kline_default_period != null) {
    entries.push([KEYS.kline_default_period, String(patch.kline_default_period).trim()]);
  }
  if (patch.max_chips != null) {
    entries.push([KEYS.max_chips, String(Math.max(1, Math.min(20, Number(patch.max_chips) || 5)))]);
  }
  if (patch.list_max_chips != null) {
    entries.push([
      KEYS.list_max_chips,
      String(Math.max(1, Math.min(10, Number(patch.list_max_chips) || 3))),
    ]);
  }

  for (const [key, value] of entries) {
    await prisma.financeAppSetting.upsert({
      where: { key },
      create: { key, value, updated_at: new Date() },
      update: { value, updated_at: new Date() },
    });
  }

  return getFinanceSettings();
}

export function buildKlineUrl(
  chartSymbol: string,
  settings?: Pick<FinanceSettings, 'kline_url_template' | 'kline_default_period'>,
): string {
  const template = settings?.kline_url_template || DEFAULT_KLINE_URL_TEMPLATE;
  const period = settings?.kline_default_period || DEFAULT_KLINE_PERIOD;
  return template
    .replace(/\{symbol\}/g, encodeURIComponent(chartSymbol))
    .replace(/\{period\}/g, encodeURIComponent(period));
}

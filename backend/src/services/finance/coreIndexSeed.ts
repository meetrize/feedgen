/** 核心指数 / 常见别称种子（一期） */

export type SeedInstrument = {
  market: string;
  symbol: string;
  chart_symbol: string;
  name: string;
  name_en?: string;
  asset_type: string;
  exchange?: string;
  aliases: Array<{ keyword: string; kind: string }>;
  priority?: number;
};

export const CORE_INDEX_SEEDS: SeedInstrument[] = [
  {
    market: 'index',
    symbol: '000001',
    chart_symbol: 'sh000001',
    name: '上证指数',
    name_en: 'SSE Composite',
    asset_type: 'index',
    exchange: 'SH',
    aliases: [
      { keyword: '上证指数', kind: 'name' },
      { keyword: '上证综指', kind: 'abbr' },
      { keyword: '沪指', kind: 'abbr' },
    ],
    priority: 200,
  },
  {
    market: 'index',
    symbol: '399001',
    chart_symbol: 'sz399001',
    name: '深证成指',
    name_en: 'SZSE Component',
    asset_type: 'index',
    exchange: 'SZ',
    aliases: [
      { keyword: '深证成指', kind: 'name' },
      { keyword: '深成指', kind: 'abbr' },
      { keyword: '深指', kind: 'abbr' },
    ],
    priority: 200,
  },
  {
    market: 'index',
    symbol: '399006',
    chart_symbol: 'sz399006',
    name: '创业板指',
    name_en: 'ChiNext',
    asset_type: 'index',
    exchange: 'SZ',
    aliases: [
      { keyword: '创业板指', kind: 'name' },
      { keyword: '创指', kind: 'abbr' },
    ],
    priority: 200,
  },
  {
    market: 'index',
    symbol: '000300',
    chart_symbol: 'sh000300',
    name: '沪深300',
    name_en: 'CSI 300',
    asset_type: 'index',
    exchange: 'SH',
    aliases: [
      { keyword: '沪深300', kind: 'name' },
      { keyword: '沪深三百', kind: 'alias' },
    ],
    priority: 200,
  },
  {
    market: 'index',
    symbol: 'HSI',
    chart_symbol: 'hkHSI',
    name: '恒生指数',
    name_en: 'Hang Seng Index',
    asset_type: 'index',
    exchange: 'HK',
    aliases: [
      { keyword: '恒生指数', kind: 'name' },
      { keyword: '恒指', kind: 'abbr' },
      { keyword: 'HSI', kind: 'code' },
    ],
    priority: 200,
  },
  {
    market: 'index',
    symbol: '^DJI',
    chart_symbol: 'DJI',
    name: '道琼斯',
    name_en: 'Dow Jones',
    asset_type: 'index',
    exchange: 'US',
    aliases: [
      { keyword: '道琼斯', kind: 'name' },
      { keyword: '道指', kind: 'abbr' },
      { keyword: 'Dow', kind: 'abbr' },
      { keyword: '^DJI', kind: 'code' },
    ],
    priority: 200,
  },
  {
    market: 'index',
    symbol: '^IXIC',
    chart_symbol: 'IXIC',
    name: '纳斯达克',
    name_en: 'NASDAQ Composite',
    asset_type: 'index',
    exchange: 'US',
    aliases: [
      { keyword: '纳斯达克', kind: 'name' },
      { keyword: '纳指', kind: 'abbr' },
      { keyword: 'Nasdaq', kind: 'abbr' },
      { keyword: '^IXIC', kind: 'code' },
    ],
    priority: 200,
  },
  {
    market: 'index',
    symbol: '^GSPC',
    chart_symbol: 'SPX',
    name: '标普500',
    name_en: 'S&P 500',
    asset_type: 'index',
    exchange: 'US',
    aliases: [
      { keyword: '标普500', kind: 'name' },
      { keyword: '标普', kind: 'abbr' },
      { keyword: 'S&P500', kind: 'alias' },
      { keyword: '^GSPC', kind: 'code' },
    ],
    priority: 200,
  },
];

/** 常见个股别称（按 chart_symbol / market+symbol 绑定） */
export const COMMON_STOCK_ABBRS: Array<{
  market: string;
  symbol: string;
  aliases: Array<{ keyword: string; kind: string }>;
}> = [
  { market: 'cn', symbol: '600519', aliases: [{ keyword: '茅台', kind: 'abbr' }, { keyword: '贵州茅台', kind: 'name' }] },
  { market: 'cn', symbol: '000858', aliases: [{ keyword: '五粮液', kind: 'name' }] },
  { market: 'cn', symbol: '601318', aliases: [{ keyword: '中国平安', kind: 'name' }] },
  { market: 'hk', symbol: '00700', aliases: [{ keyword: '腾讯', kind: 'abbr' }, { keyword: '腾讯控股', kind: 'name' }] },
  { market: 'hk', symbol: '09988', aliases: [{ keyword: '阿里巴巴', kind: 'name' }, { keyword: '阿里', kind: 'abbr' }] },
  { market: 'us', symbol: 'AAPL', aliases: [{ keyword: '苹果', kind: 'abbr' }, { keyword: 'Apple', kind: 'name' }] },
  { market: 'us', symbol: 'TSLA', aliases: [{ keyword: '特斯拉', kind: 'name' }] },
  { market: 'us', symbol: 'NVDA', aliases: [{ keyword: '英伟达', kind: 'name' }, { keyword: 'NVIDIA', kind: 'name' }] },
];

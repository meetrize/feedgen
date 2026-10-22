/** 将市场/交易所/代码映射为 K 线用 chart_symbol（东财风格前缀） */

export type ChartSymbolInput = {
  market: string;
  symbol: string;
  exchange?: string | null;
  /** 已带前缀的代码，如 sh600519 / bj920578 */
  prefixedCode?: string | null;
};

const CN_PREFIX_RE = /^(sh|sz|bj)(\d{4,6})$/i;

export function buildChartSymbol(input: ChartSymbolInput): string {
  const prefixed = String(input.prefixedCode || '').trim();
  if (prefixed) {
    const m = prefixed.match(CN_PREFIX_RE);
    if (m && m[1] && m[2]) return `${m[1].toLowerCase()}${m[2]}`;
    if (/^hk\d+/i.test(prefixed)) return prefixed.toLowerCase();
  }

  const market = String(input.market || '').toLowerCase();
  let symbol = String(input.symbol || '').trim();
  const exchange = String(input.exchange || '').toUpperCase();

  // 去掉已有前缀再规范化
  const cn = symbol.match(CN_PREFIX_RE);
  if (cn && cn[1] && cn[2]) return `${cn[1].toLowerCase()}${cn[2]}`;

  if (market === 'cn' || market === 'a' || market === 'ashare') {
    const digits = symbol.replace(/\D/g, '');
    if (exchange === 'SH' || exchange === 'SSE' || digits.startsWith('6') || digits.startsWith('5')) {
      return `sh${digits}`;
    }
    if (exchange === 'BJ' || exchange === 'BSE' || digits.startsWith('8') || digits.startsWith('4') || digits.startsWith('92')) {
      return `bj${digits}`;
    }
    return `sz${digits}`;
  }

  if (market === 'hk') {
    const digits = symbol.replace(/\D/g, '').padStart(5, '0');
    return `hk${digits}`;
  }

  if (market === 'us') {
    // 105.AAPL / AAPL.OQ → AAPL
    let t = symbol.toUpperCase();
    if (/^\d+\./.test(t)) t = t.replace(/^\d+\./, '');
    t = t.replace(/\.(O|N|A|OQ|NQ|PK|OB)$/i, '');
    return t;
  }

  if (market === 'fund' || market === 'index') {
    return symbol.replace(/\D/g, '') || symbol.toLowerCase();
  }

  return symbol.toLowerCase();
}

export function inferCnExchange(chartOrCode: string): string {
  const s = chartOrCode.toLowerCase();
  if (s.startsWith('sh')) return 'SH';
  if (s.startsWith('sz')) return 'SZ';
  if (s.startsWith('bj')) return 'BJ';
  const digits = s.replace(/\D/g, '');
  if (digits.startsWith('6') || digits.startsWith('5')) return 'SH';
  if (digits.startsWith('92') || digits.startsWith('8') || digits.startsWith('4')) return 'BJ';
  return 'SZ';
}

export function stripCnPrefix(code: string): string {
  const m = String(code).match(CN_PREFIX_RE);
  if (m && m[2]) return m[2];
  return String(code).replace(/^(sh|sz|bj)/i, '');
}

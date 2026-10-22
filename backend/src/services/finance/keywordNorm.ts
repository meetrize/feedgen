/** 关键词规范化：全角→半角、去空白、小写 */

export function normalizeKeyword(raw: string): string {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  // 全角 ASCII → 半角
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/\u3000/g, ' ');
  s = s.replace(/\s+/g, '');
  return s.toLowerCase();
}

/** 纯数字代码（用于边界匹配） */
export function isPureNumericCode(norm: string): boolean {
  return /^\d{1,8}$/.test(norm);
}

/** 过短关键词默认不启用 */
export function shouldEnableAliasByDefault(norm: string, kind: string): boolean {
  if (!norm) return false;
  // 纯字母 ticker：至少 3 位才自动启用，避免 F/AI/TO 等误伤（可在 Admin 手工启用）
  if (kind === 'code' && /^[a-z.^=]+$/i.test(norm) && norm.length < 3) return false;
  // 纯数字代码：至少 4 位才自动启用（短码靠边界匹配仍风险高）
  if (kind === 'code' && /^\d+$/.test(norm) && norm.length < 4) return false;
  if (norm.length < 2) return false;
  return true;
}

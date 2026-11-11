/**
 * 64-bit SimHash over character bigrams（适合短中文标题）。
 * 存库用有符号 BIGINT（PostgreSQL / Prisma），位型按 two's complement 解释。
 */

const U64_MASK = 0xffffffffffffffffn;
const I64_MAX = 0x7fffffffffffffffn;
const U64_RANGE = 0x10000000000000000n;

/** 无符号 64 位 → 有符号 int64（可写入 PG BIGINT） */
export function toSignedInt64(bits: bigint): bigint {
  const v = bits & U64_MASK;
  return v > I64_MAX ? v - U64_RANGE : v;
}

/** 有符号 int64 → 无符号 64 位（汉明距离用） */
export function toUnsignedU64(signed: bigint): bigint {
  return signed < 0n ? signed + U64_RANGE : signed & U64_MASK;
}

function fnv1a64(str: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * prime) & U64_MASK;
  }
  return hash;
}

function bigrams(s: string): string[] {
  if (!s) return [];
  if (s.length === 1) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) {
    out.push(s.slice(i, i + 2));
  }
  return out;
}

export function computeSimhash(normalizedTitle: string): bigint | null {
  const grams = bigrams(normalizedTitle);
  if (!grams.length) return null;

  const weights = new Array<number>(64).fill(0);
  for (const g of grams) {
    const h = fnv1a64(g);
    for (let bit = 0; bit < 64; bit++) {
      const mask = 1n << BigInt(bit);
      const w = weights[bit] ?? 0;
      weights[bit] = (h & mask) !== 0n ? w + 1 : w - 1;
    }
  }

  let fingerprint = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if ((weights[bit] ?? 0) >= 0) fingerprint |= 1n << BigInt(bit);
  }
  return toSignedInt64(fingerprint);
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = toUnsignedU64(a) ^ toUnsignedU64(b);
  let count = 0;
  while (x !== 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** 字符 bigram Jaccard */
export function bigramJaccard(a: string, b: string): number {
  const sa = new Set(bigrams(a));
  const sb = new Set(bigrams(b));
  if (!sa.size && !sb.size) return 1;
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const x of sa) {
    if (sb.has(x)) inter += 1;
  }
  return inter / (sa.size + sb.size - inter);
}

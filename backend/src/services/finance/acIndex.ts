/**
 * 简易 Aho-Corasick 多模式匹配（字符级，适配中文）
 */

export type AcPattern = {
  keywordNorm: string;
  instrumentId: number;
  keyword: string;
  kind: string;
  priority: number;
};

export type AcHit = {
  end: number;
  start: number;
  pattern: AcPattern;
};

type AcNode = {
  next: Map<string, AcNode>;
  fail: AcNode | null;
  out: AcPattern[];
};

function createNode(): AcNode {
  return { next: new Map(), fail: null, out: [] };
}

export class AhoCorasickIndex {
  private root: AcNode = createNode();
  private built = false;
  private patternCount = 0;

  clear(): void {
    this.root = createNode();
    this.built = false;
    this.patternCount = 0;
  }

  add(pattern: AcPattern): void {
    if (!pattern.keywordNorm) return;
    let node = this.root;
    for (const ch of pattern.keywordNorm) {
      let child = node.next.get(ch);
      if (!child) {
        child = createNode();
        node.next.set(ch, child);
      }
      node = child;
    }
    node.out.push(pattern);
    this.patternCount += 1;
    this.built = false;
  }

  build(): void {
    const queue: AcNode[] = [];
    for (const child of this.root.next.values()) {
      child.fail = this.root;
      queue.push(child);
    }
    while (queue.length) {
      const node = queue.shift();
      if (!node) break;
      for (const [ch, child] of node.next) {
        queue.push(child);
        let f: AcNode | null = node.fail;
        while (f && !f.next.has(ch)) f = f.fail;
        const failTarget = f ? f.next.get(ch) : undefined;
        child.fail = failTarget ?? this.root;
        if (child.fail.out.length) {
          child.out = child.out.concat(child.fail.out);
        }
      }
    }
    this.built = true;
  }

  get size(): number {
    return this.patternCount;
  }

  search(textNorm: string): AcHit[] {
    if (!this.built) this.build();
    const hits: AcHit[] = [];
    let node: AcNode = this.root;
    const chars = Array.from(textNorm);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch == null) continue;
      while (node !== this.root && !node.next.has(ch)) {
        node = node.fail ?? this.root;
      }
      const nextNode = node.next.get(ch);
      node = nextNode ?? this.root;
      for (const pattern of node.out) {
        const start = i - pattern.keywordNorm.length + 1;
        hits.push({ end: i, start, pattern });
      }
    }
    return hits;
  }
}

/** 纯数字短码：要求左右非字母数字 */
export function hasCodeBoundary(textNorm: string, start: number, end: number): boolean {
  const chars = Array.from(textNorm);
  const left = start > 0 ? chars[start - 1] ?? '' : '';
  const right = end + 1 < chars.length ? chars[end + 1] ?? '' : '';
  const isAlnum = (c: string) => /[0-9a-z]/i.test(c);
  if (left && isAlnum(left)) return false;
  if (right && isAlnum(right)) return false;
  return true;
}

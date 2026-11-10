/** 重要度打分配置（一期：ENV + 代码常量，管理端可视化二期） */

export const IMPORTANCE_MODEL_VERSION = 'v1-heuristic';

export type ImportanceWeights = {
  source: number;
  editorial: number;
  finance: number;
  cluster: number;
  freshness: number;
};

/** 权重之和应为 1 */
export const DEFAULT_WEIGHTS: ImportanceWeights = {
  source: 0.15,
  editorial: 0.3,
  finance: 0.35,
  cluster: 0.15,
  freshness: 0.05,
};

/** 星级阈值：score 落入区间映射 1–5 */
export const DEFAULT_STAR_THRESHOLDS = [20, 40, 60, 80] as const;

export const CLUSTER_SIMILARITY_THRESHOLD = Number(
  process.env.IMPORTANCE_CLUSTER_THRESHOLD || 0.82,
);
export const CLUSTER_WINDOW_HOURS = Number(process.env.IMPORTANCE_CLUSTER_WINDOW_HOURS || 24);
export const CLUSTER_MAX_CANDIDATES = Number(process.env.IMPORTANCE_CLUSTER_MAX_CANDIDATES || 80);

/** 编辑向突发/重磅信号词 */
export const EDITORIAL_SIGNAL_KEYWORDS = [
  '突发',
  '重磅',
  '紧急',
  '快讯',
  '刚刚',
  '独家',
  '重大',
  '震惊',
  '制裁',
  '开战',
  '停火',
  '政变',
  '辞职',
  '弹劾',
  '遇袭',
  '爆炸',
  '地震',
  '台风',
  '破防',
  'breaking',
  'urgent',
  'exclusive',
] as const;

/** 金融强信号词 */
export const FINANCE_SIGNAL_KEYWORDS = [
  '加息',
  '降息',
  '降准',
  '加准',
  '央行',
  '美联储',
  'fed',
  '利率决议',
  '财报',
  '暴雷',
  '违约',
  '破产',
  '退市',
  'ipo',
  '上市',
  '并购',
  '收购',
  '回购',
  '分红',
  '熔断',
  '暴涨',
  '暴跌',
  '原油',
  '黄金',
  '比特币',
  '监管处罚',
  '罚款',
  '立案调查',
] as const;

/** 主题类别 code → 先验分 0–100（未匹配默认 40） */
export const CATEGORY_PRIOR_SCORES: Record<string, number> = {
  politics: 75,
  political: 75,
  macro: 80,
  economy: 70,
  finance: 72,
  business: 65,
  tech: 55,
  technology: 55,
  world: 68,
  international: 68,
  society: 50,
  sports: 25,
  entertainment: 20,
  lifestyle: 22,
  culture: 30,
  education: 35,
  health: 45,
  science: 50,
  时政: 78,
  宏观: 80,
  财经: 72,
  金融: 74,
  科技: 55,
  国际: 68,
  社会: 50,
  体育: 25,
  娱乐: 20,
};

/** 默认域名权威分 0–100（未命中默认 45） */
export const DEFAULT_HOST_AUTHORITY: Record<string, number> = {
  'reuters.com': 92,
  'bloomberg.com': 92,
  'wsj.com': 90,
  'ft.com': 90,
  'nytimes.com': 88,
  'apnews.com': 88,
  'bbc.com': 86,
  'bbc.co.uk': 86,
  'cnn.com': 78,
  'theguardian.com': 80,
  'caixin.com': 88,
  'yicai.com': 82,
  'cls.cn': 80,
  'stcn.com': 78,
  'eastmoney.com': 72,
  'wallstreetcn.com': 78,
  '36kr.com': 60,
  'jiemian.com': 70,
  'thepaper.cn': 72,
  'xinhuanet.com': 85,
  'people.com.cn': 82,
  'cctv.com': 80,
  'chinadaily.com.cn': 75,
  'scmp.com': 82,
  'nikkei.com': 85,
  'economist.com': 90,
};

export function isImportanceEnabled(): boolean {
  return process.env.IMPORTANCE_ENABLED !== '0';
}

export function scoreToStars(
  score: number,
  thresholds: readonly number[] = DEFAULT_STAR_THRESHOLDS,
): number {
  const s = Math.max(0, Math.min(100, score));
  if (s >= (thresholds[3] ?? 80)) return 5;
  if (s >= (thresholds[2] ?? 60)) return 4;
  if (s >= (thresholds[1] ?? 40)) return 3;
  if (s >= (thresholds[0] ?? 20)) return 2;
  return 1;
}

/**
 * 标题星级保底规则引擎（政策 / 央行 / 宏观数据 / 地缘 / 灾害等）
 * 规则可来自代码默认值或 DB 配置。
 */

import {
  NATIONAL_AGENCY_KEYWORDS,
  POLICY_MEETING_KEYWORDS,
  POLICY_PUBLISH_STRONG_KEYWORDS,
  POLICY_PUBLISH_WEAK_KEYWORDS,
} from './importanceConfig';

export type StarFloorRuleInput = {
  rule_key: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  floor_stars: number;
  subject_keywords: string[];
  signal_keywords: string[];
  exclude_keywords: string[];
  skip_local_agency: boolean;
  sort_order?: number;
};

export type StarFloorMatch = {
  rule_key: string;
  name: string;
  floor_stars: number;
  matched_subjects: string[];
  matched_signals: string[];
};

export type StarFloorEvaluation = {
  floor_stars: number | null;
  matched_rules: StarFloorMatch[];
  skipped_local_keys: string[];
};

const AMBIGUOUS_AGENCY_SHORT_NAMES = new Set([
  '发改委',
  '能源局',
  '统计局',
  '医保局',
  '国资委',
  '证监会',
]);

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => String(v || '').trim())
    .filter(Boolean);
}

export function normalizeRuleKeywords(rule: {
  subject_keywords?: unknown;
  signal_keywords?: unknown;
  exclude_keywords?: unknown;
}): Pick<StarFloorRuleInput, 'subject_keywords' | 'signal_keywords' | 'exclude_keywords'> {
  return {
    subject_keywords: asStringList(rule.subject_keywords),
    signal_keywords: asStringList(rule.signal_keywords),
    exclude_keywords: asStringList(rule.exclude_keywords),
  };
}

function matchKeywords(text: string, keywords: readonly string[]): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const kw of keywords) {
    if (!kw) continue;
    if (lower.includes(kw.toLowerCase())) hits.push(kw);
  }
  return hits;
}

function isLikelyLocalAgencyTitle(title: string, matchedSubjects: string[]): boolean {
  if (/国家|国务院|中央|中共中央/.test(title)) return false;
  if (!matchedSubjects.length) return false;
  const onlyAmbiguous = matchedSubjects.every((kw) => AMBIGUOUS_AGENCY_SHORT_NAMES.has(kw));
  if (!onlyAmbiguous) return false;
  return /(省|市|区|县|自治州|盟|地区).{0,8}(发改委|能源局|工信|财政|住建|统计|医保|国资|证监)/.test(
    title,
  );
}

/** 内置默认规则（首次 seeding / 重置默认时使用） */
export function getDefaultStarFloorRules(): StarFloorRuleInput[] {
  const agencies = [...NATIONAL_AGENCY_KEYWORDS];
  const meeting = [...POLICY_MEETING_KEYWORDS];

  return [
    {
      rule_key: 'policy_publish_strong',
      name: '国家级机构·强政策发布',
      description: '发改委/能源局等 + 规划/方案/印发/出台等 → 5 星',
      enabled: true,
      floor_stars: 5,
      subject_keywords: agencies,
      signal_keywords: [...POLICY_PUBLISH_STRONG_KEYWORDS],
      exclude_keywords: [],
      skip_local_agency: true,
      sort_order: 10,
    },
    {
      rule_key: 'agency_meeting',
      name: '国家级机构·会议活动',
      description: '机构 + 主持召开/座谈会/调研等（非强政策）→ 4 星',
      enabled: true,
      floor_stars: 4,
      subject_keywords: agencies,
      signal_keywords: meeting,
      exclude_keywords: [],
      skip_local_agency: true,
      sort_order: 20,
    },
    {
      rule_key: 'policy_publish_weak',
      name: '国家级机构·弱政策信号',
      description: '机构 + 通知/发布/政策等；排除会议类与发布会 → 5 星',
      enabled: true,
      floor_stars: 5,
      subject_keywords: agencies,
      signal_keywords: [...POLICY_PUBLISH_WEAK_KEYWORDS],
      exclude_keywords: [...meeting, '发布会'],
      skip_local_agency: true,
      sort_order: 30,
    },
    {
      rule_key: 'cb_decision',
      name: '央行货币政策决议',
      description: '美联储/央行等 + 加息/降息/利率决议等 → 5 星',
      enabled: true,
      floor_stars: 5,
      subject_keywords: [
        '美联储',
        'fed',
        'fomc',
        '欧洲央行',
        'ecb',
        '英央行',
        '日本央行',
        '日央行',
        'boj',
        '央行',
        '人民银行',
        '中国人民银行',
        '瑞士央行',
        '澳洲联储',
        '加拿大央行',
      ],
      signal_keywords: [
        '加息',
        '降息',
        '维持利率',
        '利率决议',
        '点阵图',
        '量化宽松',
        '量化紧缩',
        '缩表',
        '扩表',
        'qe',
        'qt',
        'rate hike',
        'rate cut',
        'holds rates',
      ],
      exclude_keywords: [],
      skip_local_agency: false,
      sort_order: 40,
    },
    {
      rule_key: 'macro_print',
      name: '重磅宏观数据公布',
      description: '非农/CPI/PCE/GDP 等 + 公布/超预期等 → 5 星',
      enabled: true,
      floor_stars: 5,
      subject_keywords: [
        '非农',
        '非农就业',
        '失业率',
        'cpi',
        'pce',
        'gdp',
        'pmi',
        '社融',
        '社会融资',
        '进出口',
        '贸易数据',
        '零售销售',
        '初请失业金',
      ],
      signal_keywords: [
        '公布',
        '出炉',
        '发布',
        '超预期',
        '不及预期',
        '逊于预期',
        '好于预期',
        '低于预期',
        '高于预期',
        '大幅',
        '意外',
      ],
      exclude_keywords: ['发布会', '预测', '前瞻', '展望', '预览'],
      skip_local_agency: false,
      sort_order: 50,
    },
    {
      rule_key: 'macro_preview',
      name: '宏观数据预测/前瞻',
      description: '非农/CPI 等 + 预测/预期/前瞻 → 4 星',
      enabled: true,
      floor_stars: 4,
      subject_keywords: [
        '非农',
        '非农就业',
        '失业率',
        'cpi',
        'pce',
        'gdp',
        'pmi',
        '社融',
        '初请失业金',
      ],
      signal_keywords: ['预测', '预期', '前瞻', '展望', '预览', 'survey', 'consensus'],
      exclude_keywords: [],
      skip_local_agency: false,
      sort_order: 60,
    },
    {
      rule_key: 'geo_conflict',
      name: '地缘冲突突发',
      description: '开战/空袭/宣战/全面入侵等 → 5 星',
      enabled: true,
      floor_stars: 5,
      subject_keywords: [],
      signal_keywords: [
        '开战',
        '宣战',
        '空袭',
        '全面入侵',
        '军事冲突',
        '导弹袭击',
        '核威胁',
        '全面制裁',
        '制裁升级',
      ],
      exclude_keywords: ['演习', '模拟', '电影', '游戏'],
      skip_local_agency: false,
      sort_order: 70,
    },
    {
      rule_key: 'disaster_quake',
      name: '重大地震/海啸',
      description: '地震 + 震级/遇难/海啸等 → 5 星',
      enabled: true,
      floor_stars: 5,
      subject_keywords: ['地震'],
      signal_keywords: ['级', '遇难', '死亡', '海啸', '倒塌', '震中', '里氏'],
      exclude_keywords: ['感情', '心里', '心中'],
      skip_local_agency: false,
      sort_order: 80,
    },
    {
      rule_key: 'disaster_extreme',
      name: '极端灾害/核事故',
      description: '超强台风/核泄漏/核事故等 → 5 星',
      enabled: true,
      floor_stars: 5,
      subject_keywords: [],
      signal_keywords: ['超强台风', '核泄漏', '核事故', '海啸预警', '特大洪水', '山火失控'],
      exclude_keywords: [],
      skip_local_agency: false,
      sort_order: 90,
    },
  ];
}

export function evaluateStarFloorRules(
  title: string,
  rules: StarFloorRuleInput[],
): StarFloorEvaluation {
  const text = String(title || '').trim();
  const matchedRules: StarFloorMatch[] = [];
  const skippedLocalKeys: string[] = [];

  if (!text) {
    return { floor_stars: null, matched_rules: [], skipped_local_keys: [] };
  }

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const floor = Number(rule.floor_stars);
    if (!Number.isInteger(floor) || floor < 1 || floor > 5) continue;

    const subjects = asStringList(rule.subject_keywords);
    const signals = asStringList(rule.signal_keywords);
    const excludes = asStringList(rule.exclude_keywords);
    if (!signals.length) continue;

    if (excludes.length && matchKeywords(text, excludes).length) continue;

    const matchedSubjects = subjects.length ? matchKeywords(text, subjects) : [];
    if (subjects.length && !matchedSubjects.length) continue;

    if (rule.skip_local_agency && subjects.length && isLikelyLocalAgencyTitle(text, matchedSubjects)) {
      skippedLocalKeys.push(rule.rule_key);
      continue;
    }

    const matchedSignals = matchKeywords(text, signals);
    if (!matchedSignals.length) continue;

    matchedRules.push({
      rule_key: rule.rule_key,
      name: rule.name,
      floor_stars: floor,
      matched_subjects: matchedSubjects,
      matched_signals: matchedSignals,
    });
  }

  if (!matchedRules.length) {
    return { floor_stars: null, matched_rules: [], skipped_local_keys: skippedLocalKeys };
  }

  const floorStars = Math.max(...matchedRules.map((r) => r.floor_stars));
  return {
    floor_stars: floorStars,
    matched_rules: matchedRules.sort((a, b) => b.floor_stars - a.floor_stars),
    skipped_local_keys: skippedLocalKeys,
  };
}

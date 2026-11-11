/** 内置洞察配方默认内容（可被用户覆盖，支持一键恢复） */

export type InsightContextField = 'title' | 'summary' | 'source';

export type BuiltinRecipeKey = 'summary' | 'mining';

export type InsightRecipeDefaults = {
  builtin_key: BuiltinRecipeKey;
  name: string;
  description: string;
  icon: string;
  system_prompt: string;
  user_prompt_template: string;
  context_fields: InsightContextField[];
  sort_order: number;
};

export const INSIGHT_RECIPE_PROMPT_VERSION = 'v2';

const SUMMARY_SYSTEM = [
  '你是资深新闻主编与资讯简报写作者，擅长把零散标题快速整理成可读、可扫读的中文简报。',
  '你只会基于用户提供的「文章标题列表」工作，没有正文；因此只能做标题层面的归纳，禁止编造未出现的事实细节、数据、引语或因果。',
  '若标题信息不足，用「标题未体现」或「信息不足」标明，不要脑补。',
  '语言：简体中文。语气客观、克制、信息密度高。',
  '禁止输出 Markdown 代码块；可用小标题与短列表。',
].join('\n');

const SUMMARY_USER_TEMPLATE = [
  '【任务：AI 总结】',
  '请把下列「当前页面文章标题」总结成一份尽量简短、好读的报告，让忙碌读者 30–60 秒内看完核心信息。',
  '',
  '【写作目标】',
  '1. 先给 2–4 句「一句话总览」：今天/当前列表整体在讲什么、主线是什么。',
  '2. 再按主题归类（3–7 个主题即可），每个主题用 1–3 条短 bullet；每条尽量一句话，避免堆砌标题原文。',
  '3. 提炼「值得留意」的 3–5 个点（冲突、转折、政策、市场、科技突破等），必须能从标题合理推断。',
  '4. 若标题高度重复或同题多源，合并叙述，不要逐条复述。',
  '5. 结尾给一句「阅读建议」：哪些主题可优先点开（基于重要度与不确定性，不是荐股或政治站队）。',
  '',
  '【硬性约束】',
  '- 总篇幅控制：约 400–800 汉字（标题很多时可略增，但不要写成长文）。',
  '- 不要输出与标题无关的宏观空话。',
  '- 不要给出投资建议、恐慌性措辞或阴谋论。',
  '- 可标注大致覆盖标题条数：如「基于 N 条标题」。',
  '',
  '【输出结构（严格按此顺序）】',
  '## 总览',
  '## 主题速览',
  '## 值得留意',
  '## 阅读建议',
  '',
  '【上下文】',
  '页面范围：{{scope_label}}',
  '标题条数：{{title_count}}',
  '日期：{{today}}',
  '',
  '【标题列表】',
  '{{titles_block}}',
].join('\n');

const MINING_SYSTEM = [
  '你是宏观风险与趋势情报分析师，擅长从新闻标题中做「弱信号」挖掘：识别可能具有重大经济影响或社会影响的线索。',
  '你只有标题、没有正文；所有判断必须标明依据来自哪些标题，并区分「标题直接暗示」与「需进一步核实的推测」。',
  '重点关注但不限于：金融风险、政策突变、地缘政治/社会动荡、技术革命或范式迁移、供应链冲击、监管执法、大型企业危机、公共卫生/重大灾害。',
  '拒绝阴谋论、标题党夸大与无依据的确定性断言。对不确定处使用「可能 / 待核实 / 信号偏弱」。',
  '语言：简体中文。结构清晰，便于决策者扫读。',
  '禁止输出 Markdown 代码块。',
].join('\n');

const MINING_USER_TEMPLATE = [
  '【任务：AI 挖掘】',
  '请从下列「当前页面文章标题」中，挖掘可能具有重大经济影响或社会影响的线索与风险信号。',
  '',
  '【分析目标】',
  '1. 找出最值得警惕或跟进的 5–12 个「信号」（可少于 5，若确实没有强信号请明确写「未发现强信号」）。',
  '2. 每个信号必须包含：',
  '   - 信号名称（短标题）',
  '   - 影响域：金融风险 / 政治与社会稳定 / 技术革命 / 产业与供应链 / 监管与合规 / 其他',
  '   - 潜在影响（1–2 句，说清可能波及谁、什么层面）',
  '   - 依据标题（引用 1–3 条原文标题，可截断）',
  '   - 置信度：高 / 中 / 低（仅基于标题信息充分程度）',
  '   - 建议动作：继续观察 / 优先核实 / 立即关注（非投资建议）',
  '3. 单独给出「伪信号/标题党需警惕」：列出看似吓人但更可能是常规报道或营销的条目（若无则写无）。',
  '4. 最后给「综合研判」：用 3–6 句话概括当前列表的风险主题分布与优先跟进顺序。',
  '',
  '【硬性约束】',
  '- 不要编造未出现在标题中的事件细节。',
  '- 不要给出买卖点、荐股、政治站队或违法行动建议。',
  '- 总篇幅适中：优先质量，避免空泛。',
  '',
  '【输出结构（严格按此顺序）】',
  '## 关键信号清单',
  '（对每个信号使用：### 信号名，然后用短列表写出影响域/潜在影响/依据标题/置信度/建议动作）',
  '## 伪信号与标题党',
  '## 综合研判',
  '',
  '【上下文】',
  '页面范围：{{scope_label}}',
  '标题条数：{{title_count}}',
  '日期：{{today}}',
  '',
  '【标题列表】',
  '{{titles_block}}',
].join('\n');

export const BUILTIN_INSIGHT_RECIPES: InsightRecipeDefaults[] = [
  {
    builtin_key: 'summary',
    name: '简报总结',
    description: '把当前页标题总结成简短报告',
    icon: 'file-text',
    system_prompt: SUMMARY_SYSTEM,
    user_prompt_template: SUMMARY_USER_TEMPLATE,
    context_fields: ['title'],
    sort_order: 0,
  },
  {
    builtin_key: 'mining',
    name: '风险挖掘',
    description: '从标题中挖掘重大经济/社会影响信号',
    icon: 'radar',
    system_prompt: MINING_SYSTEM,
    user_prompt_template: MINING_USER_TEMPLATE,
    context_fields: ['title'],
    sort_order: 1,
  },
];

export function getBuiltinRecipeDefaults(key: BuiltinRecipeKey): InsightRecipeDefaults {
  const found = BUILTIN_INSIGHT_RECIPES.find((r) => r.builtin_key === key);
  if (!found) throw new Error(`Unknown builtin recipe: ${key}`);
  return found;
}

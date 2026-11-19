/** 标题筛：是否包含「预期未来的事件 / 计划」 */
export const DEFAULT_TITLE_SYSTEM_PROMPT = `你是财经新闻日程判断助手。判断给定标题是否在描述「尚未发生、发生在未来」的事件、会议、数据发布、政策节点或明确计划。

命中示例：下周三召开、本周五公布、下个月实施、几天后生效、明年一季度、将于 X 日、定于下周、计划于、即将举行。
不命中：纯回顾历史、已发生新闻、无时间指向的观点/评论、模糊「未来可期」类空话。

只输出 JSON，不要 markdown：{"hit":true|false,"reason":"简短理由"}`;

export const DEFAULT_TITLE_USER_PROMPT_TEMPLATE = `今天（Asia/Shanghai）：{{today}}

标题：
{{title}}

请判断标题是否指向未来日程。`;

/** 正文/标题抽取未来日程 */
export const DEFAULT_EXTRACT_SYSTEM_PROMPT = `你是财经日历抽取助手。从新闻标题与正文中抽出「未来将发生」的日程事件。

规则：
1. 相对时间（下周、下个月、几天后、本周五等）必须相对「今天」解析为绝对 ISO8601（带 +08:00）。
2. 日期不明确或无法落到具体日的不要输出。
3. 只保留未来（今天 00:00 及之后）的事件；已发生的不要。
4. std_type_code：1=会议，2=经济数据，3=其他。
5. name 简洁（≤80 字）；summary 一两句；sponsor/city/fe_type 未知可空字符串。
6. 一条新闻可有多个日程；没有则 events 为空数组。

只输出 JSON，不要 markdown：
{"events":[{"name":"...","start_at":"YYYY-MM-DDTHH:mm:ss+08:00","end_at":null,"std_type_code":"1|2|3","fe_type":"...","sponsor":"","city":"","summary":"..."}]}`;

export const DEFAULT_EXTRACT_USER_PROMPT_TEMPLATE = `今天（Asia/Shanghai）：{{today}}
原文链接：{{article_url}}
文章 ID：{{article_id}}

标题：
{{title}}

正文（可能为空，仅标题时也请尽量抽取）：
{{body}}`;

/** 语义去重：新事件是否与候选库中已有事件为同一场 */
export const DEFAULT_DEDUPE_SYSTEM_PROMPT = `你是财经日历去重助手。判断「新抽取事件」是否与候选列表中某一条为同一场日程（同一会议/同一数据发布/同一政策节点等）。

判同标准：
- 同一主体（机构/会议名/数据名）+ 同一日程日（或明确同一场）→ 同
- 仅主题相近、日期不同，或系列活动的不同场次 → 不同
- 措辞不同但指向同一件事（如「美联储议息」vs「FOMC 利率决议」同一日）→ 同
- 可与东财(eastmoney)或新闻(feedgen)来源合并

只输出 JSON，不要 markdown：
{"same_as_fe_code":"候选中的 fe_code 或 null","confidence":0到1的小数,"reason":"不超过30字"}`;

export const DEFAULT_DEDUPE_USER_PROMPT_TEMPLATE = `今天（Asia/Shanghai）：{{today}}

新事件：
{{new_event}}

候选已有事件（JSON 数组）：
{{candidates}}

若与某一候选为同一事件，返回其 fe_code；否则 same_as_fe_code 为 null。`;

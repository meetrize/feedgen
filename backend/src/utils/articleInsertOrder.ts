/**
 * 规则爬取按 DOM 自上而下得到条目；逐条入库时 created_at 递增，
 * 前台默认按 created_at 降序展示，故需倒序入库以与源站列表顺序一致。
 */
export function articlesForDbInsert<T>(items: readonly T[]): T[] {
  if (items.length <= 1) return [...items];
  return [...items].reverse();
}

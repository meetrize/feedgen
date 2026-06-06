/** 原生 Feed / 连接预检使用的浏览器 UA，避免境外站点拦截 Bot 标识 */
export const FEED_FETCH_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

export function getFeedFetchHeaders(): Record<string, string> {
  return {
    'User-Agent': FEED_FETCH_USER_AGENT,
    Accept: 'application/rss+xml, application/xml, text/xml, application/atom+xml, */*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  };
}

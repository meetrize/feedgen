-- Dev seed for public feed sharing (optional manual run)
INSERT INTO "public_feeds" (
  "title", "description", "url", "url_normalized", "source_type",
  "source_fingerprint", "feed_type", "favicon_url", "status", "verified", "subscriber_count"
) VALUES
  (
    'Hacker News',
    'Hacker News RSS — 科技创业社区热门链接',
    'https://hnrss.org/frontpage',
    'https://hnrss.org/frontpage',
    'native',
    encode(sha256('native:https://hnrss.org/frontpage'::bytea), 'hex'),
    'rss',
    'https://news.ycombinator.com/favicon.ico',
    'approved',
    true,
    0
  ),
  (
    '少数派',
    '高质量科技媒体，每日更新数码与生活内容',
    'https://sspai.com/feed',
    'https://sspai.com/feed',
    'native',
    encode(sha256('native:https://sspai.com/feed'::bytea), 'hex'),
    'rss',
    'https://cdn.sspai.com/sspai/assets/img/favicon.ico',
    'approved',
    false,
    0
  )
ON CONFLICT ("source_fingerprint") DO NOTHING;

const { PrismaClient } = require('@prisma/client');
const { createHash } = require('crypto');

const prisma = new PrismaClient();

function fp(url) {
  return createHash('sha256').update(`native:${url}`, 'utf8').digest('hex');
}

const seeds = [
  {
    title: 'Hacker News',
    description: 'Hacker News RSS — 科技创业社区热门链接',
    url: 'https://hnrss.org/frontpage',
    favicon_url: 'https://news.ycombinator.com/favicon.ico',
    verified: true,
    tags: ['tech'],
  },
  {
    title: '少数派',
    description: '高质量科技媒体，每日更新数码与生活内容',
    url: 'https://sspai.com/feed',
    favicon_url: 'https://cdn.sspai.com/sspai/assets/img/favicon.ico',
    verified: false,
    tags: ['tech'],
  },
];

async function main() {
  for (const item of seeds) {
    const urlNorm = item.url;
    const sourceFingerprint = fp(urlNorm);
    await prisma.publicFeed.upsert({
      where: { source_fingerprint: sourceFingerprint },
      create: {
        title: item.title,
        description: item.description,
        url: item.url,
        url_normalized: urlNorm,
        source_type: 'native',
        source_fingerprint: sourceFingerprint,
        favicon_url: item.favicon_url,
        verified: item.verified,
        tags: item.tags,
        status: 'approved',
        is_active: true,
      },
      update: {
        title: item.title,
        description: item.description,
        favicon_url: item.favicon_url,
        verified: item.verified,
        tags: item.tags,
        updated_at: new Date(),
      },
    });
    console.log('seeded', item.title);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

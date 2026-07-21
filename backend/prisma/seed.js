/**
 * 初始化本地开发数据：
 * - 管理员：用户名 admin / 密码 admin123
 * - 会员套餐配置 + user_plans，并将 admin 设为免费版
 *
 * 执行：在 backend 目录下 npx prisma db seed 或 npm run db:seed
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

const MEMBERSHIP_PLANS = [
  {
    id: 1,
    name: '免费版',
    description: '适合轻度使用，个人日常阅读。',
    price_label: '免费',
    price_suffix: '/年',
    max_feeds: 30,
    max_private_feeds: 3,
    max_public_subscriptions: 30,
    min_fetch_interval: 1800,
    history_days: 30,
    storage_mb: 500,
    highlight: false,
    sort_order: 1,
  },
  {
    id: 2,
    name: '普通会员',
    description: '适合深度用户，提升信息覆盖范围。',
    price_label: '¥98',
    price_suffix: '/年',
    max_feeds: 200,
    max_private_feeds: 20,
    max_public_subscriptions: 200,
    min_fetch_interval: 600,
    history_days: 180,
    storage_mb: 5120,
    highlight: true,
    sort_order: 2,
  },
  {
    id: 3,
    name: '超级会员',
    description: '适合团队/重度监控，高频抓取与长期沉淀。',
    price_label: '¥580',
    price_suffix: '/年',
    max_feeds: 1000,
    max_private_feeds: 100,
    max_public_subscriptions: 1000,
    min_fetch_interval: 60,
    history_days: 1095,
    storage_mb: 51200,
    highlight: false,
    sort_order: 3,
  },
];

async function seedMembershipPlans() {
  for (const plan of MEMBERSHIP_PLANS) {
    const { id, ...data } = plan;
    await prisma.membership_plan_configs.upsert({
      where: { id },
      create: { id, ...data },
      update: data,
    });
    await prisma.user_plans.upsert({
      where: { id },
      create: {
        id,
        name: plan.name,
        description: plan.description,
        max_feeds: plan.max_feeds,
        duration_days: plan.history_days || 30,
      },
      update: {
        name: plan.name,
        description: plan.description,
        max_feeds: plan.max_feeds,
        duration_days: plan.history_days || 30,
      },
    });
  }
}

async function main() {
  await seedMembershipPlans();

  const hash = await bcrypt.hash('admin123', 10);
  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {
      password_hash: hash,
      is_admin: true,
      is_anonymous: false,
      current_plan_id: 1,
    },
    create: {
      username: 'admin',
      email: 'admin@feedgen.local',
      password_hash: hash,
      is_admin: true,
      is_anonymous: false,
      current_plan_id: 1,
    },
  });

  console.log('套餐配置已就绪（免费/普通/超级）');
  console.log(`管理员已就绪：用户名 admin，密码 admin123（id=${admin.id}）`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

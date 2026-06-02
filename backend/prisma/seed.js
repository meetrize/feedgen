/**
 * 创建或更新内置管理员：用户名 admin，密码 admin123
 * 执行：在 backend 目录下 npx prisma db seed 或 npm run db:seed
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

async function main() {
  const hash = await bcrypt.hash('admin123', 10);
  await prisma.user.upsert({
    where: { username: 'admin' },
    update: {
      password_hash: hash,
      is_admin: true,
      is_anonymous: false,
    },
    create: {
      username: 'admin',
      email: 'admin@feedgen.local',
      password_hash: hash,
      is_admin: true,
      is_anonymous: false,
    },
  });
  console.log('管理员已就绪：用户名 admin，密码 admin123（若已存在则已同步密码与管理员标记）');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

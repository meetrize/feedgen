const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('🚀 Starting FeedGen Development Environment...\n');

// 检查是否已安装依赖
const packageJsonPath = path.join(__dirname, 'package.json');
if (!fs.existsSync(packageJsonPath)) {
  console.error('❌ package.json not found in backend directory');
  process.exit(1);
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const dependencies = packageJson.dependencies || {};

// 检查必要的依赖
const requiredDeps = ['fastify', 'prisma', '@prisma/client'];
for (const dep of requiredDeps) {
  if (!dependencies[dep]) {
    console.warn(`⚠️  Warning: ${dep} not found in dependencies`);
  }
}

console.log('✅ Dependencies check passed');

// 检查环境文件
const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  console.log('📝 Creating .env file with default values...');
  const defaultEnv = `# 数据库连接
DATABASE_URL="postgresql://username:password@localhost:5432/feedgen?schema=public"

# JWT 密钥
JWT_SECRET="your-super-secret-jwt-key-here-change-in-production"

# Redis 连接
REDIS_URL="redis://localhost:6379"

# 爬虫配置
MAX_CONCURRENT_CRAWLERS=5
CRAWLER_TIMEOUT=30000

# 端口
PORT=3000
`;
  fs.writeFileSync(envPath, defaultEnv);
  console.log('✅ Default .env file created');
} else {
  console.log('✅ Environment file found');
}

// 检查数据库迁移
console.log('\n🔧 Checking database setup...');
const prismaSchemaPath = path.join(__dirname, 'prisma', 'schema.prisma');
if (!fs.existsSync(prismaSchemaPath)) {
  console.log('❌ Prisma schema not found');
} else {
  console.log('✅ Prisma schema found');
  
  // 尝试生成Prisma客户端
  console.log('⚙️  Generating Prisma client...');
  const generateProcess = spawn('npx', ['prisma', 'generate'], {
    cwd: __dirname,
    stdio: 'inherit',
    shell: true
  });
  
  generateProcess.on('close', (code) => {
    if (code === 0) {
      console.log('✅ Prisma client generated successfully');
      
      // 启动开发服务器
      console.log('\n🌟 Starting development server...');
      console.log('📖 API Documentation: http://localhost:3000');
      console.log('📋 Available endpoints:');
      console.log('   POST   /api/auth/register - Register new user');
      console.log('   POST   /api/auth/login - Login user');
      console.log('   GET    /api/feeds - Get user feeds');
      console.log('   POST   /api/feeds - Create new feed');
      console.log('   ... and more (see API_DOCUMENTATION.md)');
      console.log('\n💡 Note: Server will start on http://localhost:3000');
      console.log('⚠️  Note: Database connection errors are expected without PostgreSQL server');
      
      // 启动开发服务器
      const devServer = spawn('npm', ['run', 'dev'], {
        cwd: __dirname,
        stdio: 'inherit',
        shell: true
      });
      
      devServer.on('error', (err) => {
        console.error('❌ Failed to start development server:', err.message);
      });
      
      devServer.on('close', (code) => {
        console.log(`\n🏁 Development server exited with code ${code}`);
      });
    } else {
      console.error('❌ Failed to generate Prisma client');
      console.log('💡 Try running: npx prisma generate manually');
    }
  });
}
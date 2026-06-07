import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';

// 创建 Fastify 实例
const server: FastifyInstance = fastify({ 
  logger: true 
});

// 初始化数据库客户端
let prisma: any;

// 动态导入PrismaClient
const initPrisma = async () => {
  if (!prisma) {
    const PrismaClientModule = await import('@prisma/client');
    const PrismaClientConstructor = (PrismaClientModule as any).PrismaClient || PrismaClientModule.default;
    prisma = new PrismaClientConstructor();
    await prisma.$connect();
  }
  return prisma;
};

/** 供爬虫等模块使用，确保 Prisma 已 connect 后再访问 */
export async function getPrisma() {
  return initPrisma();
}

export { prisma, initPrisma };

// 注册插件
server.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});

server.register(jwt, { 
  secret: process.env.JWT_SECRET || 'your-secret-key-here' 
});

// 启用响应压缩，降低文章列表等大 JSON 传输开销
server.register(compress, {
  global: true,
  threshold: 1024,
  encodings: ['br', 'gzip', 'deflate'],
});

// 注册认证装饰器
server.decorate('authenticate', async function (this: FastifyInstance, req: any, res: any) {
  try {
    // 从请求头获取token
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).send({ error: 'Authentication required' });
      return;
    }

    const token = authHeader.substring(7); // 移除 "Bearer " 前缀
    
    // 验证JWT token
    const decoded: any = await req.jwtVerify();
    
    // 将用户信息附加到请求对象
    req.user = decoded;
  } catch (error) {
    req.log.error(error);
    res.status(401).send({ error: 'Invalid or expired token' });
  }
});

// 根路径默认进入文章阅读器
server.get('/', async (req, res) => {
  return res.redirect('/article-reader.html');
});

// 错误处理
server.setErrorHandler((error: any, request: any, reply: any) => {
  server.log.error(error);
  reply.status(500).send({ error: 'Internal Server Error' });
});

// 缓存 CSS 文件名可能含查询串片段（如 .css__v1_uuid），扩展名无法被识别为 .css，@fastify/static 会回退为 application/octet-stream；
// 跨域 stylesheet 要求 Content-Type 为 text/css，否则浏览器拒绝解析。
server.addHook('onSend', async (request, reply, payload) => {
  const rawPath = request.raw.url?.split('?')[0] ?? '';
  if (rawPath.startsWith('/css-cache/')) {
    reply.header('Content-Type', 'text/css; charset=utf-8');
  }
  return payload;
});

// 启动服务器
const start = async () => {
  try {
    // 初始化数据库连接
    await initPrisma();
    
    // 注册静态文件服务，提供CSS缓存
    server.register(fastifyStatic, {
      root: path.join(__dirname, '../../frontend/css-cache'), // 使用__dirname确保正确的相对路径
      prefix: '/css-cache/', // 路由前缀
      decorateReply: false
    });
    
    // 添加一个通用的静态资源处理路由，避免404错误
    server.get('/_next/*', async (req, res) => {
      // 对于Next.js相关资源，返回空响应或重定向到合适的内容
      res.code(200).header('Content-Type', 'text/plain').send('');
    });
    
    server.get('/assets/*', async (req, res) => {
      // 对于assets资源，返回空响应或重定向到合适的内容
      res.code(200).header('Content-Type', 'text/plain').send('');
    });
    
    server.get('/static/*', async (req, res) => {
      // 对于static资源，返回空响应或重定向到合适的内容
      res.code(200).header('Content-Type', 'text/plain').send('');
    });

    // 注册路由
    const { feedRoutes } = await import('./routes/feed');
    const { authRoutes } = await import('./routes/auth');
    const { billingRoutes } = await import('./routes/billing');
    const { pageRendererRoutes } = await import('./routes/page-renderer');
    const { adminRoutes } = await import('./routes/admin');
    const { feedSubscriptionRoutes } = await import('./routes/feed-subscription');
    const { membershipRoutes } = await import('./routes/membership');
    const { crawlerStrategyRoutes } = await import('./routes/crawler-strategy');
    const { captchaRelayRoutes } = await import('./routes/captcha-relay');
    const { classificationAdminRoutes } = await import('./routes/classification-admin');
    const { classificationPublicRoutes } = await import('./routes/classification-public');

    server.register(authRoutes, { prefix: '/api/auth' });
    server.register(feedRoutes, { prefix: '/api/feeds' });
    server.register(feedSubscriptionRoutes, { prefix: '/api/feed-subscriptions' });
    server.register(billingRoutes, { prefix: '/api/billing' });
    server.register(pageRendererRoutes, { prefix: '/api/page-renderer' });
    const { livePreviewRoutes } = await import('./routes/live-preview');
    server.register(livePreviewRoutes, { prefix: '/api/page-renderer/live' });
    server.register(adminRoutes, { prefix: '/api/admin' });
    server.register(classificationAdminRoutes, { prefix: '/api/admin/classification' });
    server.register(classificationPublicRoutes, { prefix: '/api/classification' });
    server.register(membershipRoutes, { prefix: '/api/membership' });
    server.register(crawlerStrategyRoutes, { prefix: '/api/crawler-strategies' });
    server.register(captchaRelayRoutes, { prefix: '/api/captcha-relay' });

    // 经反代（如 63443）访问时同源提供前端静态页，避免跨域 CORS 问题
    server.register(fastifyStatic, {
      root: path.join(__dirname, '../../frontend'),
      prefix: '/',
      decorateReply: false,
      index: false,
    });
    
    const port = parseInt(process.env.PORT || '3000');
    await server.listen({ port, host: '0.0.0.0' });
    console.log(`Server running on http://localhost:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();

export { server };
const fastify = require('fastify')({ logger: true });

// 基础路由
fastify.get('/', async (request, reply) => {
  return { 
    message: 'FeedGen Backend API', 
    version: '1.0.0',
    status: 'running',
    services: {
      httpServer: 'running',
      crawlerWorker: 'ready',
      scheduler: 'ready'
    }
  };
});

// 模拟认证路由
fastify.post('/api/auth/register', async (request, reply) => {
  const { email, password } = request.body || {};
  
  if (!email || !password) {
    return reply.status(400).send({ error: 'Email and password are required' });
  }
  
  // 模拟用户创建
  return {
    token: 'mock-jwt-token-for-testing',
    user: {
      id: 1,
      email: email,
      plan: 'free'
    }
  };
});

fastify.post('/api/auth/login', async (request, reply) => {
  const { email, password } = request.body || {};
  
  if (!email || !password) {
    return reply.status(400).send({ error: 'Email and password are required' });
  }
  
  // 模拟用户登录
  return {
    token: 'mock-jwt-token-for-testing',
    user: {
      id: 1,
      email: email,
      plan: 'basic'
    }
  };
});

// 模拟Feed管理路由
fastify.get('/api/feeds', async (request, reply) => {
  // 检查认证头
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Authentication required' });
  }
  
  // 返回模拟的Feeds数据
  return {
    feeds: [
      {
        id: 1,
        name: "Tech News",
        targetUrl: "https://example.com/tech",
        selectorRules: {
          item: ".article",
          title: "h2.title",
          link: "a.read-more@href",
          description: ".summary"
        },
        updateInterval: 3600,
        status: "active",
        lastFetchedAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      }
    ]
  };
});

fastify.post('/api/feeds', async (request, reply) => {
  // 检查认证头
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Authentication required' });
  }
  
  const feedData = request.body || {};
  
  // 返回模拟创建的Feed
  return {
    feed: {
      id: Math.floor(Math.random() * 1000),
      name: feedData.name || "New Feed",
      targetUrl: feedData.targetUrl || "https://example.com",
      selectorRules: feedData.selectorRules || {},
      updateInterval: feedData.updateInterval || 3600,
      status: "active",
      lastFetchedAt: null,
      createdAt: new Date().toISOString()
    }
  };
});

// 模拟计费路由
fastify.get('/api/billing/usage', async (request, reply) => {
  // 检查认证头
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Authentication required' });
  }
  
  return {
    usage: {
      userId: 1,
      plan: "basic",
      feedCount: 2,
      requestCount: 45,
      limits: {
        feeds: 10,
        requests: 10000
      },
      canCreateMoreFeeds: true,
      canMakeMoreRequests: true
    }
  };
});

// 启动服务器
const start = async () => {
  try {
    await fastify.listen({ port: 3000, host: '127.0.0.1' });
    console.log('✅ FeedGen Test Server is running on http://127.0.0.1:3000');
    console.log('\n🧪 Testing endpoints:');
    console.log('   GET  http://127.0.0.1:3000/ - Health check');
    console.log('   POST http://127.0.0.1:3000/api/auth/register - Register user');
    console.log('   POST http://127.0.0.1:3000/api/auth/login - Login user');
    console.log('   GET  http://127.0.0.1:3000/api/feeds - Get feeds (requires auth)');
    console.log('   POST http://127.0.0.1:3000/api/feeds - Create feed (requires auth)');
    console.log('   GET  http://127.0.0.1:3000/api/billing/usage - Get usage (requires auth)');
    console.log('\n💡 To test authentication-requiring endpoints, use token: mock-jwt-token-for-testing');
    console.log('   Example: Authorization: Bearer mock-jwt-token-for-testing');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

// 优雅关闭
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await fastify.close();
  process.exit(0);
});
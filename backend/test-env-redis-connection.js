/**
 * 测试使用环境变量的Redis连接
 */

// 从环境变量加载配置
require('dotenv').config({ path: './.env' });

const redis = require('redis');

async function testEnvRedisConnection() {
  console.log('🔍 测试使用环境变量的Redis连接...');
  console.log(`REDIS_URL: ${process.env.REDIS_URL}`);
  
  // 使用环境变量中的Redis URL
  const client = redis.createClient({
    url: process.env.REDIS_URL
  });

  try {
    // 监听错误事件
    client.on('error', (err) => {
      console.error('Redis Client Error:', err.message);
    });

    // 尝试连接
    await client.connect();
    console.log('✅ 成功连接到Redis服务器');

    // 尝试设置和获取一个值
    await client.set('env-test-key', 'env-test-value');
    const value = await client.get('env-test-key');
    console.log(`✅ Redis操作正常: env-test-key = ${value}`);

    // 清理测试数据
    await client.del('env-test-key');

    console.log('✅ 环境变量Redis连接测试完成，一切正常');
    
    await client.quit();
    console.log('✅ 已断开Redis连接');
  } catch (error) {
    console.error('❌ Redis连接测试失败:', error.message);
    
    try {
      await client.quit();
    } catch (quitError) {
      console.error('断开连接时出错:', quitError.message);
    }
  }
}

// 运行测试
testEnvRedisConnection();
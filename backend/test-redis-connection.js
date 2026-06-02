/**
 * 测试Redis连接
 */

const redis = require('redis');

async function testRedisConnection() {
  console.log('🔍 测试Redis连接到 117.72.44.160...');

  const client = redis.createClient({
    socket: {
      host: '117.72.44.160',
      port: 6379,
    },
    password: 'guestR56Y', // 添加Redis密码
    connectTimeout: 10000, // 增加连接超时时间到10秒
    commandTimeout: 10000  // 增加命令超时时间到10秒
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
    await client.set('test-key', 'test-value');
    const value = await client.get('test-key');
    console.log(`✅ Redis操作正常: test-key = ${value}`);

    // 清理测试数据
    await client.del('test-key');

    console.log('✅ Redis连接测试完成，一切正常');
    
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
testRedisConnection();
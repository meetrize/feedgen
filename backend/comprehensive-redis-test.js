/**
 * 全面的Redis连接测试
 */

const redis = require('redis');

async function comprehensiveRedisTest() {
  console.log('🔍 开始全面Redis连接测试...');
  
  const client = redis.createClient({
    socket: {
      host: '117.72.44.160',
      port: 6379,
    },
    password: 'guestR56Y', // Redis密码
    connectTimeout: 10000, // 10秒连接超时
    commandTimeout: 10000  // 10秒命令超时
  });

  try {
    // 监听错误事件
    client.on('error', (err) => {
      console.error('Redis Client Error:', err.message);
    });

    // 连接Redis
    await client.connect();
    console.log('✅ 成功连接到Redis服务器');

    // 1. 测试基本的SET/GET操作
    await client.set('test-key', 'test-value');
    const value = await client.get('test-key');
    console.log(`✅ 基本操作正常: test-key = ${value}`);

    // 2. 测试带过期时间的键
    await client.setEx('expiring-key', 10, 'expires-in-10s'); // 10秒后过期
    const expiringValue = await client.get('expiring-key');
    console.log(`✅ 过期键操作正常: expiring-key = ${expiringValue}`);

    // 3. 测试哈希操作
    await client.hSet('hash-key', 'field1', 'value1');
    await client.hSet('hash-key', 'field2', 'value2');
    const hashValue = await client.hGetAll('hash-key');
    console.log(`✅ 哈希操作正常: hash-key =`, hashValue);

    // 4. 测试列表操作
    await client.lPush('list-key', 'item1', 'item2', 'item3');
    const listLength = await client.lLen('list-key');
    const listItems = await client.lRange('list-key', 0, -1);
    console.log(`✅ 列表操作正常: list-key 长度=${listLength}, 项目=${JSON.stringify(listItems)}`);

    // 5. 测试集合操作
    await client.sAdd('set-key', 'member1', 'member2', 'member3');
    const setSize = await client.sCard('set-key');
    const setMembers = await client.sMembers('set-key');
    console.log(`✅ 集合操作正常: set-key 大小=${setSize}, 成员=${JSON.stringify(setMembers)}`);

    // 6. 测试键的存在性检查
    const exists = await client.exists('test-key');
    console.log(`✅ 键存在性检查正常: test-key 存在=${exists ? '是' : '否'}`);

    // 7. 测试获取所有键（注意：在生产环境中要小心使用）
    const keys = await client.keys('*');
    console.log(`✅ 键查询正常: 找到 ${keys.length} 个键`);

    // 清理测试数据
    await client.del('test-key', 'expiring-key', 'hash-key', 'list-key', 'set-key');
    console.log('✅ 测试数据清理完成');

    console.log('🎉 所有Redis功能测试通过！');
    
    await client.quit();
    console.log('✅ 已断开Redis连接');
  } catch (error) {
    console.error('❌ Redis综合测试失败:', error.message);
    
    try {
      await client.quit();
    } catch (quitError) {
      console.error('断开连接时出错:', quitError.message);
    }
  }
}

// 运行测试
comprehensiveRedisTest();
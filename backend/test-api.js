const axios = require('axios');

// API测试脚本
async function testAPI() {
  const baseURL = 'http://127.0.0.1:3000';
  console.log('🧪 Starting API tests...\n');
  
  try {
    // 1. 测试健康检查端点
    console.log('1. Testing health check endpoint...');
    const healthResponse = await axios.get(`${baseURL}/`);
    console.log('✅ Health check:', healthResponse.status, healthResponse.data);
    
    // 2. 测试用户注册
    console.log('\n2. Testing user registration...');
    const registerResponse = await axios.post(`${baseURL}/api/auth/register`, {
      email: 'test@example.com',
      password: 'password123'
    });
    console.log('✅ Registration:', registerResponse.status, { 
      token: registerResponse.data.token ? 'RECEIVED' : 'MISSING', 
      user: registerResponse.data.user 
    });
    
    // 3. 测试用户登录
    console.log('\n3. Testing user login...');
    const loginResponse = await axios.post(`${baseURL}/api/auth/login`, {
      email: 'test@example.com',
      password: 'password123'
    });
    console.log('✅ Login:', loginResponse.status, { 
      token: loginResponse.data.token ? 'RECEIVED' : 'MISSING', 
      user: loginResponse.data.user 
    });
    
    // 保存登录令牌供后续测试使用
    const authToken = loginResponse.data.token;
    
    // 4. 测试获取Feeds（需要认证）
    console.log('\n4. Testing get feeds (with auth)...');
    const feedsResponse = await axios.get(`${baseURL}/api/feeds`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    console.log('✅ Get Feeds:', feedsResponse.status, feedsResponse.data);
    
    // 5. 测试创建Feed（需要认证）
    console.log('\n5. Testing create feed (with auth)...');
    const createFeedResponse = await axios.post(`${baseURL}/api/feeds`, {
      name: 'Test Feed',
      targetUrl: 'https://example.com/news',
      selectorRules: {
        item: '.article',
        title: 'h2.title',
        link: 'a.read-more@href'
      }
    }, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    console.log('✅ Create Feed:', createFeedResponse.status, { 
      feed: createFeedResponse.data.feed 
    });
    
    // 6. 测试获取使用情况（需要认证）
    console.log('\n6. Testing get billing usage (with auth)...');
    const usageResponse = await axios.get(`${baseURL}/api/billing/usage`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    console.log('✅ Billing Usage:', usageResponse.status, { 
      usage: usageResponse.data.usage 
    });
    
    // 7. 测试无认证访问（应该失败）
    console.log('\n7. Testing unauthorized access (should fail)...');
    try {
      await axios.get(`${baseURL}/api/feeds`);
      console.log('❌ Expected authorization error but got success');
    } catch (error) {
      if (error.response && error.response.status === 401) {
        console.log('✅ Correctly rejected unauthorized request:', error.response.status);
      } else {
        console.log('❌ Unexpected error:', error.message);
      }
    }
    
    console.log('\n🎉 All tests completed successfully!');
    console.log('\n✨ FeedGen backend service is running correctly!');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    }
  }
}

// 运行测试
testAPI();
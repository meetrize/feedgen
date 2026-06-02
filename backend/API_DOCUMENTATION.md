# FeedGen Backend API 文档

## 概述

FeedGen 是一个将任意网站新闻转换为 RSS/Atom Feed XML 的 SaaS 服务。本API提供了用户管理、Feed订阅管理、计费等功能。

## 基础信息

- **基础URL**: `http://localhost:3000/api`
- **认证方式**: JWT Bearer Token
- **内容类型**: `application/json`

## 认证

所有需要认证的API端点都需要在请求头中包含JWT令牌：

```
Authorization: Bearer <your-jwt-token>
```

## API 端点

### 认证相关

#### 1. 用户注册
- **URL**: `POST /api/auth/register`
- **描述**: 创建新用户账户
- **请求体**:
```json
{
  "email": "user@example.com",
  "password": "securepassword"
}
```
- **响应**:
```json
{
  "token": "jwt-token-string",
  "user": {
    "id": 1,
    "email": "user@example.com"
  }
}
```

#### 2. 用户登录
- **URL**: `POST /api/auth/login`
- **描述**: 登录现有用户
- **请求体**:
```json
{
  "email": "user@example.com",
  "password": "securepassword"
}
```
- **响应**:
```json
{
  "token": "jwt-token-string",
  "user": {
    "id": 1,
    "email": "user@example.com"
  }
}
```

#### 3. 获取当前用户信息
- **URL**: `GET /api/auth/me`
- **描述**: 获取当前认证用户的信息
- **认证**: 需要JWT令牌
- **响应**:
```json
{
  "user": {
    "id": 1,
    "email": "user@example.com",
    "plan": "basic",
    "createdAt": "2023-01-01T00:00:00.000Z"
  }
}
```

### Feed 管理

#### 1. 获取用户的所有Feeds
- **URL**: `GET /api/feeds`
- **描述**: 获取当前用户创建的所有Feed订阅
- **认证**: 需要JWT令牌
- **响应**:
```json
{
  "feeds": [
    {
      "id": 1,
      "name": "Tech News",
      "targetUrl": "https://example.com/news",
      "selectorRules": {
        "item": ".article",
        "title": "h2.title",
        "link": "a.read-more@href",
        "description": ".summary",
        "pubDate": "time@datetime"
      },
      "updateInterval": 3600,
      "status": "active",
      "lastFetchedAt": "2023-01-01T00:00:00.000Z",
      "createdAt": "2023-01-01T00:00:00.000Z",
      "articles": [
        {
          "id": 1,
          "title": "Sample Article",
          "link": "https://example.com/article/1",
          "description": "Sample description",
          "pubDate": "2023-01-01T00:00:00.000Z"
        }
      ]
    }
  ]
}
```

#### 2. 创建新的Feed
- **URL**: `POST /api/feeds`
- **描述**: 创建一个新的Feed订阅
- **认证**: 需要JWT令牌
- **请求体**:
```json
{
  "name": "Tech News",
  "targetUrl": "https://example.com/news",
  "selectorRules": {
    "item": ".article",
    "title": "h2.title",
    "link": "a.read-more@href",
    "description": ".summary",
    "pubDate": "time@datetime"
  },
  "updateInterval": 3600
}
```
- **响应**:
```json
{
  "feed": {
    "id": 1,
    "name": "Tech News",
    "targetUrl": "https://example.com/news",
    "selectorRules": {
      "item": ".article",
      "title": "h2.title",
      "link": "a.read-more@href",
      "description": ".summary",
      "pubDate": "time@datetime"
    },
    "updateInterval": 3600,
    "status": "active",
    "lastFetchedAt": null,
    "createdAt": "2023-01-01T00:00:00.000Z"
  }
}
```

#### 3. 更新Feed
- **URL**: `PUT /api/feeds/:id`
- **描述**: 更新现有的Feed订阅
- **认证**: 需要JWT令牌
- **参数**: `id` - Feed的ID
- **请求体** (可选字段):
```json
{
  "name": "Updated Tech News",
  "targetUrl": "https://updated-example.com/news",
  "selectorRules": {
    "item": ".article",
    "title": "h2.title",
    "link": "a.read-more@href",
    "description": ".summary",
    "pubDate": "time@datetime"
  },
  "updateInterval": 7200,
  "status": "paused"
}
```
- **响应**:
```json
{
  "feed": {
    "id": 1,
    "name": "Updated Tech News",
    "targetUrl": "https://updated-example.com/news",
    "selectorRules": {
      "item": ".article",
      "title": "h2.title",
      "link": "a.read-more@href",
      "description": ".summary",
      "pubDate": "time@datetime"
    },
    "updateInterval": 7200,
    "status": "paused",
    "lastFetchedAt": "2023-01-01T00:00:00.000Z",
    "createdAt": "2023-01-01T00:00:00.000Z"
  }
}
```

#### 4. 删除Feed
- **URL**: `DELETE /api/feeds/:id`
- **描述**: 删除指定的Feed订阅
- **认证**: 需要JWT令牌
- **参数**: `id` - Feed的ID
- **响应**:
```json
{
  "message": "Feed deleted successfully"
}
```

#### 5. 获取单个Feed详情
- **URL**: `GET /api/feeds/:id`
- **描述**: 获取指定Feed的详细信息
- **认证**: 需要JWT令牌
- **参数**: `id` - Feed的ID
- **响应**:
```json
{
  "feed": {
    "id": 1,
    "name": "Tech News",
    "targetUrl": "https://example.com/news",
    "selectorRules": {
      "item": ".article",
      "title": "h2.title",
      "link": "a.read-more@href",
      "description": ".summary",
      "pubDate": "time@datetime"
    },
    "updateInterval": 3600,
    "status": "active",
    "lastFetchedAt": "2023-01-01T00:00:00.000Z",
    "createdAt": "2023-01-01T00:00:00.000Z",
    "articles": [
      {
        "id": 1,
        "title": "Sample Article",
        "link": "https://example.com/article/1",
        "description": "Sample description",
        "pubDate": "2023-01-01T00:00:00.000Z",
        "cachedAt": "2023-01-01T00:00:00.000Z",
        "expiresAt": "2023-01-01T06:00:00.000Z"
      }
    ]
  }
}
```

#### 6. 预览Feed
- **URL**: `GET /api/feeds/:id/preview`
- **描述**: 预览指定Feed的内容（触发一次抓取）
- **认证**: 需要JWT令牌
- **参数**: `id` - Feed的ID
- **响应**:
```json
{
  "preview": {
    "feedId": 1,
    "name": "Tech News",
    "targetUrl": "https://example.com/news",
    "lastFetchedAt": "2023-01-01T00:00:00.000Z",
    "status": "active",
    "sampleArticles": [
      {
        "title": "Sample Article Title",
        "link": "https://example.com/article",
        "description": "This is a sample article description.",
        "pubDate": "2023-01-01T00:00:00.000Z"
      }
    ]
  }
}
```

### 计费相关

#### 1. 获取使用情况
- **URL**: `GET /api/billing/usage`
- **描述**: 获取当前用户的使用情况和套餐信息
- **认证**: 需要JWT令牌
- **响应**:
```json
{
  "usage": {
    "userId": 1,
    "plan": "basic",
    "feedCount": 3,
    "requestCount": 150,
    "limits": {
      "feeds": 10,
      "requests": 10000
    },
    "canCreateMoreFeeds": true,
    "canMakeMoreRequests": true
  }
}
```

#### 2. 获取账单记录
- **URL**: `GET /api/billing/records`
- **描述**: 获取当前用户的账单记录
- **认证**: 需要JWT令牌
- **响应**:
```json
{
  "records": [
    {
      "id": 1,
      "userId": 1,
      "feedCount": 3,
      "requestCount": 150,
      "amount": 9.90,
      "billingPeriod": "2023-01",
      "createdAt": "2023-01-01T00:00:00.000Z"
    }
  ]
}
```

#### 3. 获取当前账单周期信息
- **URL**: `GET /api/billing/current-cycle`
- **描述**: 获取当前账单周期的信息
- **认证**: 需要JWT令牌
- **响应**:
```json
{
  "record": {
    "id": 1,
    "userId": 1,
    "feedCount": 3,
    "requestCount": 150,
    "amount": null,
    "billingPeriod": "2023-12",
    "createdAt": "2023-12-01T00:00:00.000Z"
  }
}
```

## Feed 访问端点（公开）

#### RSS Feed 输出
- **URL**: `GET /api/feeds/:id/rss.xml`
- **描述**: 获取指定Feed的RSS 2.0格式输出
- **认证**: 无需认证（公开访问）
- **参数**: `id` - Feed的ID

#### Atom Feed 输出
- **URL**: `GET /api/feeds/:id/atom.xml`
- **描述**: 获取指定Feed的Atom 1.0格式输出
- **认证**: 无需认证（公开访问）
- **参数**: `id` - Feed的ID

#### JSON Feed 输出
- **URL**: `GET /api/feeds/:id/json`
- **描述**: 获取指定Feed的JSON格式输出
- **认证**: 无需认证（公开访问）
- **参数**: `id` - Feed的ID

## 错误响应

所有错误响应都遵循以下格式：

```json
{
  "error": "Error message"
}
```

常见错误码：
- `400`: 请求参数错误
- `401`: 未认证或认证失败
- `404`: 资源未找到
- `500`: 服务器内部错误

## 使用示例

### 使用curl进行注册
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "securepassword"
  }'
```

### 使用curl获取Feeds列表
```bash
curl -X GET http://localhost:3000/api/feeds \
  -H "Authorization: Bearer your-jwt-token" \
  -H "Content-Type: application/json"
```

### 使用curl创建新Feed
```bash
curl -X POST http://localhost:3000/api/feeds \
  -H "Authorization: Bearer your-jwt-token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Blog",
    "targetUrl": "https://myblog.com/posts",
    "selectorRules": {
      "item": ".post",
      "title": "h3.title",
      "link": "a.post-link@href",
      "description": ".excerpt"
    }
  }'
```

## 测试方法

### 方法1: 使用curl命令行测试

#### 1.1 测试服务健康状态
```bash
curl -X GET http://localhost:3000/
```

#### 1.2 测试用户注册
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "password123"
  }'
```

#### 1.3 测试用户登录
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "password123"
  }'
```

#### 1.4 测试获取Feeds（需要认证）
```bash
curl -X GET http://localhost:3000/api/feeds \
  -H "Authorization: Bearer YOUR_JWT_TOKEN_HERE" \
  -H "Content-Type: application/json"
```

#### 1.5 测试创建Feed（需要认证）
```bash
curl -X POST http://localhost:3000/api/feeds \
  -H "Authorization: Bearer YOUR_JWT_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Feed",
    "targetUrl": "https://example.com/news",
    "selectorRules": {
      "item": ".article",
      "title": "h2.title",
      "link": "a.read-more@href"
    }
  }'
```

#### 1.6 测试获取计费使用情况（需要认证）
```bash
curl -X GET http://localhost:3000/api/billing/usage \
  -H "Authorization: Bearer YOUR_JWT_TOKEN_HERE" \
  -H "Content-Type: application/json"
```

### 方法2: 使用Node.js脚本测试

创建一个测试脚本 `test-api.js`:

```javascript
const axios = require('axios');

// 替换为你的服务器地址
const baseURL = 'http://localhost:3000';

async function testAPI() {
  try {
    // 1. 测试健康检查
    console.log('Testing health check...');
    const health = await axios.get(`${baseURL}/`);
    console.log('Health:', health.data);

    // 2. 测试用户注册
    console.log('\nTesting registration...');
    const register = await axios.post(`${baseURL}/api/auth/register`, {
      email: 'test@example.com',
      password: 'password123'
    });
    console.log('Registration:', register.data);

    // 3. 测试用户登录
    console.log('\nTesting login...');
    const login = await axios.post(`${baseURL}/api/auth/login`, {
      email: 'test@example.com',
      password: 'password123'
    });
    console.log('Login:', login.data);
    
    // 保存认证令牌
    const token = login.data.token;

    // 4. 测试获取Feeds（需要认证）
    console.log('\nTesting get feeds...');
    const feeds = await axios.get(`${baseURL}/api/feeds`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    console.log('Get Feeds:', feeds.data);

    // 5. 测试创建Feed（需要认证）
    console.log('\nTesting create feed...');
    const createFeed = await axios.post(`${baseURL}/api/feeds`, {
      name: 'Test Feed',
      targetUrl: 'https://example.com/news',
      selectorRules: {
        item: '.article',
        title: 'h2.title',
        link: 'a.read-more@href'
      }
    }, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    console.log('Create Feed:', createFeed.data);

    // 6. 测试获取计费使用情况（需要认证）
    console.log('\nTesting billing usage...');
    const usage = await axios.get(`${baseURL}/api/billing/usage`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    console.log('Billing Usage:', usage.data);

    console.log('\n✅ All tests passed!');
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    }
  }
}

testAPI();
```

运行测试脚本：
```bash
npm install axios
node test-api.js
```

### 方法3: 使用Postman或其他API测试工具

1. 导入以下Postman集合：
```json
{
  "info": {
    "name": "FeedGen API Tests",
    "_postman_id": "feedgen-test-collection",
    "description": "API tests for FeedGen backend service"
  },
  "item": [
    {
      "name": "Health Check",
      "request": {
        "method": "GET",
        "header": [],
        "url": {
          "raw": "http://localhost:3000/",
          "protocol": "http",
          "host": ["localhost"],
          "port": "3000",
          "path": [""]
        }
      }
    },
    {
      "name": "Register User",
      "request": {
        "method": "POST",
        "header": [
          {
            "key": "Content-Type",
            "value": "application/json"
          }
        ],
        "body": {
          "mode": "raw",
          "raw": "{\n  \"email\": \"test@example.com\",\n  \"password\": \"password123\"\n}"
        },
        "url": {
          "raw": "http://localhost:3000/api/auth/register",
          "protocol": "http",
          "host": ["localhost"],
          "port": "3000",
          "path": ["api", "auth", "register"]
        }
      }
    },
    {
      "name": "Login User",
      "request": {
        "method": "POST",
        "header": [
          {
            "key": "Content-Type",
            "value": "application/json"
          }
        ],
        "body": {
          "mode": "raw",
          "raw": "{\n  \"email\": \"test@example.com\",\n  \"password\": \"password123\"\n}"
        },
        "url": {
          "raw": "http://localhost:3000/api/auth/login",
          "protocol": "http",
          "host": ["localhost"],
          "port": "3000",
          "path": ["api", "auth", "login"]
        }
      }
    }
  ]
}
```

2. 在Postman中设置环境变量 `{{base_url}}` 为 `http://localhost:3000`
3. 运行各个请求进行测试

### 方法4: 自动化测试脚本

创建一个完整的自动化测试脚本 `automated-test.js`:

```javascript
const axios = require('axios');

class APITester {
  constructor(baseURL = 'http://localhost:3000') {
    this.baseURL = baseURL;
    this.token = null;
    this.testResults = [];
  }

  async testEndpoint(name, method, path, data = null, headers = {}) {
    try {
      const response = await axios({
        method,
        url: `${this.baseURL}${path}`,
        data,
        headers
      });

      const result = {
        name,
        status: 'PASS',
        statusCode: response.status,
        message: 'OK'
      };

      this.testResults.push(result);
      console.log(`✅ ${name}: ${response.status} - PASS`);
      return response;
    } catch (error) {
      const result = {
        name,
        status: 'FAIL',
        statusCode: error.response?.status || 'N/A',
        message: error.message
      };

      this.testResults.push(result);
      console.log(`❌ ${name}: ${error.response?.status || 'N/A'} - FAIL (${error.message})`);
      return error.response || null;
    }
  }

  async runAllTests() {
    console.log('🧪 Starting API tests...\n');

    // 1. Health check
    await this.testEndpoint('Health Check', 'GET', '/');

    // 2. Register user
    const registerResp = await this.testEndpoint('User Registration', 'POST', '/api/auth/register', {
      email: 'test@example.com',
      password: 'password123'
    }, {
      'Content-Type': 'application/json'
    });

    // 3. Login user
    const loginResp = await this.testEndpoint('User Login', 'POST', '/api/auth/login', {
      email: 'test@example.com',
      password: 'password123'
    }, {
      'Content-Type': 'application/json'
    });

    if (loginResp && loginResp.data && loginResp.data.token) {
      this.token = loginResp.data.token;
      
      // 4. Get feeds (with auth)
      await this.testEndpoint('Get Feeds', 'GET', '/api/feeds', null, {
        'Authorization': `Bearer ${this.token}`
      });

      // 5. Create feed (with auth)
      await this.testEndpoint('Create Feed', 'POST', '/api/feeds', {
        name: 'Test Feed',
        targetUrl: 'https://example.com/news',
        selectorRules: {
          item: '.article',
          title: 'h2.title',
          link: 'a.read-more@href'
        }
      }, {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      });

      // 6. Get billing usage (with auth)
      await this.testEndpoint('Get Billing Usage', 'GET', '/api/billing/usage', null, {
        'Authorization': `Bearer ${this.token}`
      });
    }

    // 7. Test unauthorized access
    await this.testEndpoint('Unauthorized Access', 'GET', '/api/feeds');

    console.log('\n📊 Test Results Summary:');
    const passed = this.testResults.filter(r => r.status === 'PASS').length;
    const failed = this.testResults.filter(r => r.status === 'FAIL').length;
    
    console.log(`Total: ${this.testResults.length}, Passed: ${passed}, Failed: ${failed}`);
    
    if (failed === 0) {
      console.log('\n🎉 All tests passed! The API is working correctly.');
    } else {
      console.log('\n⚠️  Some tests failed. Please check the API implementation.');
    }
  }
}

// Run the tests
const tester = new APITester();
tester.runAllTests();
```

运行自动化测试：
```bash
node automated-test.js
```

这些测试方法可以帮助您验证API的各个方面，确保服务正常运行。
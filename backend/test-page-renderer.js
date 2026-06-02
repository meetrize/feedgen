const axios = require('axios');

async function testPageRenderer() {
  try {
    console.log('Testing page renderer API...');
    
    const response = await axios.post('http://localhost:3000/api/page-renderer/render', {
      url: 'https://httpbin.org/html', // 简单的测试页面
      waitForAjax: false
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer dummy-token' // 使用虚拟token，因为目前可能不需要认证
      },
      timeout: 30000
    });
    
    console.log('Response received:', response.status);
    console.log('HTML length:', response.data.html.length);
    console.log('Title:', response.data.title);
    console.log('Found elements:', response.data.elements.length);
    
    // 只显示前几个元素的信息
    console.log('Sample elements:', response.data.elements.slice(0, 3));
  } catch (error) {
    if (error.response) {
      console.error('API Error:', error.response.status, error.response.data);
    } else if (error.request) {
      console.error('Request Error:', error.message);
    } else {
      console.error('General Error:', error.message);
    }
  }
}

// 等待一段时间后再测试，确保Playwright安装完成
setTimeout(testPageRenderer, 5000);
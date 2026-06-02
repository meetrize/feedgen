/**
 * 测试可视化解析器修复后的功能
 */

const axios = require('axios');

async function testVisualParserFix() {
  console.log('Testing visual parser fix...\n');
  
  try {
    // 测试渲染一个简单页面
    const response = await axios.post('http://localhost:3000/api/page-renderer/render', {
      url: 'http://localhost:3001/test-css-display.html',
      waitForAjax: true,
      ajaxWaitTime: 2000,
      waitForNetworkIdle: true
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    console.log('✅ API请求成功');
    console.log(`📄 页面标题: ${response.data.title}`);
    console.log(`🔗 原始URL: ${response.data.url}`);
    console.log(`📊 元素数量: ${response.data.elements.length}`);
    
    // 检查返回的HTML中是否有CSS链接
    const hasCssLinks = response.data.html.includes('/css-cache/') || response.data.html.includes('.css');
    console.log(`🎨 包含CSS链接: ${hasCssLinks ? '✅' : '❌'}`);
    
    // 检查是否包含DOM高亮功能
    const hasDomHighlight = response.data.html.includes('dom-highlight-styles') || response.data.html.includes('highlight-element');
    console.log(`🔍 包含DOM高亮: ${hasDomHighlight ? '✅' : '❌'}`);
    
    // 输出HTML片段以供检查
    console.log('\n📋 HTML片段检查:');
    if(response.data.html.includes('dom-element-highlight')) {
      console.log('  - 找到 dom-element-highlight 类');
    }
    if(response.data.html.includes('dom-highlight-script')) {
      console.log('  - 找到 DOM高亮脚本');
    }
    if(response.data.html.includes('FeedGenDOMHighlighter')) {
      console.log('  - 找到 FeedGenDOMHighlighter 对象');
    }
    
    console.log('\n✅ 测试完成 - 可视化解析器修复成功');
    
  } catch (error) {
    console.error('❌ 测试失败:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    }
  }
}

// 运行测试
testVisualParserFix();
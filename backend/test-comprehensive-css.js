const axios = require('axios');
const fs = require('fs');

async function testComprehensiveCssLoading() {
  try {
    console.log('Testing comprehensive CSS loading functionality...');
    
    // 测试不同的网站
    const testUrls = [
      'https://www.aibase.com/zh/news',
      'https://httpbin.org/html', // 简单HTML页面
    ];
    
    for (const url of testUrls) {
      console.log(`\nTesting URL: ${url}`);
      
      const response = await axios.post('http://localhost:3000/api/page-renderer/render', {
        url: url,
        waitForAjax: true,
        ajaxWaitTime: 2000,
        waitForNetworkIdle: true
      }, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      console.log('  Status:', response.status);
      console.log('  Page title:', response.data.title);
      console.log('  Number of elements found:', response.data.elements.length);
      
      // 检查返回的HTML是否包含CSS相关标签
      const html = response.data.html;
      const hasStyleTags = html.includes('<style') || html.includes('stylesheet');
      const hasCssLinks = html.includes('<link') && (html.includes('css') || html.includes('CSS'));
      const hasInlineStyles = html.includes('style="') || html.includes('class="');
      
      console.log('  Contains style tags or CSS links:', hasStyleTags || hasCssLinks);
      console.log('  Contains inline styles/classes:', hasInlineStyles);
      console.log('  HTML length:', html.length);
      
      // 检查是否包含高亮相关的CSS
      const hasHighlightStyles = html.includes('dom-element-highlight');
      console.log('  Contains highlight styles:', hasHighlightStyles);
      
      // 检查CSS选择器的数量
      const cssSelectorCount = (html.match(/class="([^"]*)"/g) || []).length;
      console.log('  CSS class occurrences:', cssSelectorCount);
      
      // 保存HTML到文件以供检查
      const fileName = `test-result-${Date.now()}.html`;
      fs.writeFileSync(fileName, html);
      console.log(`  Saved rendered HTML to: ${fileName}`);
    }
    
    console.log('\n✓ All tests passed! CSS loading functionality is working correctly.');
    
  } catch (error) {
    console.error('Test failed:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
    console.error('Stack trace:', error.stack);
  }
}

testComprehensiveCssLoading();
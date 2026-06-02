const axios = require('axios');

async function testCssLoading() {
  try {
    console.log('Testing CSS loading functionality...');
    
    const response = await axios.post('http://localhost:3000/api/page-renderer/render', {
      url: 'https://www.aibase.com/zh/news',
      waitForAjax: true,
      ajaxWaitTime: 3000
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Status:', response.status);
    console.log('Page title:', response.data.title);
    console.log('Number of elements found:', response.data.elements.length);
    
    // 检查返回的HTML是否包含CSS相关标签
    const html = response.data.html;
    const hasStyleTags = html.includes('<style') || html.includes('stylesheet');
    const hasCssLinks = html.includes('<link') && html.includes('css');
    
    console.log('Contains style tags or CSS links:', hasStyleTags || hasCssLinks);
    console.log('HTML length:', html.length);
    
    // 检查是否包含高亮相关的CSS
    const hasHighlightStyles = html.includes('dom-element-highlight');
    console.log('Contains highlight styles:', hasHighlightStyles);
    
  } catch (error) {
    console.error('Test failed:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
  }
}

testCssLoading();
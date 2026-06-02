const axios = require('axios');
const fs = require('fs');

async function testCssDownloadFeature() {
  try {
    console.log('Testing CSS download and caching functionality...');
    
    const response = await axios.post('http://localhost:3000/api/page-renderer/render', {
      url: 'https://www.aibase.com/zh/news',
      waitForAjax: true,
      ajaxWaitTime: 2000,
      waitForNetworkIdle: true
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
    const hasCssLinks = html.includes('<link') && (html.includes('css') || html.includes('CSS'));
    
    console.log('Contains style tags or CSS links:', hasStyleTags || hasCssLinks);
    console.log('HTML length:', html.length);
    
    // 检查是否包含高亮相关的CSS
    const hasHighlightStyles = html.includes('dom-element-highlight');
    console.log('Contains highlight styles:', hasHighlightStyles);
    
    // 检查是否包含本地CSS缓存路径
    const hasLocalCssPaths = html.includes('/css-cache/');
    console.log('Contains local CSS cache paths:', hasLocalCssPaths);
    
    // 检查CSS选择器的数量
    const cssSelectorCount = (html.match(/class="([^"]*)"/g) || []).length;
    console.log('CSS class occurrences:', cssSelectorCount);
    
    // 保存HTML到文件以供检查
    const fileName = `test-result-with-css-cache-${Date.now()}.html`;
    fs.writeFileSync(fileName, html);
    console.log(`Saved rendered HTML to: ${fileName}`);
    
    console.log('\n✓ CSS download and caching test completed!');
    
    // 检查CSS缓存目录
    const cacheDir = '../frontend/css-cache';
    try {
      const dirs = fs.readdirSync(cacheDir);
      console.log(`CSS cache directories: ${dirs.join(', ')}`);
      
      for (const dir of dirs) {
        const files = fs.readdirSync(`${cacheDir}/${dir}`);
        console.log(`Files in ${dir}: ${files.length} files`);
      }
    } catch (e) {
      console.log('CSS cache directory does not exist or is empty');
    }
    
  } catch (error) {
    console.error('Test failed:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
    console.error('Stack trace:', error.stack);
  }
}

testCssDownloadFeature();
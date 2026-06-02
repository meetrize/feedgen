// iframe内的鼠标悬停检测脚本
(function() {
  let lastHoveredElement = null;
  let isDetectionEnabled = false;

  // 启用悬停检测
  function enableHoverDetection() {
    if (isDetectionEnabled) return;
    
    document.addEventListener('mousemove', handleMouseMove);
    isDetectionEnabled = true;
    console.log('悬停检测已启用');
  }

  // 处理鼠标移动事件
  function handleMouseMove(e) {
    // 获取鼠标位置下的元素
    const element = document.elementFromPoint(e.clientX, e.clientY);
    
    // 如果元素与上次不同，则发送消息
    if (element && element !== lastHoveredElement) {
      lastHoveredElement = element;
      
      // 获取元素位置信息
      const rect = element.getBoundingClientRect();
      const elementInfo = {
        tagName: element.tagName,
        className: element.className,
        id: element.id,
        rect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          right: rect.right,
          bottom: rect.bottom
        }
      };

      // 发送消息到父窗口
      window.parent.postMessage({
        type: 'ELEMENT_AT_COORDINATES',
        elementInfo: elementInfo
      }, '*');
    }
  }

  // 监听来自父窗口的消息
  window.addEventListener('message', function(event) {
    if (event.data.type === 'GET_ELEMENT_AT_COORDINATES') {
      const x = event.data.x;
      const y = event.data.y;
      
      // 获取指定坐标的元素
      const element = document.elementFromPoint(x, y);
      if (element) {
        const rect = element.getBoundingClientRect();
        const elementInfo = {
          tagName: element.tagName,
          className: element.className,
          id: element.id,
          rect: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            right: rect.right,
            bottom: rect.bottom
          }
        };

        // 发送消息到父窗口
        window.parent.postMessage({
          type: 'ELEMENT_AT_COORDINATES',
          elementInfo: elementInfo
        }, '*');
      }
    }
    else if (event.data.type === 'PREVENT_LINK_NAVIGATION') {
      // 阻止链接跳转
      preventLinkNavigation();
    }
    else if (event.data.type === 'HIGHLIGHT_ELEMENT_AT_COORDINATES') {
      // 高亮指定坐标的元素（可选功能）
      const x = event.data.x;
      const y = event.data.y;
      const element = document.elementFromPoint(x, y);
      if (element) {
        highlightElementTemporarily(element);
      }
    }
  });

  // 阻止链接跳转
  function preventLinkNavigation() {
    const allLinks = document.querySelectorAll('a');
    allLinks.forEach(link => {
      link.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        
        // 触发选择流程
        window.parent.postMessage({
          type: 'LINK_CLICKED',
          element: {
            tagName: this.tagName,
            className: this.className,
            id: this.id,
            textContent: this.textContent
          },
          elementType: 'link'
        }, '*');
      });
    });
  }

  // 临时高亮元素
  function highlightElementTemporarily(element) {
    // 移除之前的高亮
    const existingHighlight = document.querySelector('#temp-element-highlight');
    if (existingHighlight) {
      existingHighlight.remove();
    }
    
    // 创建临时高亮
    const highlight = document.createElement('div');
    highlight.id = 'temp-element-highlight';
    highlight.style.position = 'fixed';
    const rect = element.getBoundingClientRect();
    highlight.style.left = rect.left + 'px';
    highlight.style.top = rect.top + 'px';
    highlight.style.width = rect.width + 'px';
    highlight.style.height = rect.height + 'px';
    highlight.style.border = '2px dashed red';
    highlight.style.pointerEvents = 'none';
    highlight.style.zIndex = '999999';
    highlight.style.boxSizing = 'border-box';
    
    document.body.appendChild(highlight);
    
    // 300ms后移除高亮
    setTimeout(() => {
      if (document.contains(highlight)) {
        highlight.remove();
      }
    }, 300);
  }

  // 初始化
  enableHoverDetection();
  
  // 发送就绪消息到父窗口
  window.parent.postMessage({
    type: 'IFRAME_READY'
  }, '*');
})();
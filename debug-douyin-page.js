async function debugDouyinPage() {
  console.log('开始分析抖音页面内容...\n');
  
  const testVideoUrl = 'https://www.douyin.com/video/7617686082800323840';
  
  try {
    const response = await fetch(testVideoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
        'Referer': 'https://www.douyin.com/'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch video page: ${response.status}`);
    }

    const html = await response.text();
    
    console.log('页面长度:', html.length);
    
    // 保存页面内容到文件以便分析
    const fs = require('fs');
    fs.writeFileSync('douyin-page.html', html);
    console.log('页面内容已保存到 douyin-page.html');
    
    // 查找所有script标签
    const scriptMatches = html.match(/<script[^>]*>[\s\S]*?<\/script>/g);
    if (scriptMatches) {
      console.log('\n找到', scriptMatches.length, '个script标签');
      
      scriptMatches.forEach((script, index) => {
        const content = script.replace(/<script[^>]*>|<\/script>/g, '');
        if (content.length > 100) {
          console.log(`\nScript ${index + 1}: 长度 ${content.length}`);
          
          // 查找可能包含视频数据的脚本
          if (content.includes('video') || content.includes('data') || content.includes('window.')) {
            const preview = content.substring(0, 200);
            console.log('预览:', preview);
          }
        }
      });
    }
    
    // 查找所有可能的JSON数据
    console.log('\n查找JSON数据...');
    const jsonMatches = html.match(/\{[\s\S]{50,}\}/g);
    if (jsonMatches) {
      console.log('找到', jsonMatches.length, '个可能的JSON对象');
      
      jsonMatches.forEach((jsonStr, index) => {
        if (jsonStr.includes('video') || jsonStr.includes('play') || jsonStr.includes('url')) {
          console.log(`\nJSON ${index + 1}:`);
          try {
            const jsonObj = JSON.parse(jsonStr);
            console.log('键:', Object.keys(jsonObj));
          } catch (e) {
            console.log('无法解析，预览:', jsonStr.substring(0, 100));
          }
        }
      });
    }
    
    // 查找所有URL
    console.log('\n查找所有URL...');
    const urlMatches = html.match(/https?:\/\/[^\s"'<>]+/g);
    if (urlMatches) {
      console.log('找到', urlMatches.length, '个URL');
      
      // 查找可能包含视频的URL
      const videoUrls = urlMatches.filter(url => 
        url.includes('video') || 
        url.includes('mp4') || 
        url.includes('byte') ||
        url.includes('tos')
      );
      
      console.log('\n可能包含视频的URL:', videoUrls.length, '个');
      videoUrls.slice(0, 5).forEach((url, i) => {
        console.log(`${i + 1}. ${url.substring(0, 100)}...`);
      });
    }
    
  } catch (error) {
    console.error('分析失败:', error.message);
  }
}

debugDouyinPage().catch(console.error);

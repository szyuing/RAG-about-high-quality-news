const { fetch } = require('node-fetch');

async function debugDouyinPage() {
  console.log('开始调试抖音页面...\n');
  
  const testVideoUrl = 'https://www.douyin.com/video/7617686082800323840';
  
  console.log('测试视频链接:', testVideoUrl);
  console.log('开始获取页面内容...\n');
  
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
    
    console.log('页面获取成功！');
    console.log('页面长度:', html.length);
    console.log('\n=== 查找SSR数据 ===');
    const ssrDataMatch = html.match(/<script[^>]*>window\._SSR_HYDRATED_DATA\s*=\s*({[\s\S]*?})<\/script>/);
    if (ssrDataMatch) {
      console.log('找到SSR数据，长度:', ssrDataMatch[1].length);
      try {
        const ssrData = JSON.parse(ssrDataMatch[1]);
        console.log('SSR数据结构:', Object.keys(ssrData));
        if (ssrData.app) {
          console.log('SSR app结构:', Object.keys(ssrData.app));
        }
      } catch (error) {
        console.log('解析SSR数据失败:', error.message);
      }
    } else {
      console.log('未找到SSR数据');
    }
    
    console.log('\n=== 查找RENDER数据 ===');
    const renderDataMatch = html.match(/<script[^>]*>window\._RENDER_DATA\s*=\s*({[\s\S]*?})<\/script>/);
    if (renderDataMatch) {
      console.log('找到RENDER数据，长度:', renderDataMatch[1].length);
    } else {
      console.log('未找到RENDER数据');
    }
    
    console.log('\n=== 查找video标签 ===');
    const videoTagMatch = html.match(/<video[^>]*src="([^"]*)"[^>]*>/);
    if (videoTagMatch) {
      console.log('找到video标签，src:', videoTagMatch[1]);
    } else {
      console.log('未找到video标签');
    }
    
    console.log('\n=== 查找play_url ===');
    const playUrlMatch = html.match(/play_url["']?\s*:\s*["']([^"']+)["']/);
    if (playUrlMatch) {
      console.log('找到play_url:', playUrlMatch[1]);
    } else {
      console.log('未找到play_url');
    }
    
    console.log('\n=== 查找所有mp4链接 ===');
    const allUrls = html.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/g);
    if (allUrls) {
      console.log('找到', allUrls.length, '个mp4链接');
      allUrls.forEach((url, index) => {
        console.log(`${index + 1}. ${url}`);
      });
    } else {
      console.log('未找到mp4链接');
    }
    
    console.log('\n=== 查找标题 ===');
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/);
    if (titleMatch) {
      console.log('找到标题:', titleMatch[1]);
    } else {
      console.log('未找到标题');
    }
    
  } catch (error) {
    console.error('调试失败:', error.message);
    console.error('错误详情:', error);
  }
}

// 运行调试
debugDouyinPage().catch(console.error);

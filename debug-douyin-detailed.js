async function debugDouyin() {
  console.log('开始详细调试抖音视频下载...\n');
  
  // 测试短链接处理
  const shortUrl = 'https://v.douyin.com/iFRqB6x/';
  console.log('测试1: 短链接处理');
  console.log('原始链接:', shortUrl);
  
  try {
    const response = await fetch(shortUrl, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
      }
    });
    
    console.log('响应状态:', response.status);
    
    if (response.status === 302 || response.status === 301) {
      const location = response.headers.get('location');
      console.log('重定向到:', location);
      
      if (location) {
        const videoIdMatch = location.match(/video\/(\d+)/);
        if (videoIdMatch) {
          console.log('提取到视频ID:', videoIdMatch[1]);
        } else {
          console.log('无法从重定向URL中提取视频ID');
          console.log('尝试其他模式匹配...');
          const altMatch = location.match(/\/(\d{10,})/);
          if (altMatch) {
            console.log('使用备用模式提取到ID:', altMatch[1]);
          }
        }
      }
    } else {
      console.log('不是重定向响应，尝试获取内容');
      const html = await response.text();
      console.log('页面长度:', html.length);
    }
  } catch (error) {
    console.error('短链接处理失败:', error.message);
  }

  console.log('\n测试2: API接口测试');
  const testVideoUrl = 'https://www.douyin.com/video/7617686082800323840';
  const apiUrl = 'https://api.yessi.dev/douyin';
  
  try {
    console.log('调用API:', `${apiUrl}?url=${encodeURIComponent(testVideoUrl)}`);
    const apiResponse = await fetch(`${apiUrl}?url=${encodeURIComponent(testVideoUrl)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
      }
    });
    
    console.log('API响应状态:', apiResponse.status);
    console.log('API响应头:', Object.fromEntries(apiResponse.headers.entries()));
    
    const apiData = await apiResponse.text();
    console.log('API响应内容:', apiData.substring(0, 500));
    
    try {
      const jsonData = JSON.parse(apiData);
      console.log('解析后的JSON:', JSON.stringify(jsonData, null, 2));
    } catch (e) {
      console.log('无法解析为JSON，可能是HTML或其他格式');
    }
  } catch (error) {
    console.error('API调用失败:', error.message);
  }

  console.log('\n测试3: 直接获取抖音页面');
  try {
    const response = await fetch(testVideoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
        'Referer': 'https://www.douyin.com/'
      }
    });
    
    console.log('页面响应状态:', response.status);
    
    if (response.ok) {
      const html = await response.text();
      console.log('页面长度:', html.length);
      
      // 查找各种数据
      console.log('\n查找SSR数据...');
      const ssrMatch = html.match(/window\._SSR_HYDRATED_DATA\s*=\s*({[\s\S]*?})<\/script>/);
      if (ssrMatch) {
        console.log('找到SSR数据，长度:', ssrMatch[1].length);
        try {
          const ssrData = JSON.parse(ssrMatch[1]);
          console.log('SSR数据键:', Object.keys(ssrData));
        } catch (e) {
          console.log('SSR数据解析失败');
        }
      } else {
        console.log('未找到SSR数据');
      }
      
      console.log('\n查找RENDER数据...');
      const renderMatch = html.match(/window\._RENDER_DATA\s*=\s*({[\s\S]*?})<\/script>/);
      if (renderMatch) {
        console.log('找到RENDER数据，长度:', renderMatch[1].length);
      } else {
        console.log('未找到RENDER数据');
      }
      
      console.log('\n查找video标签...');
      const videoMatch = html.match(/<video[^>]*>/);
      if (videoMatch) {
        console.log('找到video标签:', videoMatch[0].substring(0, 100));
      } else {
        console.log('未找到video标签');
      }
      
      console.log('\n查找mp4链接...');
      const mp4Matches = html.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/g);
      if (mp4Matches) {
        console.log('找到', mp4Matches.length, '个mp4链接');
        mp4Matches.slice(0, 3).forEach((url, i) => {
          console.log(`${i + 1}. ${url.substring(0, 80)}...`);
        });
      } else {
        console.log('未找到mp4链接');
      }
      
      console.log('\n查找标题...');
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/);
      if (titleMatch) {
        console.log('标题:', titleMatch[1]);
      } else {
        console.log('未找到标题');
      }
    }
  } catch (error) {
    console.error('页面获取失败:', error.message);
  }
}

debugDouyin().catch(console.error);

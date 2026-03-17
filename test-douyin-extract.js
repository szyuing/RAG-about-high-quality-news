const { ToolRegistry } = require('./src/source-connectors');

async function testDouyinVideoExtract() {
  console.log('开始测试抖音视频信息提取功能...\n');
  
  // 测试完整视频链接
  const testVideoUrl = 'https://www.douyin.com/video/7617686082800323840';
  
  console.log('测试1: 提取完整链接视频信息');
  console.log('测试视频链接:', testVideoUrl);
  
  try {
    const result1 = await ToolRegistry.executeTool('extract_douyin_video_info', {
      videoUrl: testVideoUrl
    });
    
    console.log('\n完整返回结果:');
    console.log(JSON.stringify(result1, null, 2));
    
    if (result1.success && result1.data) {
      const data = result1.data;
      console.log('\n提取结果:');
      console.log('标题:', data.title);
      console.log('视频ID:', data.videoId);
      console.log('原始URL:', data.originalUrl);
      console.log('解析后的URL:', data.resolvedUrl);
      console.log('视频下载地址:', data.videoDownloadUrl ? '已找到' : '未找到');
      console.log('提取方法:', data.extractionMethod);
      console.log('是否有JS保护:', data.hasJsProtection);
      console.log('页面长度:', data.pageLength);
      console.log('提取状态:', data.extractionStatus);
      
      if (data.suggestions && data.suggestions.length > 0) {
        console.log('\n建议:');
        data.suggestions.forEach((suggestion, index) => {
          console.log(`${index + 1}. ${suggestion}`);
        });
      }
    } else {
      console.log('提取失败:', result1.error);
    }
  } catch (error) {
    console.error('提取失败:', error.message);
    console.error('错误堆栈:', error.stack);
  }

  // 测试短链接
  console.log('\n\n测试2: 提取短链接视频信息');
  const shortUrl = 'https://v.douyin.com/iFRqB6x/';
  console.log('测试短链接:', shortUrl);
  
  try {
    const result2 = await ToolRegistry.executeTool('extract_douyin_video_info', {
      videoUrl: shortUrl
    });
    
    if (result2.success && result2.data) {
      const data = result2.data;
      console.log('\n提取结果:');
      console.log('标题:', data.title);
      console.log('视频ID:', data.videoId);
      console.log('原始URL:', data.originalUrl);
      console.log('解析后的URL:', data.resolvedUrl);
      console.log('短链接重定向:', data.shortUrlRedirect);
      console.log('视频下载地址:', data.videoDownloadUrl ? '已找到' : '未找到');
      console.log('提取状态:', data.extractionStatus);
    } else {
      console.log('提取失败:', result2.error);
    }
  } catch (error) {
    console.error('提取失败:', error.message);
  }

  console.log('\n\n测试完成！');
}

// 运行测试
testDouyinVideoExtract().catch(console.error);

const { ToolRegistry } = require('./src/source-connectors');

async function testDouyinVideoDownload() {
  console.log('开始测试抖音视频下载功能...\n');
  
  // 使用真实的抖音视频链接
  const testVideoUrl = 'https://www.douyin.com/video/7617686082800323840';
  
  console.log('测试视频链接:', testVideoUrl);
  console.log('开始下载视频...\n');
  
  try {
    const result = await ToolRegistry.executeTool('download_douyin_video', {
      videoUrl: testVideoUrl,
      outputDir: './test-downloads',
      format: 'mp4',
      watermark: false
    });
    
    console.log('下载成功！');
    console.log('结果:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('下载失败:', error.message);
    console.error('错误详情:', error);
  }
}

// 运行测试
testDouyinVideoDownload().catch(console.error);

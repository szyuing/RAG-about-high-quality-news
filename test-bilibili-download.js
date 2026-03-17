const { ToolRegistry } = require('./src/source-connectors');

async function testBilibiliAudioDownload() {
  console.log('开始测试哔站音频下载功能...\n');
  
  // 使用一个公开的哔站视频链接进行测试
  // 这里使用一个常见的音乐视频作为测试
  const testVideoUrl = 'https://www.bilibili.com/video/BV1xx411c7mD';
  
  console.log('测试视频链接:', testVideoUrl);
  console.log('开始下载音频...\n');
  
  try {
    const result = await ToolRegistry.executeTool('download_bilibili_audio', {
      videoUrl: testVideoUrl,
      outputDir: './test-downloads',
      format: 'mp3'
    });
    
    console.log('下载成功！');
    console.log('结果:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('下载失败:', error.message);
    console.error('错误详情:', error);
  }
}

// 运行测试
testBilibiliAudioDownload().catch(console.error);

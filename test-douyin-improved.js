const { ToolRegistry } = require('./src/source-connectors');

async function testDouyinVideoDownload() {
  console.log('开始测试改进后的抖音视频下载功能...\n');
  
  // 使用真实的抖音视频链接
  const testVideoUrl = 'https://www.douyin.com/video/7617686082800323840';
  
  console.log('测试1: 直接解析页面模式');
  console.log('测试视频链接:', testVideoUrl);
  console.log('开始下载视频...\n');
  
  try {
    const result1 = await ToolRegistry.executeTool('download_douyin_video', {
      videoUrl: testVideoUrl,
      outputDir: './test-downloads',
      format: 'mp4',
      watermark: false,
      useApi: false
    });
    
    console.log('直接解析模式结果:', result1.success ? '成功' : '失败');
    if (result1.success) {
      console.log('文件名:', result1.fileName);
      console.log('文件大小:', result1.fileSize, 'bytes');
    } else {
      console.log('错误:', result1.error);
    }
  } catch (error) {
    console.error('直接解析模式失败:', error.message);
  }

  console.log('\n测试2: API接口模式');
  try {
    const result2 = await ToolRegistry.executeTool('download_douyin_video', {
      videoUrl: testVideoUrl,
      outputDir: './test-downloads',
      format: 'mp4',
      watermark: false,
      useApi: true
    });
    
    console.log('API接口模式结果:', result2.success ? '成功' : '失败');
    if (result2.success) {
      console.log('文件名:', result2.fileName);
      console.log('文件大小:', result2.fileSize, 'bytes');
      console.log('使用API:', result2.apiUsed);
    } else {
      console.log('错误:', result2.error);
    }
  } catch (error) {
    console.error('API接口模式失败:', error.message);
  }

  console.log('\n测试3: 测试短链接');
  const shortUrl = 'https://v.douyin.com/iFRqB6x/';
  console.log('测试短链接:', shortUrl);
  
  try {
    const result3 = await ToolRegistry.executeTool('download_douyin_video', {
      videoUrl: shortUrl,
      outputDir: './test-downloads',
      format: 'mp4',
      watermark: false,
      useApi: false
    });
    
    console.log('短链接测试结果:', result3.success ? '成功' : '失败');
    if (result3.success) {
      console.log('文件名:', result3.fileName);
      console.log('文件大小:', result3.fileSize, 'bytes');
    } else {
      console.log('错误:', result3.error);
    }
  } catch (error) {
    console.error('短链接测试失败:', error.message);
  }
}

// 运行测试
testDouyinVideoDownload().catch(console.error);

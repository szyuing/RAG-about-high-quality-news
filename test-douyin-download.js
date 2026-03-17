const { ToolRegistry } = require('./src/source-connectors');

async function testDouyinDownload() {
  console.log('开始测试抖音视频下载功能...\n');
  
  // 测试1: 单个视频下载
  console.log('测试1: 单个视频下载');
  const testVideoUrl = 'https://www.douyin.com/video/7617686082800323840';
  
  try {
    console.log('视频链接:', testVideoUrl);
    console.log('开始下载...\n');
    
    const response = await ToolRegistry.executeTool('download_douyin_video', {
      videoUrl: testVideoUrl,
      outputDir: './downloads'
    });
    
    // executeTool返回的是包装后的结果，需要访问response.data
    const result = response.data || response;
    
    console.log('\n✅ 下载成功!');
    console.log('标题:', result.title);
    console.log('作者:', result.author);
    console.log('文件名:', result.filename);
    console.log('文件大小:', result.fileSize);
    console.log('保存路径:', result.downloadPath);
    console.log('视频地址:', result.videoUrl);
    if (result.coverUrl) {
      console.log('封面地址:', result.coverUrl);
    }
  } catch (error) {
    console.error('\n❌ 下载失败:', error.message);
  }

  // 测试2: 批量下载
  console.log('\n\n测试2: 批量视频下载');
  const videoUrls = [
    'https://www.douyin.com/video/7617686082800323840',
    'https://www.douyin.com/video/1234567890'
  ];
  
  try {
    console.log('视频链接列表:');
    videoUrls.forEach((url, index) => {
      console.log(`${index + 1}. ${url}`);
    });
    console.log('\n开始批量下载...\n');
    
    const response = await ToolRegistry.executeTool('batch_download_douyin_videos', {
      videoUrls: videoUrls,
      outputDir: './downloads',
      concurrency: 1,
      delay: 3000
    });
    
    // executeTool返回的是包装后的结果
    const result = response.data || response;
    
    console.log('\n\n📊 批量下载结果:');
    console.log('总数:', result.total);
    console.log('成功:', result.successful);
    console.log('失败:', result.failed);
    console.log('下载目录:', result.outputDir);
    
    console.log('\n📁 成功下载的文件:');
    if (result.results && Array.isArray(result.results)) {
      result.results.forEach((item, index) => {
        if (item.success && item.data) {
          console.log(`${index + 1}. ${item.data.filename} (${item.data.fileSize})`);
        }
      });
    }
    
    if (result.errors && result.errors.length > 0) {
      console.log('\n❌ 失败的链接:');
      result.errors.forEach((error, index) => {
        console.log(`${index + 1}. ${error.url}`);
        console.log('   错误:', error.error);
      });
    }
  } catch (error) {
    console.error('\n❌ 批量下载失败:', error.message);
  }

  console.log('\n\n所有测试完成！');
}

// 运行测试
testDouyinDownload().catch(console.error);

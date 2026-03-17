const { ToolRegistry } = require('./src/source-connectors');

async function testEnhancedDouyinTools() {
  console.log('开始测试增强版抖音视频信息提取工具...\n');
  
  // 测试1: 单个视频信息提取
  console.log('测试1: 单个视频信息提取');
  const testVideoUrl = 'https://www.douyin.com/video/7617686082800323840';
  
  try {
    const result1 = await ToolRegistry.executeTool('extract_douyin_video_info', {
      videoUrl: testVideoUrl
    });
    
    // executeTool返回的是包装后的结果，需要访问result1.data
    const data = result1.data || result1;
    
    console.log('\n提取结果:');
    console.log('标题:', data.title);
    console.log('视频ID:', data.videoId);
    console.log('分享链接:', data.shareUrl);
    console.log('提取状态:', data.extractionStatus);
    console.log('是否有JS保护:', data.hasJsProtection);
    
    if (data.downloadMethods && data.downloadMethods.length > 0) {
      console.log('\n推荐的下载方法:');
      data.downloadMethods.forEach((method, index) => {
        console.log(`\n${index + 1}. ${method.name}`);
        console.log(`   描述: ${method.description}`);
        console.log(`   难度: ${method.difficulty}`);
        console.log(`   成功率: ${method.successRate}`);
        if (method.steps) {
          console.log('   步骤:');
          method.steps.forEach(step => console.log(`     ${step}`));
        }
        if (method.examples) {
          console.log('   示例:');
          method.examples.forEach(example => console.log(`     - ${example}`));
        }
        if (method.code) {
          console.log('   代码示例:');
          console.log('   ' + method.code.split('\n').join('\n   '));
        }
      });
    }
    
    console.log('\n元数据:');
    console.log('平台:', data.metadata?.platform);
    console.log('链接类型:', data.metadata?.urlType);
    console.log('提取时间:', data.metadata?.extractedAt);
    console.log('工具版本:', data.metadata?.toolVersion);
  } catch (error) {
    console.error('提取失败:', error.message);
  }

  // 测试2: 批量视频信息提取
  console.log('\n\n测试2: 批量视频信息提取');
  const videoUrls = [
    'https://www.douyin.com/video/7617686082800323840',
    'https://www.douyin.com/video/1234567890',
    'https://v.douyin.com/iFRqB6x/'
  ];
  
  try {
    const result2 = await ToolRegistry.executeTool('batch_extract_douyin_video_info', {
      videoUrls: videoUrls,
      concurrency: 2,
      delay: 500
    });
    
    const batchData = result2.data || result2;
    
    console.log('\n批量提取结果:');
    console.log('总数:', batchData.total);
    console.log('成功:', batchData.successful);
    console.log('失败:', batchData.failed);
    
    console.log('\n详细结果:');
    if (batchData.results && Array.isArray(batchData.results)) {
      batchData.results.forEach((item, index) => {
        console.log(`\n视频 ${index + 1}:`);
        console.log('  URL:', item.url);
        console.log('  成功:', item.success);
        if (item.success && item.data) {
          console.log('  视频ID:', item.data.videoId);
          console.log('  提取状态:', item.data.extractionStatus);
        } else {
          console.log('  错误:', item.error);
        }
      });
    }
    
    if (batchData.errors && batchData.errors.length > 0) {
      console.log('\n错误列表:');
      batchData.errors.forEach((error, index) => {
        console.log(`${index + 1}. ${error.url}: ${error.error}`);
      });
    }
  } catch (error) {
    console.error('批量提取失败:', error.message);
  }

  console.log('\n\n所有测试完成！');
}

// 运行测试
testEnhancedDouyinTools().catch(console.error);

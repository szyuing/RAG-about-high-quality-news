const { ToolRegistry } = require('./src/source-connectors');

async function testDebug() {
  console.log('调试测试...\n');
  
  const testVideoUrl = 'https://www.douyin.com/video/7617686082800323840';
  
  try {
    const result = await ToolRegistry.executeTool('extract_douyin_video_info', {
      videoUrl: testVideoUrl
    });
    
    console.log('完整返回结果:');
    console.log(JSON.stringify(result, null, 2));
    
    console.log('\n结果类型:', typeof result);
    console.log('是否有data:', 'data' in result);
    console.log('是否有success:', 'success' in result);
    
    if (result.data) {
      console.log('\ndata内容:');
      console.log(JSON.stringify(result.data, null, 2));
    }
  } catch (error) {
    console.error('错误:', error.message);
    console.error('堆栈:', error.stack);
  }
}

testDebug().catch(console.error);

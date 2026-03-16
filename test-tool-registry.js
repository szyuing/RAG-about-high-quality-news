const { ToolRegistry } = require('./src/source-connectors');

async function testToolRegistry() {
  console.log('=== 工具接口检测 ===\n');
  
  // 1. 检测工具注册情况
  console.log('1. 工具注册情况:');
  const tools = ToolRegistry.getTools();
  console.log(`已注册工具数量: ${tools.length}`);
  tools.forEach((tool, index) => {
    console.log(`${index + 1}. ${tool.name} (${tool.id})`);
    console.log(`   描述: ${tool.description}`);
    console.log(`   参数: ${JSON.stringify(tool.parameters, null, 2)}`);
    console.log('');
  });
  
  // 2. 检测工具能力
  console.log('2. 工具能力检测:');
  const capabilities = ToolRegistry.getToolCapabilities();
  console.log(JSON.stringify(capabilities, null, 2));
  console.log('');
  
  // 3. 测试工具输入验证
  console.log('3. 工具输入验证测试:');
  
  // 测试 deep_read_page
  const deepReadTest = ToolRegistry.testTool('deep_read_page', {
    url: 'https://example.com'
  });
  console.log('deep_read_page 验证:', deepReadTest);
  
  // 测试 extract_video_intel
  const videoTest = ToolRegistry.testTool('extract_video_intel', {
    url: 'https://www.bilibili.com/video/BV1xx411c7mN/'
  });
  console.log('extract_video_intel 验证:', videoTest);
  
  // 测试 cross_check_facts
  const crossCheckTest = ToolRegistry.testTool('cross_check_facts', {
    evidenceItems: []
  });
  console.log('cross_check_facts 验证:', crossCheckTest);
  console.log('');
  
  // 4. 测试工具执行
  console.log('4. 工具执行测试:');
  
  try {
    console.log('测试 deep_read_page 执行:');
    const deepReadResult = await ToolRegistry.executeTool('deep_read_page', {
      url: 'https://example.com'
    });
    console.log('执行结果:', deepReadResult.success ? '成功' : '失败');
    if (deepReadResult.success) {
      console.log('返回数据类型:', typeof deepReadResult.data);
    } else {
      console.log('错误信息:', deepReadResult.error.message);
    }
  } catch (error) {
    console.log('执行出错:', error.message);
  }
  
  console.log('');
  
  // 5. 测试工具不存在的情况
  console.log('5. 边界情况测试:');
  try {
    const nonExistentTool = ToolRegistry.getTool('non_existent_tool');
    console.log('不存在的工具:', nonExistentTool);
  } catch (error) {
    console.log('获取不存在工具的错误:', error.message);
  }
  
  // 6. 测试图文理解工具
  console.log('6. 图文理解工具测试:');
  
  // 测试图像分析
  try {
    console.log('测试 analyze_image 执行:');
    const imageAnalysis = await ToolRegistry.executeTool('analyze_image', {
      imageUrl: 'https://example.com/image.jpg',
      question: 'What is in this image?',
      analysisType: 'description'
    });
    console.log('执行结果:', imageAnalysis.success ? '成功' : '失败');
    if (imageAnalysis.success) {
      console.log('分析结果:', JSON.stringify(imageAnalysis.data, null, 2));
    }
  } catch (error) {
    console.log('图像分析错误:', error.message);
  }
  
  // 测试图像搜索
  try {
    console.log('测试 image_search 执行:');
    const imageSearch = await ToolRegistry.executeTool('image_search', {
      query: 'cat',
      count: 3
    });
    console.log('执行结果:', imageSearch.success ? '成功' : '失败');
    if (imageSearch.success) {
      console.log('搜索结果:', JSON.stringify(imageSearch.data, null, 2));
    }
  } catch (error) {
    console.log('图像搜索错误:', error.message);
  }
  
  console.log('');
  console.log('=== 检测完成 ===');
}

testToolRegistry().catch(console.error);
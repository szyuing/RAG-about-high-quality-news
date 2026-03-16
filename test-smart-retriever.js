const {
  AgentSystem
} = require('./src/agent-orchestrator');

async function testSmartInformationRetrieval() {
  console.log('=== 智能信息检索和筛选测试 ===\n');
  
  const agentSystem = new AgentSystem();
  
  // 1. 测试智能搜索查询生成
  console.log('1. 测试智能搜索查询生成:');
  
  const question = 'Sora model capabilities';
  const queries = agentSystem.generateSearchQueries(question, { maxQueries: 5 });
  console.log('  原始问题:', question);
  console.log('  生成的搜索查询:');
  queries.forEach((query, index) => {
    console.log(`    ${index + 1}. ${query}`);
  });
  console.log('');
  
  // 2. 测试智能搜索执行
  console.log('2. 测试智能搜索执行:');
  
  const searchResults = await agentSystem.executeSmartSearch(question, { maxResults: 5 });
  console.log(`  搜索结果数量: ${searchResults.length}`);
  console.log('  搜索结果（按相关性排序）:');
  searchResults.forEach((result, index) => {
    console.log(`    ${index + 1}. ${result.title}`);
    console.log(`       URL: ${result.url}`);
    console.log(`       相关性得分: ${result.relevanceScore.toFixed(2)}`);
    console.log(`       质量得分: ${result.qualityScore.toFixed(2)}`);
  });
  console.log('');
  
  // 3. 测试搜索结果筛选
  console.log('3. 测试搜索结果筛选:');
  
  // 模拟一些搜索结果
  const mockResults = [
    {
      url: 'https://wikipedia.org/wiki/Sora_(AI)',
      title: 'Sora (AI) - Wikipedia',
      content: 'Sora is an AI model developed by OpenAI that can generate videos from text descriptions.',
      date: '2024-02-01'
    },
    {
      url: 'https://example.com/sora',
      title: 'Sora Model Information',
      content: 'This is a sample website with limited information about Sora.',
      date: '2024-01-01'
    },
    {
      url: 'https://arxiv.org/abs/2402.00001',
      title: 'Sora: A New Video Generation Model',
      content: 'This paper discusses the technical details of the Sora model and its capabilities.',
      date: '2024-02-15'
    }
  ];
  
  const filteredResults = agentSystem.filterSearchResults(mockResults, {
    query: question,
    maxResults: 3
  });
  
  console.log('  筛选后的结果:');
  filteredResults.forEach((result, index) => {
    console.log(`    ${index + 1}. ${result.title}`);
    console.log(`       相关性得分: ${result.relevanceScore.toFixed(2)}`);
    console.log(`       质量得分: ${result.qualityScore.toFixed(2)}`);
  });
  console.log('');
  
  // 4. 测试批量处理搜索结果
  console.log('4. 测试批量处理搜索结果:');
  
  const processedResults = agentSystem.batchProcessResults(mockResults, {
    query: question
  });
  
  console.log('  批量处理后的结果:');
  processedResults.forEach((result, index) => {
    console.log(`    ${index + 1}. ${result.title}`);
    console.log(`       处理时间: ${new Date(result.processedAt).toLocaleString()}`);
  });
  console.log('');
  
  // 5. 测试搜索历史
  console.log('5. 测试搜索历史:');
  
  const searchHistory = agentSystem.getSearchHistory();
  console.log(`  搜索历史记录: ${searchHistory.length} 条`);
  searchHistory.forEach((history, index) => {
    console.log(`    ${index + 1}. ${history.query} (${new Date(history.timestamp).toLocaleString()})`);
    console.log(`       结果数量: ${history.results}`);
  });
  console.log('');
  
  // 6. 测试清理搜索历史
  console.log('6. 测试清理搜索历史:');
  
  console.log(`  清理前搜索历史数量: ${agentSystem.getSearchHistory().length}`);
  agentSystem.clearSearchHistory();
  console.log(`  清理后搜索历史数量: ${agentSystem.getSearchHistory().length}`);
  console.log('');
  
  // 7. 测试不同问题的搜索查询生成
  console.log('7. 测试不同问题的搜索查询生成:');
  
  const testQuestions = [
    'What is the latest version of Sora?',
    'How does Sora generate videos?',
    'What are the limitations of Sora?'
  ];
  
  testQuestions.forEach((testQuestion, index) => {
    console.log(`  问题 ${index + 1}: ${testQuestion}`);
    const testQueries = agentSystem.generateSearchQueries(testQuestion, { maxQueries: 3 });
    testQueries.forEach((query, qIndex) => {
      console.log(`    查询 ${qIndex + 1}: ${query}`);
    });
    console.log('');
  });
  
  console.log('=== 智能信息检索和筛选测试完成 ===');
}

testSmartInformationRetrieval().catch(console.error);
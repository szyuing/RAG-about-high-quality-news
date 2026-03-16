const {
  AgentSystem,
  AgentType
} = require('./src/agent-orchestrator');

async function testDynamicAgentOrchestration() {
  console.log('=== 动态Agent组建和任务分配测试 ===\n');
  
  const agentSystem = new AgentSystem();
  
  // 1. 测试动态创建Agent
  console.log('1. 测试动态创建Agent:');
  
  const newWebResearcher = agentSystem.createAgent(AgentType.WEB_RESEARCHER, {
    name: 'Dynamic Web Researcher'
  });
  console.log('  创建新的Web Researcher Agent:', newWebResearcher.id);
  
  const newDeepAnalyst = agentSystem.createAgent(AgentType.DEEP_ANALYST, {
    name: 'Dynamic Deep Analyst'
  });
  console.log('  创建新的Deep Analyst Agent:', newDeepAnalyst.id);
  
  // 查看当前Agent状态
  const agentStatus = agentSystem.getAgentStatus();
  console.log('  当前Agent状态:', agentStatus.length, '个Agent');
  agentStatus.forEach(agent => {
    console.log(`    - ${agent.type}: ${agent.id} (能力: ${agent.capability.toFixed(2)}, 负载: ${agent.load})`);
  });
  console.log('');
  
  // 2. 测试任务分配
  console.log('2. 测试任务分配:');
  
  // 分配搜索任务
  const searchTask = agentSystem.assignTask(
    'web_search',
    'Search for information about Sora model capabilities',
    'high',
    { query: 'Sora model OpenAI capabilities' }
  );
  console.log('  分配搜索任务:', searchTask.success ? '成功' : '失败');
  if (searchTask.success) {
    console.log(`    任务ID: ${searchTask.task.id}`);
    console.log(`    分配给: ${searchTask.agentId} (${searchTask.agentType})`);
  }
  
  // 分配分析任务
  const analysisTask = agentSystem.assignTask(
    'analysis',
    'Analyze the search results about Sora model',
    'medium',
    { taskId: searchTask.task.id }
  );
  console.log('  分配分析任务:', analysisTask.success ? '成功' : '失败');
  if (analysisTask.success) {
    console.log(`    任务ID: ${analysisTask.task.id}`);
    console.log(`    分配给: ${analysisTask.agentId} (${analysisTask.agentType})`);
  }
  
  // 分配多媒体任务
  const multimediaTask = agentSystem.assignTask(
    'multimedia',
    'Analyze images related to Sora model',
    'medium',
    { imageCount: 5 }
  );
  console.log('  分配多媒体任务:', multimediaTask.success ? '成功' : '失败');
  if (multimediaTask.success) {
    console.log(`    任务ID: ${multimediaTask.task.id}`);
    console.log(`    分配给: ${multimediaTask.agentId} (${multimediaTask.agentType})`);
  }
  console.log('');
  
  // 3. 测试任务完成
  console.log('3. 测试任务完成:');
  
  if (searchTask.success) {
    const completeResult = agentSystem.completeTask(
      searchTask.agentId,
      searchTask.task.id,
      { results: 10, quality: 'high' }
    );
    console.log('  完成搜索任务:', completeResult ? '成功' : '失败');
  }
  
  if (analysisTask.success) {
    const completeResult = agentSystem.completeTask(
      analysisTask.agentId,
      analysisTask.task.id,
      { insights: 5, confidence: 0.85 }
    );
    console.log('  完成分析任务:', completeResult ? '成功' : '失败');
  }
  console.log('');
  
  // 4. 测试动态调整Agent池
  console.log('4. 测试动态调整Agent池:');
  
  console.log('  调整前Agent状态:');
  const beforeAdjustment = agentSystem.getAgentStatus();
  beforeAdjustment.forEach(agent => {
    console.log(`    - ${agent.type}: ${agent.id} (负载: ${agent.load})`);
  });
  
  // 分配更多任务以增加负载
  for (let i = 0; i < 5; i++) {
    agentSystem.assignTask(
      'web_search',
      `Search task ${i+1}`,
      'medium',
      { query: `Test query ${i+1}` }
    );
  }
  
  console.log('  分配5个搜索任务后调整Agent池...');
  agentSystem.adjustAgentPool();
  
  console.log('  调整后Agent状态:');
  const afterAdjustment = agentSystem.getAgentStatus();
  afterAdjustment.forEach(agent => {
    console.log(`    - ${agent.type}: ${agent.id} (负载: ${agent.load})`);
  });
  console.log('');
  
  // 5. 测试销毁Agent
  console.log('5. 测试销毁Agent:');
  
  if (newWebResearcher) {
    const destroyResult = agentSystem.destroyAgent(newWebResearcher.id);
    console.log(`  销毁Web Researcher Agent (${newWebResearcher.id}):`, destroyResult ? '成功' : '失败');
  }
  
  if (newDeepAnalyst) {
    const destroyResult = agentSystem.destroyAgent(newDeepAnalyst.id);
    console.log(`  销毁Deep Analyst Agent (${newDeepAnalyst.id}):`, destroyResult ? '成功' : '失败');
  }
  
  console.log('  销毁后Agent数量:', agentSystem.getAgentStatus().length);
  console.log('');
  
  // 6. 测试任务历史
  console.log('6. 测试任务历史:');
  console.log('  任务历史数量:', agentSystem.taskHistory.length);
  agentSystem.taskHistory.forEach(task => {
    console.log(`    - ${task.type}: ${task.content} (状态: ${task.status})`);
  });
  console.log('');
  
  // 7. 测试动态Agent组建场景
  console.log('7. 测试动态Agent组建场景:');
  console.log('  场景: 系统根据任务需求自动创建Agent');
  
  // 分配一个需要特殊Agent的任务
  const specialTask = agentSystem.assignTask(
    'multimedia',
    'Analyze video content related to Sora model',
    'high',
    { videoCount: 3 }
  );
  
  console.log('  分配多媒体任务:', specialTask.success ? '成功' : '失败');
  if (specialTask.success) {
    console.log(`    任务ID: ${specialTask.task.id}`);
    console.log(`    分配给: ${specialTask.agentId} (${specialTask.agentType})`);
  }
  
  // 查看最终Agent状态
  const finalStatus = agentSystem.getAgentStatus();
  console.log('  最终Agent状态:', finalStatus.length, '个Agent');
  finalStatus.forEach(agent => {
    console.log(`    - ${agent.type}: ${agent.id}`);
  });
  console.log('');
  
  console.log('=== 动态Agent组建和任务分配测试完成 ===');
}

testDynamicAgentOrchestration().catch(console.error);
const {
  AgentSystem,
  AgentType
} = require('./src/agent-orchestrator');

async function testAgentCommunication() {
  console.log('=== 基于角色的Agent通信机制测试 ===\n');
  
  const agentSystem = new AgentSystem();
  
  // 1. 测试消息发送
  console.log('1. 测试消息发送:');
  
  // 发送请求消息
  const requestMessage = agentSystem.sendRequest(
    AgentType.LLM_ORCHESTRATOR,
    AgentType.WEB_RESEARCHER,
    'Please search for information about Sora model',
    { query: 'Sora model OpenAI', priority: 'high' }
  );
  console.log('  发送请求消息:', requestMessage.id, requestMessage.type);
  
  // 发送响应消息
  const responseMessage = agentSystem.sendResponse(
    AgentType.WEB_RESEARCHER,
    AgentType.LLM_ORCHESTRATOR,
    'Found information about Sora model',
    { results: 5, status: 'completed' }
  );
  console.log('  发送响应消息:', responseMessage.id, responseMessage.type);
  
  // 发送通知消息
  const notificationMessage = agentSystem.sendNotification(
    AgentType.LLM_ORCHESTRATOR,
    AgentType.LONG_TEXT_COLLECTOR,
    'Please analyze the search results',
    { taskId: 'task_123' }
  );
  console.log('  发送通知消息:', notificationMessage.id, notificationMessage.type);
  
  // 发送错误消息
  const errorMessage = agentSystem.sendError(
    AgentType.WEB_RESEARCHER,
    AgentType.LLM_ORCHESTRATOR,
    'Search failed',
    { error: 'Network error', retry: true }
  );
  console.log('  发送错误消息:', errorMessage.id, errorMessage.type);
  console.log('');
  
  // 2. 测试消息订阅
  console.log('2. 测试消息订阅:');
  
  // 订阅Web Researcher角色的消息
  const webResearcherCallback = (message) => {
    console.log('  Web Researcher收到消息:', message.type, '-', message.content);
  };
  
  agentSystem.subscribe(AgentType.WEB_RESEARCHER, webResearcherCallback);
  console.log('  已订阅Web Researcher角色的消息');
  
  // 再次发送消息给Web Researcher
  const testMessage = agentSystem.sendRequest(
    AgentType.LLM_ORCHESTRATOR,
    AgentType.WEB_RESEARCHER,
    'Test message for subscription',
    { test: true }
  );
  console.log('');
  
  // 3. 测试消息历史和统计
  console.log('3. 测试消息历史和统计:');
  
  const messageHistory = agentSystem.getMessageHistory();
  console.log('  消息历史数量:', messageHistory.length);
  
  const messageStats = agentSystem.getMessageStats();
  console.log('  消息统计:', JSON.stringify(messageStats, null, 2));
  console.log('');
  
  // 4. 测试多Agent通信场景
  console.log('4. 测试多Agent通信场景:');
  
  // 模拟一个完整的通信流程
  console.log('  场景: LLM-Orchestrator协调多个Agent完成任务');
  
  // LLM-Orchestrator发送任务给Web Researcher
  const taskMessage = agentSystem.sendRequest(
    AgentType.LLM_ORCHESTRATOR,
    AgentType.WEB_RESEARCHER,
    'Research Sora model capabilities',
    { deadline: Date.now() + 60000 }
  );
  console.log('  LLM-Orchestrator -> Web Researcher:', taskMessage.content);
  
  // Web Researcher完成任务并响应
  const completionMessage = agentSystem.sendResponse(
    AgentType.WEB_RESEARCHER,
    AgentType.LLM_ORCHESTRATOR,
    'Research completed, found 10 sources',
    { sources: 10, quality: 'high' }
  );
  console.log('  Web Researcher -> LLM-Orchestrator:', completionMessage.content);
  
  // LLM-Orchestrator通知Long Text Collector分析结果
  const analysisMessage = agentSystem.sendNotification(
    AgentType.LLM_ORCHESTRATOR,
    AgentType.LONG_TEXT_COLLECTOR,
    'Analyze the research results',
    { taskId: taskMessage.id }
  );
  console.log('  LLM-Orchestrator -> Long Text Collector:', analysisMessage.content);
  
  // Long Text Collector完成分析并响应
  const analysisResponse = agentSystem.sendResponse(
    AgentType.LONG_TEXT_COLLECTOR,
    AgentType.LLM_ORCHESTRATOR,
    'Analysis completed, found key insights',
    { insights: 5, confidence: 0.85 }
  );
  console.log('  Long Text Collector -> LLM-Orchestrator:', analysisResponse.content);
  
  // LLM-Orchestrator汇总最终报告
  const synthesisMessage = agentSystem.sendNotification(
    AgentType.LLM_ORCHESTRATOR,
    AgentType.LLM_ORCHESTRATOR,
    'Generate final report',
    { insights: analysisResponse.metadata.insights }
  );
  console.log('  LLM-Orchestrator -> LLM-Orchestrator:', synthesisMessage.content);
  console.log('');
  
  // 5. 测试取消订阅
  console.log('5. 测试取消订阅:');
  agentSystem.unsubscribe(AgentType.WEB_RESEARCHER, webResearcherCallback);
  console.log('  已取消Web Researcher角色的订阅');
  
  // 发送消息测试取消订阅是否生效
  const postUnsubscribeMessage = agentSystem.sendRequest(
    AgentType.LLM_ORCHESTRATOR,
    AgentType.WEB_RESEARCHER,
    'Message after unsubscribe',
    { test: true }
  );
  console.log('  发送消息后不会触发回调');
  console.log('');
  
  // 6. 测试清理消息历史
  console.log('6. 测试清理消息历史:');
  console.log('  清理前消息数量:', agentSystem.getMessageHistory().length);
  agentSystem.clearMessageHistory();
  console.log('  清理后消息数量:', agentSystem.getMessageHistory().length);
  console.log('');
  
  console.log('=== 基于角色的Agent通信机制测试完成 ===');
}

testAgentCommunication().catch(console.error);

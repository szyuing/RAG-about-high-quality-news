const { AgentSystem, AgentType } = require('./src/agent-orchestrator');

async function testAgentCommunicationLatency() {
  console.log('=== Agent 通信延迟测试 ===');
  
  const agentSystem = new AgentSystem();
  
  // 测试 1: 直接调用延迟
  console.log('\n测试 1: 直接调用延迟');
  const toolCreator = agentSystem.getAgent(AgentType.TOOL_CREATOR);
  
  const start1 = Date.now();
  const result1 = await toolCreator.execute({
    toolSpecs: [{
      name: 'Test Tool 1',
      description: '测试工具'
    }]
  });
  const end1 = Date.now();
  console.log(`直接调用延迟: ${end1 - start1}ms`);
  
  // 测试 2: 池调用延迟
  console.log('\n测试 2: 池调用延迟');
  const pool = agentSystem.getToolCreatorPool();
  
  const start2 = Date.now();
  const result2 = await pool.execute([{
    name: 'Test Tool 2',
    description: '测试工具'
  }]);
  const end2 = Date.now();
  console.log(`池调用延迟: ${end2 - start2}ms`);
  
  // 测试 3: 串行请求延迟
  console.log('\n测试 3: 串行请求延迟');
  const start3 = Date.now();
  
  await pool.execute([{ name: 'Tool A', description: 'A' }]);
  await pool.execute([{ name: 'Tool B', description: 'B' }]);
  await pool.execute([{ name: 'Tool C', description: 'C' }]);
  
  const end3 = Date.now();
  console.log(`串行请求延迟 (3个请求): ${end3 - start3}ms`);
  console.log(`平均每个请求: ${(end3 - start3) / 3}ms`);
  
  // 测试 4: 消息传递延迟
  console.log('\n测试 4: 消息传递延迟');
  const start4 = Date.now();
  agentSystem.sendMessage(
    'test_sender',
    AgentType.TOOL_CREATOR,
    'test_message',
    { content: 'test' }
  );
  const end4 = Date.now();
  console.log(`消息传递延迟: ${end4 - start4}ms`);
  
  // 测试 5: 状态传递延迟
  console.log('\n测试 5: 状态传递延迟');
  const state = { question: '测试问题', data: [1, 2, 3, 4, 5] };
  const start5 = Date.now();
  const newState = { ...state, processed: true };
  const end5 = Date.now();
  console.log(`状态传递延迟: ${end5 - start5}ms`);
  
  // 测试 6: 队列处理延迟
  console.log('\n测试 6: 队列处理延迟');
  const start6 = Date.now();
  
  // 串行发送多个请求
  for (let i = 0; i < 5; i++) {
    await pool.execute([{
      name: `Queue Tool ${i}`,
      description: `队列测试工具 ${i}`
    }]);
  }
  
  const end6 = Date.now();
  console.log(`队列处理延迟 (5个请求): ${end6 - start6}ms`);
  console.log(`平均每个请求: ${(end6 - start6) / 5}ms`);
  
  console.log('\n=== 延迟测试完成 ===');
}

testAgentCommunicationLatency().catch(console.error);
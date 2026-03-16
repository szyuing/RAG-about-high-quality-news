const {
  AgentSystem,
  AgentType
} = require('./src/agent-orchestrator');

async function testStatePersistence() {
  console.log('=== 状态持久化功能测试 ===\n');
  
  const agentSystem = new AgentSystem();
  
  // 1. 测试保存和加载系统状态
  console.log('1. 测试保存和加载系统状态:');
  const saveResult = await agentSystem.saveSystemState();
  console.log('  保存系统状态:', saveResult);
  
  const loadedState = await agentSystem.loadSystemState();
  console.log('  加载系统状态:', loadedState ? '成功' : '失败');
  if (loadedState) {
    console.log('  加载的状态包含', loadedState.agents.length, '个Agent');
  }
  console.log('');
  
  // 2. 测试保存和加载会话状态
  console.log('2. 测试保存和加载会话状态:');
  const sessionId = 'test_session_123';
  const sessionData = {
    question: 'Sora 模型现在的生成时长上限是多少？',
    context: {},
    timestamp: Date.now()
  };
  
  const saveSessionResult = await agentSystem.saveSession(sessionId, sessionData);
  console.log('  保存会话状态:', saveSessionResult);
  
  const loadedSession = await agentSystem.loadSession(sessionId);
  console.log('  加载会话状态:', loadedSession ? '成功' : '失败');
  if (loadedSession) {
    console.log('  加载的会话问题:', loadedSession.question);
  }
  console.log('');
  
  // 3. 测试保存和加载Agent状态
  console.log('3. 测试保存和加载Agent状态:');
  const agentId = AgentType.SUPERVISOR;
  const additionalState = {
    lastTask: 'Planning research workflow',
    performance: 'good'
  };
  
  const saveAgentResult = await agentSystem.saveAgentState(agentId, additionalState);
  console.log('  保存Agent状态:', saveAgentResult);
  
  const loadedAgentState = await agentSystem.loadAgentState(agentId);
  console.log('  加载Agent状态:', loadedAgentState ? '成功' : '失败');
  if (loadedAgentState) {
    console.log('  加载的Agent类型:', loadedAgentState.type);
    console.log('  加载的Agent状态:', loadedAgentState.status);
    console.log('  附加状态:', loadedAgentState.lastTask);
  }
  console.log('');
  
  // 4. 测试列出所有保存的状态
  console.log('4. 测试列出所有保存的状态:');
  const states = agentSystem.listSavedStates();
  console.log('  列出保存的状态:', states);
  console.log('');
  
  // 5. 测试跨会话上下文保持
  console.log('5. 测试跨会话上下文保持:');
  
  // 模拟第一个会话
  const session1Id = 'session_1';
  const session1Data = {
    conversation: [
      { role: 'user', content: 'What is Sora model?' },
      { role: 'assistant', content: 'Sora is an AI model by OpenAI.' }
    ],
    context: {
      topic: 'AI models',
      lastQuestion: 'What is Sora model?'
    }
  };
  
  await agentSystem.saveSession(session1Id, session1Data);
  console.log('  会话1保存完成');
  
  // 模拟第二个会话，加载第一个会话的上下文
  const loadedSession1 = await agentSystem.loadSession(session1Id);
  if (loadedSession1) {
    console.log('  从会话1加载的上下文:', loadedSession1.context);
    
    // 继续对话
    const session2Id = 'session_2';
    const session2Data = {
      conversation: [
        ...loadedSession1.conversation,
        { role: 'user', content: 'What can it do?' },
        { role: 'assistant', content: 'Sora can generate videos from text descriptions.' }
      ],
      context: {
        ...loadedSession1.context,
        lastQuestion: 'What can it do?',
        followUp: true
      }
    };
    
    await agentSystem.saveSession(session2Id, session2Data);
    console.log('  会话2保存完成，包含上下文延续');
  }
  console.log('');
  
  console.log('=== 状态持久化功能测试完成 ===');
}

testStatePersistence().catch(console.error);
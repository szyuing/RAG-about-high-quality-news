const {
  AgentSystem,
  createAgent,
  AgentType,
  AgentStatus,
  SupervisorAgent,
  WebResearcherAgent,
  DeepAnalystAgent,
  MultimediaAgent,
  FactVerifierAgent,
  SynthesizerAgent
} = require('./src/agent-orchestrator');

async function testAgentSystem() {
  console.log('=== 多 Agent 编排系统测试 ===\n');
  
  // 1. 测试 Agent 类型枚举
  console.log('1. Agent 类型枚举:');
  console.log('  SUPERVISOR:', AgentType.SUPERVISOR);
  console.log('  WEB_RESEARCHER:', AgentType.WEB_RESEARCHER);
  console.log('  DEEP_ANALYST:', AgentType.DEEP_ANALYST);
  console.log('  MULTIMEDIA:', AgentType.MULTIMEDIA);
  console.log('  FACT_VERIFIER:', AgentType.FACT_VERIFIER);
  console.log('  SYNTHESIZER:', AgentType.SYNTHESIZER);
  console.log('');
  
  // 2. 测试 Agent 状态枚举
  console.log('2. Agent 状态枚举:');
  console.log('  IDLE:', AgentStatus.IDLE);
  console.log('  RUNNING:', AgentStatus.RUNNING);
  console.log('  COMPLETED:', AgentStatus.COMPLETED);
  console.log('  FAILED:', AgentStatus.FAILED);
  console.log('  WAITING:', AgentStatus.WAITING);
  console.log('');
  
  // 3. 测试 AgentSystem 初始化
  console.log('3. AgentSystem 初始化:');
  const agentSystem = new AgentSystem();
  const status = agentSystem.getSystemStatus();
  console.log('  初始化状态:', status);
  console.log('');
  
  // 4. 测试获取所有 Agent
  console.log('4. 获取所有 Agent:');
  const agents = agentSystem.getAllAgents();
  agents.forEach((agent, index) => {
    console.log(`  ${index + 1}. ${agent.name} (${agent.type}) - ${agent.status}`);
  });
  console.log('');
  
  // 5. 测试 Supervisor Agent 任务规划
  console.log('5. Supervisor Agent 任务规划:');
  const supervisor = agentSystem.getAgent(AgentType.SUPERVISOR);
  const plan = await supervisor.planTask('Sora 模型现在的生成时长上限是多少？', {});
  console.log('  规划结果:');
  console.log('    任务目标:', plan.task_goal);
  console.log('    子问题:', plan.sub_questions);
  console.log('    源策略:', plan.source_strategy);
  console.log('    需要的 Agent:', plan.agents_needed);
  console.log('');
  
  // 6. 测试 Agent 创建工厂函数
  console.log('6. 测试 Agent 创建工厂函数:');
  const webResearcher = createAgent(AgentType.WEB_RESEARCHER);
  console.log('  创建的 Agent:', webResearcher.name, webResearcher.type, webResearcher.status);
  console.log('');
  
  // 7. 测试各个 Agent 类
  console.log('7. 测试各个 Agent 类:');
  
  // Supervisor Agent
  const sup = new SupervisorAgent({ id: 'test-supervisor', name: 'Test Supervisor' });
  console.log('  Supervisor Agent:', sup.id, sup.name, sup.type);
  
  // Web Researcher Agent
  const web = new WebResearcherAgent({ id: 'test-web', name: 'Test Web Researcher' });
  console.log('  Web Researcher Agent:', web.id, web.name, web.type);
  
  // Deep Analyst Agent
  const deep = new DeepAnalystAgent({ id: 'test-deep', name: 'Test Deep Analyst' });
  console.log('  Deep Analyst Agent:', deep.id, deep.name, deep.type);
  
  // Multimedia Agent
  const multimedia = new MultimediaAgent({ id: 'test-multimedia', name: 'Test Multimedia' });
  console.log('  Multimedia Agent:', multimedia.id, multimedia.name, multimedia.type);
  
  // Fact Verifier Agent
  const verifier = new FactVerifierAgent({ id: 'test-verifier', name: 'Test Fact Verifier' });
  console.log('  Fact Verifier Agent:', verifier.id, verifier.name, verifier.type);
  
  // Synthesizer Agent
  const synth = new SynthesizerAgent({ id: 'test-synth', name: 'Test Synthesizer' });
  console.log('  Synthesizer Agent:', synth.id, synth.name, synth.type);
  console.log('');
  
  // 8. 测试工作流执行
  console.log('8. 测试工作流执行（模拟）:');
  const workflow = [
    {
      agentType: AgentType.SUPERVISOR,
      input: { question: '测试问题' }
    },
    {
      agentType: AgentType.WEB_RESEARCHER,
      input: { query: '测试查询', connectorIds: ['bing_web'] }
    }
  ];
  
  console.log('  工作流步骤:');
  workflow.forEach((step, index) => {
    console.log(`    ${index + 1}. ${step.agentType}`);
  });
  console.log('');
  
  console.log('=== 测试完成 ===');
}

testAgentSystem().catch(console.error);
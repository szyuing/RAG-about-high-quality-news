const {
  AgentSystem,
  StateGraph,
  createResearchWorkflow
} = require('./src/agent-orchestrator');

async function testWorkflowEngine() {
  console.log('=== 工作流引擎测试 ===\n');
  
  // 1. 测试 StateGraph 基础功能
  console.log('1. 测试 StateGraph 基础功能:');
  const simpleWorkflow = new StateGraph();
  
  let counter = 0;
  
  simpleWorkflow.addNode('start', async (state) => {
    console.log('  执行 start 节点');
    return { ...state, count: 1 };
  });
  
  simpleWorkflow.addNode('process', async (state) => {
    console.log('  执行 process 节点');
    return { ...state, count: state.count * 2 };
  });
  
  simpleWorkflow.addNode('end', async (state) => {
    console.log('  执行 end 节点');
    return { ...state, completed: true };
  });
  
  simpleWorkflow.addEdge('start', 'process');
  simpleWorkflow.addEdge('process', 'end');
  simpleWorkflow.setStartNode('start');
  
  const simpleResult = await simpleWorkflow.run({ initial: 'value' });
  console.log('  简单工作流结果:', simpleResult);
  console.log('');
  
  // 2. 测试条件分支
  console.log('2. 测试条件分支:');
  const conditionalWorkflow = new StateGraph();
  
  conditionalWorkflow.addNode('check', async (state) => {
    console.log('  执行 check 节点');
    return { ...state, value: Math.random() > 0.5 };
  });
  
  conditionalWorkflow.addNode('success', async (state) => {
    console.log('  执行 success 节点');
    return { ...state, result: 'success' };
  });
  
  conditionalWorkflow.addNode('failure', async (state) => {
    console.log('  执行 failure 节点');
    return { ...state, result: 'failure' };
  });
  
  conditionalWorkflow.addEdge('check', 'success', (state) => state.value);
  conditionalWorkflow.addEdge('check', 'failure', (state) => !state.value);
  conditionalWorkflow.setStartNode('check');
  
  const conditionalResult = await conditionalWorkflow.run({});
  console.log('  条件工作流结果:', conditionalResult);
  console.log('');
  
  // 3. 测试研究工作流
  console.log('3. 测试研究工作流:');
  const agentSystem = new AgentSystem();
  
  try {
    const workflowResult = await agentSystem.executeWorkflow('research', {
      question: 'Sora 模型现在的生成时长上限是多少？',
      context: {}
    });
    
    console.log('  研究工作流执行完成!');
    console.log('  工作流状态:', Object.keys(workflowResult));
    
    if (workflowResult.synthesisResult) {
      console.log('  综合结果:', workflowResult.synthesisResult.result?.headline);
    }
  } catch (error) {
    console.log('  工作流执行出错:', error.message);
  }
  console.log('');
  
  // 4. 测试工作流注册
  console.log('4. 测试工作流注册:');
  const customWorkflow = new StateGraph();
  customWorkflow.addNode('custom', async (state) => {
    return { ...state, custom: 'value' };
  });
  customWorkflow.setStartNode('custom');
  
  agentSystem.registerWorkflow('custom', customWorkflow);
  console.log('  工作流列表:', agentSystem.getSystemStatus().workflows);
  
  const customResult = await agentSystem.executeWorkflow('custom', { test: 'data' });
  console.log('  自定义工作流结果:', customResult);
  console.log('');
  
  // 5. 测试系统状态
  console.log('5. 测试系统状态:');
  const status = agentSystem.getSystemStatus();
  console.log('  系统状态:', status);
  console.log('');
  
  console.log('=== 工作流引擎测试完成 ===');
}

testWorkflowEngine().catch(console.error);
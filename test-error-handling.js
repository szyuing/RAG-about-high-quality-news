const {
  AgentSystem,
  StateGraph,
  AgentType
} = require('./src/agent-orchestrator');

async function testErrorHandling() {
  console.log('=== 错误处理和故障恢复测试 ===\n');
  
  // 1. 测试Agent执行失败和重试机制
  console.log('1. 测试Agent执行失败和重试机制:');
  const agentSystem = new AgentSystem();
  
  // 创建一个会失败的测试Agent
  class FailingAgent {
    constructor() {
      this.id = 'failing-agent';
      this.name = 'Failing Agent';
      this.type = 'test';
      this.status = 'idle';
      this.error = null;
      this.retryCount = 0;
    }

    async execute(input) {
      this.status = 'running';
      this.retryCount++;
      
      console.log(`FailingAgent executing (attempt ${this.retryCount})...`);
      
      if (this.retryCount < 2) {
        throw new Error('Simulated failure');
      }
      
      this.status = 'completed';
      return {
        agentId: this.id,
        status: 'completed',
        result: { success: true, data: 'Recovered after retry' }
      };
    }

    reset() {
      this.status = 'idle';
      this.retryCount = 0;
      this.error = null;
    }
  }
  
  // 注册测试Agent
  const failingAgent = new FailingAgent();
  agentSystem.agents.set('failing-agent', failingAgent);
  
  try {
    const result = await failingAgent.execute({ test: 'data' });
    console.log('  执行结果:', result);
  } catch (error) {
    console.log('  执行错误:', error.message);
  }
  console.log('');
  
  // 2. 测试工作流故障恢复
  console.log('2. 测试工作流故障恢复:');
  const testWorkflow = new StateGraph();
  
  // 添加一个会失败的节点
  testWorkflow.addNode('failing', async (state) => {
    console.log('  执行failing节点...');
    throw new Error('Node failure');
  });
  
  testWorkflow.addNode('success', async (state) => {
    console.log('  执行success节点...');
    return { ...state, recovered: true };
  });
  
  // 设置故障恢复策略
  testWorkflow.setRecoveryStrategy(async (node, error, state) => {
    console.log(`  故障恢复策略: 节点 ${node} 失败，错误: ${error.message}`);
    return {
      success: true,
      state: { ...state, recoveredFrom: node }
    };
  });
  
  testWorkflow.addEdge('failing', 'success');
  testWorkflow.setStartNode('failing');
  
  try {
    const workflowResult = await testWorkflow.run({ initial: 'value' });
    console.log('  工作流执行结果:', workflowResult);
  } catch (error) {
    console.log('  工作流执行错误:', error.message);
  }
  console.log('');
  
  // 3. 测试系统健康检查
  console.log('3. 测试系统健康检查:');
  const status = agentSystem.getSystemStatus();
  console.log('  系统状态:', JSON.stringify(status, null, 2));
  console.log('');
  
  // 4. 测试Agent状态监控
  console.log('4. 测试Agent状态监控:');
  const monitorReport = agentSystem.monitorAgentStatus();
  console.log('  监控报告:', JSON.stringify(monitorReport, null, 2));
  console.log('');
  
  // 5. 测试故障恢复功能
  console.log('5. 测试故障恢复功能:');
  const recoveryResult = await agentSystem.recoverFromFailure('failing-agent', new Error('Test error'));
  console.log('  故障恢复结果:', recoveryResult);
  
  // 恢复后的状态
  const afterRecovery = agentSystem.getSystemStatus();
  console.log('  恢复后系统状态:', afterRecovery.systemHealth);
  console.log('');
  
  console.log('=== 错误处理和故障恢复测试完成 ===');
}

testErrorHandling().catch(console.error);
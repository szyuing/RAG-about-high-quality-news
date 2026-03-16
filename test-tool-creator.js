const { AgentSystem, AgentType } = require('./src/agent-orchestrator');

async function testToolCreator() {
  console.log('=== 测试 Tool Creator Agent ===');
  
  // 创建Agent系统
  const agentSystem = new AgentSystem();
  
  // 获取Tool Creator Agent
  const toolCreator = agentSystem.getAgent(AgentType.TOOL_CREATOR);
  
  if (!toolCreator) {
    console.error('Tool Creator Agent 未找到');
    return;
  }
  
  console.log('✓ Tool Creator Agent 初始化成功');
  
  // 定义工具规范
  const toolSpecs = [
    {
      name: 'Calculator Tool',
      description: '执行数学计算',
      parameters: [
        {
          name: 'operation',
          type: 'string',
          required: true,
          description: '操作类型: add, subtract, multiply, divide'
        },
        {
          name: 'num1',
          type: 'number',
          required: true,
          description: '第一个数字'
        },
        {
          name: 'num2',
          type: 'number',
          required: true,
          description: '第二个数字'
        }
      ],
      implementation: async function(input) {
        const { operation, num1, num2 } = input;
        let result;
        
        switch (operation) {
          case 'add':
            result = num1 + num2;
            break;
          case 'subtract':
            result = num1 - num2;
            break;
          case 'multiply':
            result = num1 * num2;
            break;
          case 'divide':
            if (num2 === 0) {
              throw new Error('除数不能为零');
            }
            result = num1 / num2;
            break;
          default:
            throw new Error('不支持的操作');
        }
        
        return {
          result,
          operation,
          num1,
          num2
        };
      }
    },
    {
      name: 'Greeting Tool',
      description: '生成问候语',
      parameters: [
        {
          name: 'name',
          type: 'string',
          required: true,
          description: '要问候的人的名字'
        },
        {
          name: 'language',
          type: 'string',
          required: false,
          description: '语言: en, zh, es',
          default: 'en'
        }
      ]
    }
  ];
  
  // 执行Tool Creator Agent
  console.log('\n创建工具...');
  const result = await toolCreator.execute({ toolSpecs });
  
  if (result.status === 'completed') {
    console.log('✓ 工具创建成功');
    console.log(`创建了 ${result.result.count} 个工具`);
    
    // 显示创建的工具
    for (const tool of result.result.tools) {
      console.log(`\n- 工具: ${tool.name}`);
      console.log(`  ID: ${tool.id}`);
      console.log(`  描述: ${tool.description}`);
      console.log(`  参数: ${JSON.stringify(tool.parameters)}`);
    }
    
    // 测试生成的工具
    console.log('\n=== 测试生成的工具 ===');
    
    // 测试计算器工具
    const calculatorTool = result.result.tools.find(t => t.name === 'Calculator Tool');
    if (calculatorTool) {
      console.log('\n测试计算器工具:');
      try {
        const calcResult = await calculatorTool.execute({ operation: 'add', num1: 5, num2: 3 });
        console.log(`  5 + 3 = ${calcResult.result}`);
      } catch (error) {
        console.error('  错误:', error.message);
      }
    }
    
    // 测试问候工具
    const greetingTool = result.result.tools.find(t => t.name === 'Greeting Tool');
    if (greetingTool) {
      console.log('\n测试问候工具:');
      try {
        const greetResult = await greetingTool.execute({ name: 'Alice' });
        console.log(`  ${greetResult.result}`);
      } catch (error) {
        console.error('  错误:', error.message);
      }
    }
    
  } else {
    console.error('工具创建失败:', result.error?.message);
  }
  
  console.log('\n=== 测试完成 ===');
}

// 运行测试
testToolCreator().catch(console.error);
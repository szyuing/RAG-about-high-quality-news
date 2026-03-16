const { AgentSystem, AgentType } = require('./src/agent-orchestrator');

async function testMultiToolCreator() {
  console.log('=== 测试多 Tool Creator Agent 方案 ===');
  
  // 创建 Agent 系统
  const agentSystem = new AgentSystem();
  
  // 获取 Tool Creator 池
  const toolCreatorPool = agentSystem.getToolCreatorPool();
  
  if (!toolCreatorPool) {
    console.error('Tool Creator 池未初始化');
    return;
  }
  
  console.log('✓ Tool Creator 池初始化成功');
  console.log('池状态:', toolCreatorPool.getStatus());
  
  // 定义多个工具规范
  const toolSpecs1 = [
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
    }
  ];
  
  const toolSpecs2 = [
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
  
  const toolSpecs3 = [
    {
      name: 'Data Analyzer Tool',
      description: '分析数据',
      parameters: [
        {
          name: 'data',
          type: 'array',
          required: true,
          description: '要分析的数据'
        },
        {
          name: 'operation',
          type: 'string',
          required: true,
          description: '分析操作: sum, average, max, min'
        }
      ],
      implementation: async function(input) {
        const { data, operation } = input;
        let result;
        
        switch (operation) {
          case 'sum':
            result = data.reduce((acc, val) => acc + val, 0);
            break;
          case 'average':
            result = data.reduce((acc, val) => acc + val, 0) / data.length;
            break;
          case 'max':
            result = Math.max(...data);
            break;
          case 'min':
            result = Math.min(...data);
            break;
          default:
            throw new Error('不支持的操作');
        }
        
        return {
          result,
          operation,
          data_length: data.length
        };
      }
    }
  ];
  
  // 串行执行工具创建请求
  console.log('\n串行创建工具...');
  try {
    console.log('创建第一个工具...');
    const result1 = await toolCreatorPool.execute(toolSpecs1);
    console.log('第一个工具创建完成');
    
    console.log('创建第二个工具...');
    const result2 = await toolCreatorPool.execute(toolSpecs2);
    console.log('第二个工具创建完成');
    
    console.log('创建第三个工具...');
    const result3 = await toolCreatorPool.execute(toolSpecs3);
    console.log('第三个工具创建完成');
    
    // 检查结果
    console.log('\n=== 工具创建结果 ===');
    
    if (result1.status === 'completed') {
      console.log('✓ 第一个请求成功');
      console.log(`  创建了 ${result1.result.count} 个工具`);
      result1.result.tools.forEach(tool => {
        console.log(`  - ${tool.name} (ID: ${tool.id})`);
      });
    } else {
      console.error('第一个请求失败:', result1.error?.message);
    }
    
    if (result2.status === 'completed') {
      console.log('✓ 第二个请求成功');
      console.log(`  创建了 ${result2.result.count} 个工具`);
      result2.result.tools.forEach(tool => {
        console.log(`  - ${tool.name} (ID: ${tool.id})`);
      });
    } else {
      console.error('第二个请求失败:', result2.error?.message);
    }
    
    if (result3.status === 'completed') {
      console.log('✓ 第三个请求成功');
      console.log(`  创建了 ${result3.result.count} 个工具`);
      result3.result.tools.forEach(tool => {
        console.log(`  - ${tool.name} (ID: ${tool.id})`);
      });
    } else {
      console.error('第三个请求失败:', result3.error?.message);
    }
    
    // 测试工具执行
    console.log('\n=== 测试工具执行 ===');
    
    // 测试计算器工具
    const calculatorTool = result1.result.tools.find(t => t.name === 'Calculator Tool');
    if (calculatorTool) {
      console.log('测试计算器工具:');
      try {
        const calcResult = await calculatorTool.execute({ operation: 'add', num1: 10, num2: 5 });
        console.log(`  10 + 5 = ${calcResult.result}`);
      } catch (error) {
        console.error('  错误:', error.message);
      }
    }
    
    // 测试数据分析工具
    const dataAnalyzerTool = result3.result.tools.find(t => t.name === 'Data Analyzer Tool');
    if (dataAnalyzerTool) {
      console.log('\n测试数据分析工具:');
      try {
        const dataResult = await dataAnalyzerTool.execute({ 
          data: [1, 2, 3, 4, 5], 
          operation: 'average' 
        });
        console.log(`  平均值: ${dataResult.result}`);
      } catch (error) {
        console.error('  错误:', error.message);
      }
    }
    
    // 检查池状态
    console.log('\n=== 池状态 ===');
    console.log(toolCreatorPool.getStatus());
    
    console.log('\n=== 测试完成 ===');
  } catch (error) {
    console.error('测试失败:', error.message);
    console.error('错误堆栈:', error.stack);
  }
}

// 运行测试
testMultiToolCreator().catch(console.error);
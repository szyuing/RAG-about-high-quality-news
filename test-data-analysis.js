const {
  AgentSystem
} = require('./src/agent-orchestrator');

async function testDataAnalysisAndProgressTracking() {
  console.log('=== 数据分析和研究进度跟踪测试 ===\n');
  
  const agentSystem = new AgentSystem();
  
  // 1. 测试文本数据分析
  console.log('1. 测试文本数据分析:');
  
  const sampleText = `Sora is an AI model developed by OpenAI that can generate videos from text descriptions. It was released in February 2024 and has the capability to generate videos up to 60 seconds in length. The model uses diffusion techniques to create high-quality video content from textual prompts.`;
  
  const textAnalysis = agentSystem.analyzeText(sampleText, { topN: 5 });
  console.log('  文本分析结果:');
  console.log(`    词数: ${textAnalysis.results.wordCount}`);
  console.log(`    句子数: ${textAnalysis.results.sentenceCount}`);
  console.log(`    情感分析: ${textAnalysis.results.sentiment}`);
  console.log(`    可读性: ${textAnalysis.results.readability}`);
  console.log('    关键词频率:');
  textAnalysis.results.keywordFrequency.forEach(keyword => {
    console.log(`      - ${keyword.word}: ${keyword.count}`);
  });
  console.log('');
  
  // 2. 测试结构化数据分析
  console.log('2. 测试结构化数据分析:');
  
  const sampleData = {
    sources: 15,
    evidence: 25,
    confidence: 0.85,
    duration: 3600000 // 1 hour
  };
  
  const structuredAnalysis = agentSystem.analyzeStructuredData(sampleData);
  console.log('  结构化数据分析结果:');
  console.log(`    数据类型: ${structuredAnalysis.results.dataType}`);
  console.log(`    大小: ${structuredAnalysis.results.size}`);
  console.log('    洞察:');
  structuredAnalysis.results.insights.forEach(insight => {
    console.log(`      - ${insight}`);
  });
  console.log('');
  
  // 3. 测试研究数据分析
  console.log('3. 测试研究数据分析:');
  
  const researchData = {
    sources: ['source1.com', 'source2.com', 'source3.com'],
    evidence: [
      { id: 'e1', content: 'Evidence 1' },
      { id: 'e2', content: 'Evidence 2' },
      { id: 'e3', content: 'Evidence 3' }
    ],
    summary: 'Research summary',
    timestamp: Date.now()
  };
  
  const researchAnalysis = agentSystem.analyzeResearchData(researchData);
  console.log('  研究数据分析结果:');
  console.log(`    信息源数量: ${researchAnalysis.results.sourceCount}`);
  console.log(`    证据数量: ${researchAnalysis.results.evidenceCount}`);
  console.log(`    置信度: ${researchAnalysis.results.confidence}`);
  console.log('    关键发现:');
  researchAnalysis.results.keyFindings.forEach(finding => {
    console.log(`      - ${finding}`);
  });
  console.log('    研究差距:');
  researchAnalysis.results.gaps.forEach(gap => {
    console.log(`      - ${gap}`);
  });
  console.log('');
  
  // 4. 测试研究进度跟踪
  console.log('4. 测试研究进度跟踪:');
  
  // 创建研究任务
  const taskId = 'research_sora_001';
  const task = agentSystem.createResearchTask(
    taskId,
    '研究Sora模型 capabilities',
    '深入分析Sora模型的技术特点和应用场景',
    'high'
  );
  console.log('  创建研究任务:', task.title);
  console.log(`  任务ID: ${task.id}`);
  console.log(`  初始状态: ${task.status}`);
  console.log(`  初始进度: ${task.progress}%`);
  console.log('');
  
  // 添加任务步骤
  console.log('5. 测试任务步骤管理:');
  
  const step1 = agentSystem.addTaskStep(taskId, {
    title: '收集信息',
    description: '从多个来源收集Sora模型的信息'
  });
  console.log('  添加步骤1:', step1.title);
  
  const step2 = agentSystem.addTaskStep(taskId, {
    title: '分析数据',
    description: '分析收集到的信息'
  });
  console.log('  添加步骤2:', step2.title);
  
  const step3 = agentSystem.addTaskStep(taskId, {
    title: '生成报告',
    description: '基于分析结果生成研究报告'
  });
  console.log('  添加步骤3:', step3.title);
  console.log('');
  
  // 更新任务状态和进度
  console.log('6. 测试任务状态和进度更新:');
  
  agentSystem.updateTaskStatus(taskId, 'in_progress');
  console.log('  更新任务状态为: in_progress');
  
  agentSystem.updateStepStatus(taskId, step1.id, 'completed');
  console.log('  完成步骤1:', step1.title);
  
  agentSystem.updateStepStatus(taskId, step2.id, 'in_progress');
  console.log('  开始步骤2:', step2.title);
  
  const updatedTask = agentSystem.getResearchTask(taskId);
  console.log(`  当前任务进度: ${updatedTask.progress}%`);
  console.log(`  当前任务状态: ${updatedTask.status}`);
  console.log('');
  
  // 完成任务
  console.log('7. 测试任务完成:');
  
  agentSystem.updateStepStatus(taskId, step2.id, 'completed');
  agentSystem.updateStepStatus(taskId, step3.id, 'completed');
  
  const completedTask = agentSystem.getResearchTask(taskId);
  console.log(`  完成后任务进度: ${completedTask.progress}%`);
  console.log(`  完成后任务状态: ${completedTask.status}`);
  console.log('');
  
  // 测试任务统计
  console.log('8. 测试任务统计:');
  
  const taskStats = agentSystem.getTaskStats();
  console.log('  任务统计:');
  console.log(`    总任务数: ${taskStats.total}`);
  console.log(`    待处理任务: ${taskStats.pending}`);
  console.log(`    进行中任务: ${taskStats.inProgress}`);
  console.log(`    已完成任务: ${taskStats.completed}`);
  console.log(`    失败任务: ${taskStats.failed}`);
  console.log(`    平均进度: ${taskStats.averageProgress.toFixed(2)}%`);
  console.log('');
  
  // 测试分析历史
  console.log('9. 测试分析历史:');
  
  const analysisHistory = agentSystem.getAnalysisHistory();
  console.log(`  分析历史数量: ${analysisHistory.length}`);
  analysisHistory.forEach((analysis, index) => {
    console.log(`    ${index + 1}. ${analysis.type} 分析 (${new Date(analysis.timestamp).toLocaleString()})`);
  });
  console.log('');
  
  // 测试清理功能
  console.log('10. 测试清理功能:');
  
  agentSystem.clearAnalysisHistory();
  console.log('  清理分析历史后数量:', agentSystem.getAnalysisHistory().length);
  
  const cleaned = agentSystem.cleanupCompletedTasks();
  console.log(`  清理完成的任务数量: ${cleaned}`);
  console.log(`  清理后任务数量: ${agentSystem.getAllResearchTasks().length}`);
  console.log('');
  
  console.log('=== 数据分析和研究进度跟踪测试完成 ===');
}

testDataAnalysisAndProgressTracking().catch(console.error);
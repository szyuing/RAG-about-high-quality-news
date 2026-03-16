const {
  AgentSystem,
  AgentType
} = require('./src/agent-orchestrator');

async function testKnowledgeSharing() {
  console.log('=== Agent知识共享和冲突解决测试 ===\n');
  
  const agentSystem = new AgentSystem();
  
  // 1. 测试知识共享
  console.log('1. 测试知识共享:');
  
  // Web Researcher共享知识
  const knowledgeId1 = agentSystem.shareKnowledge(
    AgentType.WEB_RESEARCHER,
    'Sora is an AI model by OpenAI that can generate videos from text descriptions',
    ['Sora', 'OpenAI', 'video generation'],
    0.9
  );
  console.log('  Web Researcher共享知识ID:', knowledgeId1);
  
  // Deep Analyst共享知识
  const knowledgeId2 = agentSystem.shareKnowledge(
    AgentType.DEEP_ANALYST,
    'Sora can generate videos up to 60 seconds in length',
    ['Sora', 'video generation', 'capabilities'],
    0.85
  );
  console.log('  Deep Analyst共享知识ID:', knowledgeId2);
  
  // Multimedia Agent共享知识
  const knowledgeId3 = agentSystem.shareKnowledge(
    AgentType.MULTIMEDIA,
    'Sora uses diffusion models for video generation',
    ['Sora', 'diffusion models', 'video generation'],
    0.8
  );
  console.log('  Multimedia Agent共享知识ID:', knowledgeId3);
  console.log('');
  
  // 2. 测试知识搜索
  console.log('2. 测试知识搜索:');
  
  // 按标签搜索
  const soraKnowledge = agentSystem.searchKnowledge('', ['Sora']);
  console.log('  搜索Sora相关知识:', soraKnowledge.length, '条');
  soraKnowledge.forEach(ku => {
    console.log(`    - ${ku.content} (${ku.source}, 置信度: ${ku.confidence})`);
  });
  
  // 按内容搜索
  const videoKnowledge = agentSystem.searchKnowledge('video generation');
  console.log('  搜索视频生成相关知识:', videoKnowledge.length, '条');
  videoKnowledge.forEach(ku => {
    console.log(`    - ${ku.content} (${ku.source})`);
  });
  console.log('');
  
  // 3. 测试冲突检测
  console.log('3. 测试冲突检测:');
  
  // 共享冲突的知识
  const conflictKnowledgeId = agentSystem.shareKnowledge(
    AgentType.WEB_RESEARCHER,
    'Sora cannot generate videos longer than 30 seconds',
    ['Sora', 'video generation', 'limitations'],
    0.7
  );
  console.log('  共享冲突知识ID:', conflictKnowledgeId);
  
  // 检查冲突
  const conflicts = agentSystem.getConflicts();
  console.log('  检测到的冲突数量:', conflicts.length);
  conflicts.forEach(conflict => {
    console.log(`    冲突ID: ${conflict.id}`);
    console.log(`    严重程度: ${conflict.severity}`);
    console.log(`    状态: ${conflict.status}`);
  });
  
  const unresolvedConflicts = agentSystem.getUnresolvedConflicts();
  console.log('  未解决的冲突数量:', unresolvedConflicts.length);
  console.log('');
  
  // 4. 测试冲突解决
  console.log('4. 测试冲突解决:');
  
  if (unresolvedConflicts.length > 0) {
    const conflict = unresolvedConflicts[0];
    const resolution = {
      resolvedBy: AgentType.SUPERVISOR,
      resolution: 'Sora can generate videos up to 60 seconds, but quality may decrease for longer videos',
      confidence: 0.85
    };
    
    const resolveResult = agentSystem.resolveConflict(conflict.id, resolution);
    console.log('  解决冲突结果:', resolveResult ? '成功' : '失败');
    
    const afterResolve = agentSystem.getUnresolvedConflicts();
    console.log('  解决后未解决的冲突数量:', afterResolve.length);
  }
  console.log('');
  
  // 5. 测试知识统计
  console.log('5. 测试知识统计:');
  const stats = agentSystem.getKnowledgeStats();
  console.log('  知识统计:', JSON.stringify(stats, null, 2));
  console.log('');
  
  // 6. 测试知识清理
  console.log('6. 测试知识清理:');
  console.log('  清理前知识单元数量:', stats.totalKnowledgeUnits);
  
  // 清理1毫秒前的知识（实际上不会清理任何知识，因为知识都是刚创建的）
  const cleaned = agentSystem.cleanupOldKnowledge(1);
  console.log('  清理的知识单元数量:', cleaned);
  
  const afterCleanup = agentSystem.getKnowledgeStats();
  console.log('  清理后知识单元数量:', afterCleanup.totalKnowledgeUnits);
  console.log('');
  
  // 7. 测试多Agent知识共享场景
  console.log('7. 测试多Agent知识共享场景:');
  console.log('  场景: 多个Agent协作完成研究任务');
  
  // Web Researcher发现新信息
  const newKnowledgeId = agentSystem.shareKnowledge(
    AgentType.WEB_RESEARCHER,
    'Sora was released in February 2024',
    ['Sora', 'release', '2024'],
    0.95
  );
  console.log('  Web Researcher发现新信息:', newKnowledgeId);
  
  // Deep Analyst分析信息
  const analysisKnowledgeId = agentSystem.shareKnowledge(
    AgentType.DEEP_ANALYST,
    'Sora\'s release marked a significant advancement in video generation AI',
    ['Sora', 'analysis', 'impact'],
    0.8
  );
  console.log('  Deep Analyst分析信息:', analysisKnowledgeId);
  
  // Synthesizer综合信息
  const synthesisKnowledgeId = agentSystem.shareKnowledge(
    AgentType.SYNTHESIZER,
    'Sora represents a major breakthrough in AI-generated video, enabling high-quality 60-second videos from text',
    ['Sora', 'synthesis', 'summary'],
    0.85
  );
  console.log('  Synthesizer综合信息:', synthesisKnowledgeId);
  
  // 搜索所有Sora相关知识
  const allSoraKnowledge = agentSystem.searchKnowledge('', ['Sora']);
  console.log('  最终Sora相关知识数量:', allSoraKnowledge.length);
  console.log('');
  
  console.log('=== Agent知识共享和冲突解决测试完成 ===');
}

testKnowledgeSharing().catch(console.error);
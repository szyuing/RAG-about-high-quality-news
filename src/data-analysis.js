class DataAnalyzer {
  constructor() {
    this.analysisHistory = [];
  }

  // 分析文本数据
  analyzeText(data, options = {}) {
    const analysis = {
      id: `analysis_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'text',
      timestamp: Date.now(),
      input: data,
      results: {
        wordCount: this.countWords(data),
        sentenceCount: this.countSentences(data),
        keywordFrequency: this.extractKeywords(data, options.topN || 10),
        sentiment: this.analyzeSentiment(data),
        readability: this.calculateReadability(data)
      }
    };
    
    this.analysisHistory.push(analysis);
    return analysis;
  }

  // 分析结构化数据
  analyzeStructuredData(data, options = {}) {
    const analysis = {
      id: `analysis_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'structured',
      timestamp: Date.now(),
      input: data,
      results: {
        dataType: Array.isArray(data) ? 'array' : typeof data,
        size: Array.isArray(data) ? data.length : Object.keys(data).length,
        statistics: this.calculateStatistics(data),
        insights: this.extractInsights(data)
      }
    };
    
    this.analysisHistory.push(analysis);
    return analysis;
  }

  // 分析研究数据
  analyzeResearchData(researchData, options = {}) {
    const analysis = {
      id: `analysis_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'research',
      timestamp: Date.now(),
      input: researchData,
      results: {
        sourceCount: researchData.sources ? researchData.sources.length : 0,
        evidenceCount: researchData.evidence ? researchData.evidence.length : 0,
        keyFindings: this.extractKeyFindings(researchData),
        confidence: this.calculateConfidence(researchData),
        gaps: this.identifyResearchGaps(researchData)
      }
    };
    
    this.analysisHistory.push(analysis);
    return analysis;
  }

  // 辅助方法：计算词数
  countWords(text) {
    return text.split(/\s+/).filter(word => word.length > 0).length;
  }

  // 辅助方法：计算句子数
  countSentences(text) {
    return text.split(/[.!?]+/).filter(sentence => sentence.trim().length > 0).length;
  }

  // 辅助方法：提取关键词
  extractKeywords(text, topN = 10) {
    const words = text.toLowerCase().split(/\s+/).filter(word => word.length > 3);
    const frequency = {};
    
    words.forEach(word => {
      frequency[word] = (frequency[word] || 0) + 1;
    });
    
    return Object.entries(frequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([word, count]) => ({ word, count }));
  }

  // 辅助方法：分析情感
  analyzeSentiment(text) {
    // 简单的情感分析
    const positiveWords = ['good', 'great', 'excellent', 'amazing', 'positive', 'success', 'improvement'];
    const negativeWords = ['bad', 'poor', 'terrible', 'awful', 'negative', 'failure', 'problem'];
    
    let positiveCount = 0;
    let negativeCount = 0;
    
    const words = text.toLowerCase().split(/\s+/);
    words.forEach(word => {
      if (positiveWords.includes(word)) positiveCount++;
      if (negativeWords.includes(word)) negativeCount++;
    });
    
    if (positiveCount > negativeCount) return 'positive';
    if (negativeCount > positiveCount) return 'negative';
    return 'neutral';
  }

  // 辅助方法：计算可读性
  calculateReadability(text) {
    const words = text.split(/\s+/).filter(word => word.length > 0);
    const sentences = text.split(/[.!?]+/).filter(sentence => sentence.trim().length > 0);
    const avgWordsPerSentence = words.length / sentences.length;
    
    if (avgWordsPerSentence < 10) return 'very easy';
    if (avgWordsPerSentence < 15) return 'easy';
    if (avgWordsPerSentence < 20) return 'moderate';
    if (avgWordsPerSentence < 25) return 'difficult';
    return 'very difficult';
  }

  // 辅助方法：计算统计数据
  calculateStatistics(data) {
    if (!Array.isArray(data)) return {};
    
    const numbers = data.filter(item => typeof item === 'number');
    if (numbers.length === 0) return {};
    
    const sum = numbers.reduce((acc, num) => acc + num, 0);
    const mean = sum / numbers.length;
    const sorted = numbers.sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    
    return {
      count: numbers.length,
      sum,
      mean,
      median,
      min,
      max,
      range: max - min
    };
  }

  // 辅助方法：提取洞察
  extractInsights(data) {
    const insights = [];
    
    if (Array.isArray(data)) {
      if (data.length > 0) {
        insights.push(`数据集包含 ${data.length} 个项目`);
      }
    } else if (typeof data === 'object') {
      const keys = Object.keys(data);
      insights.push(`数据包含 ${keys.length} 个属性`);
    }
    
    return insights;
  }

  // 辅助方法：提取关键发现
  extractKeyFindings(researchData) {
    const findings = [];
    
    if (researchData.sources) {
      findings.push(`找到 ${researchData.sources.length} 个信息源`);
    }
    
    if (researchData.evidence) {
      findings.push(`收集到 ${researchData.evidence.length} 个证据单元`);
    }
    
    if (researchData.summary) {
      findings.push('研究包含详细摘要');
    }
    
    return findings;
  }

  // 辅助方法：计算置信度
  calculateConfidence(researchData) {
    let confidence = 0.5;
    
    if (researchData.sources && researchData.sources.length > 3) {
      confidence += 0.2;
    }
    
    if (researchData.evidence && researchData.evidence.length > 5) {
      confidence += 0.2;
    }
    
    if (researchData.timestamp) {
      const age = Date.now() - researchData.timestamp;
      if (age < 7 * 24 * 60 * 60 * 1000) { // 一周内
        confidence += 0.1;
      }
    }
    
    return Math.min(confidence, 1.0);
  }

  // 辅助方法：识别研究差距
  identifyResearchGaps(researchData) {
    const gaps = [];
    
    if (!researchData.sources || researchData.sources.length === 0) {
      gaps.push('缺少信息源');
    }
    
    if (!researchData.evidence || researchData.evidence.length === 0) {
      gaps.push('缺少证据支持');
    }
    
    if (!researchData.summary) {
      gaps.push('缺少研究摘要');
    }
    
    return gaps;
  }

  // 获取分析历史
  getAnalysisHistory() {
    return this.analysisHistory;
  }

  // 清理分析历史
  clearAnalysisHistory() {
    this.analysisHistory = [];
  }
}

class ResearchProgressTracker {
  constructor() {
    this.researchTasks = new Map();
  }

  // 创建研究任务
  createTask(id, title, description, priority = 'medium') {
    const task = {
      id,
      title,
      description,
      priority,
      status: 'pending', // pending, in_progress, completed, failed
      progress: 0,
      steps: [],
      startTime: null,
      endTime: null,
      createdAt: Date.now()
    };
    
    this.researchTasks.set(id, task);
    return task;
  }

  // 更新任务状态
  updateTaskStatus(id, status) {
    const task = this.researchTasks.get(id);
    if (task) {
      task.status = status;
      
      if (status === 'in_progress' && !task.startTime) {
        task.startTime = Date.now();
      }
      
      if (status === 'completed' || status === 'failed') {
        task.endTime = Date.now();
      }
      
      return true;
    }
    return false;
  }

  // 更新任务进度
  updateTaskProgress(id, progress) {
    const task = this.researchTasks.get(id);
    if (task) {
      task.progress = Math.max(0, Math.min(100, progress));
      
      if (progress >= 100) {
        task.status = 'completed';
        task.endTime = Date.now();
      }
      
      return true;
    }
    return false;
  }

  // 添加任务步骤
  addTaskStep(id, step) {
    const task = this.researchTasks.get(id);
    if (task) {
      const stepWithId = {
        id: `step_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        ...step,
        createdAt: Date.now(),
        status: 'pending'
      };
      task.steps.push(stepWithId);
      return stepWithId;
    }
    return null;
  }

  // 更新步骤状态
  updateStepStatus(taskId, stepId, status) {
    const task = this.researchTasks.get(taskId);
    if (task) {
      const step = task.steps.find(s => s.id === stepId);
      if (step) {
        step.status = status;
        
        // 更新任务进度
        const completedSteps = task.steps.filter(s => s.status === 'completed').length;
        const totalSteps = task.steps.length;
        if (totalSteps > 0) {
          const progress = (completedSteps / totalSteps) * 100;
          this.updateTaskProgress(taskId, progress);
        }
        
        return true;
      }
    }
    return false;
  }

  // 获取任务
  getTask(id) {
    return this.researchTasks.get(id);
  }

  // 获取所有任务
  getAllTasks() {
    return Array.from(this.researchTasks.values());
  }

  // 获取任务统计
  getTaskStats() {
    const tasks = Array.from(this.researchTasks.values());
    const stats = {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending').length,
      inProgress: tasks.filter(t => t.status === 'in_progress').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      averageProgress: tasks.length > 0 
        ? tasks.reduce((sum, task) => sum + task.progress, 0) / tasks.length 
        : 0
    };
    
    return stats;
  }

  // 删除任务
  deleteTask(id) {
    return this.researchTasks.delete(id);
  }

  // 清理完成的任务
  cleanupCompletedTasks() {
    const completedTasks = [];
    for (const [id, task] of this.researchTasks.entries()) {
      if (task.status === 'completed' || task.status === 'failed') {
        completedTasks.push(id);
      }
    }
    
    completedTasks.forEach(id => this.researchTasks.delete(id));
    return completedTasks.length;
  }
}

// 导出单例
const dataAnalyzer = new DataAnalyzer();
const researchProgressTracker = new ResearchProgressTracker();

module.exports = {
  DataAnalyzer,
  ResearchProgressTracker,
  dataAnalyzer,
  researchProgressTracker
};
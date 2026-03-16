class AgentManager {
  constructor() {
    this.agents = new Map();
    this.agentTypes = new Map();
    this.taskQueue = [];
    this.pendingTasks = new Map();
  }

  // 注册Agent类型
  registerAgentType(type, factory) {
    this.agentTypes.set(type, factory);
  }

  // 创建Agent
  createAgent(type, config = {}) {
    if (!this.agentTypes.has(type)) {
      throw new Error(`Agent type ${type} not registered`);
    }

    const factory = this.agentTypes.get(type);
    const agent = factory(config);
    this.agents.set(agent.id, agent);
    return agent;
  }

  // 销毁Agent
  destroyAgent(agentId) {
    if (this.agents.has(agentId)) {
      const agent = this.agents.get(agentId);
      // 清理与Agent相关的资源
      this.agents.delete(agentId);
      // 从待处理任务中移除该Agent的任务
      this.pendingTasks.forEach((tasks, aid) => {
        if (aid === agentId) {
          this.pendingTasks.delete(aid);
        }
      });
      return true;
    }
    return false;
  }

  // 获取Agent
  getAgent(agentId) {
    return this.agents.get(agentId);
  }

  // 获取所有Agent
  getAllAgents() {
    return Array.from(this.agents.values());
  }

  // 获取指定类型的Agent
  getAgentsByType(type) {
    return Array.from(this.agents.values()).filter(agent => agent.type === type);
  }

  // 评估Agent能力
  evaluateAgentCapability(agent) {
    // 简单的能力评估，基于Agent类型和状态
    const baseCapability = {
      web_researcher: 10,
      deep_analyst: 8,
      multimedia: 7,
      fact_verifier: 9,
      synthesizer: 8
    };

    const base = baseCapability[agent.type] || 5;
    const statusMultiplier = {
      idle: 1.0,
      running: 0.7,
      completed: 1.0,
      failed: 0.5
    };

    const multiplier = statusMultiplier[agent.status] || 0.5;
    return base * multiplier;
  }

  // 计算Agent负载
  calculateAgentLoad(agent) {
    const pendingTasks = this.pendingTasks.get(agent.id) || [];
    return pendingTasks.length;
  }

  // 分配任务
  assignTask(task) {
    // 分析任务需求
    const requiredCapabilities = this.analyzeTaskRequirements(task);
    
    // 选择最合适的Agent
    const suitableAgents = this.findSuitableAgents(requiredCapabilities);
    
    if (suitableAgents.length === 0) {
      // 动态创建Agent
      const agent = this.createAgent(requiredCapabilities[0].type);
      suitableAgents.push(agent);
    }

    // 按能力和负载排序
    suitableAgents.sort((a, b) => {
      const capA = this.evaluateAgentCapability(a);
      const capB = this.evaluateAgentCapability(b);
      const loadA = this.calculateAgentLoad(a);
      const loadB = this.calculateAgentLoad(b);
      
      // 优先选择能力高且负载低的Agent
      return (capB / (loadB + 1)) - (capA / (loadA + 1));
    });

    // 分配任务给最佳Agent
    const selectedAgent = suitableAgents[0];
    if (selectedAgent) {
      if (!this.pendingTasks.has(selectedAgent.id)) {
        this.pendingTasks.set(selectedAgent.id, []);
      }
      this.pendingTasks.get(selectedAgent.id).push(task);
      
      return {
        success: true,
        agentId: selectedAgent.id,
        agentType: selectedAgent.type
      };
    }

    return { success: false, message: 'No suitable agent found' };
  }

  // 分析任务需求
  analyzeTaskRequirements(task) {
    // 简单的任务需求分析
    const requirements = [];
    
    if (task.type === 'web_search' || task.content.includes('search')) {
      requirements.push({ type: 'web_researcher', priority: 'high' });
    }
    
    if (task.type === 'analysis' || task.content.includes('analyze')) {
      requirements.push({ type: 'deep_analyst', priority: 'high' });
    }
    
    if (task.type === 'multimedia' || task.content.includes('image') || task.content.includes('video')) {
      requirements.push({ type: 'multimedia', priority: 'high' });
    }
    
    if (task.type === 'verification' || task.content.includes('verify')) {
      requirements.push({ type: 'fact_verifier', priority: 'high' });
    }
    
    if (task.type === 'synthesis' || task.content.includes('summarize') || task.content.includes('report')) {
      requirements.push({ type: 'synthesizer', priority: 'high' });
    }
    
    // 默认需求
    if (requirements.length === 0) {
      requirements.push({ type: 'web_researcher', priority: 'medium' });
    }
    
    return requirements;
  }

  // 寻找合适的Agent
  findSuitableAgents(requiredCapabilities) {
    const suitableAgents = [];
    
    for (const agent of this.agents.values()) {
      const capability = this.evaluateAgentCapability(agent);
      if (capability > 0) {
        // 检查Agent类型是否匹配需求
        const isSuitable = requiredCapabilities.some(req => req.type === agent.type);
        if (isSuitable) {
          suitableAgents.push(agent);
        }
      }
    }
    
    return suitableAgents;
  }

  // 完成任务
  completeTask(agentId, taskId) {
    if (this.pendingTasks.has(agentId)) {
      const tasks = this.pendingTasks.get(agentId);
      const taskIndex = tasks.findIndex(task => task.id === taskId);
      if (taskIndex > -1) {
        tasks.splice(taskIndex, 1);
        return true;
      }
    }
    return false;
  }

  // 获取Agent状态
  getAgentStatus() {
    return Array.from(this.agents.values()).map(agent => ({
      id: agent.id,
      type: agent.type,
      status: agent.status,
      capability: this.evaluateAgentCapability(agent),
      load: this.calculateAgentLoad(agent)
    }));
  }

  // 动态调整Agent数量
  adjustAgentPool() {
    const agentStatus = this.getAgentStatus();
    const totalLoad = agentStatus.reduce((sum, agent) => sum + agent.load, 0);
    const averageLoad = totalLoad / agentStatus.length;
    
    // 简单的负载均衡策略
    for (const type of this.agentTypes.keys()) {
      const agentsOfType = agentStatus.filter(agent => agent.type === type);
      const typeLoad = agentsOfType.reduce((sum, agent) => sum + agent.load, 0);
      const typeAverageLoad = typeLoad / agentsOfType.length;
      
      // 如果负载过高，创建新Agent
      if (typeAverageLoad > 2) {
        console.log(`Creating new ${type} agent due to high load`);
        this.createAgent(type);
      }
      
      // 如果负载过低且Agent数量超过1，销毁多余的Agent
      if (typeAverageLoad < 0.5 && agentsOfType.length > 1) {
        const idleAgents = agentsOfType.filter(agent => agent.status === 'idle');
        if (idleAgents.length > 0) {
          console.log(`Destroying idle ${type} agent due to low load`);
          this.destroyAgent(idleAgents[0].id);
        }
      }
    }
  }
}

class Task {
  constructor(id, type, content, priority = 'medium', metadata = {}) {
    this.id = id || `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.type = type;
    this.content = content;
    this.priority = priority; // high, medium, low
    this.metadata = metadata;
    this.timestamp = Date.now();
    this.status = 'pending'; // pending, assigned, in_progress, completed, failed
    this.assignedAgent = null;
  }

  assignTo(agentId) {
    this.assignedAgent = agentId;
    this.status = 'assigned';
  }

  start() {
    this.status = 'in_progress';
    this.startTime = Date.now();
  }

  complete(result) {
    this.status = 'completed';
    this.endTime = Date.now();
    this.result = result;
  }

  fail(error) {
    this.status = 'failed';
    this.endTime = Date.now();
    this.error = error;
  }
}

// 导出
module.exports = {
  AgentManager,
  Task
};
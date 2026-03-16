const fs = require('fs');
const path = require('path');
const { ensureDirectoryExists, resolveStateDir } = require("./data-paths");

class StatePersistence {
  constructor(storagePath = resolveStateDir()) {
    this.storagePath = storagePath;
    this.ensureDirectoryExists();
  }

  // 确保存储目录存在
  ensureDirectoryExists() {
    ensureDirectoryExists(this.storagePath);
  }

  // 保存状态
  async saveState(key, state) {
    const filePath = path.join(this.storagePath, `${key}.json`);
    try {
      const data = {
        state,
        timestamp: Date.now(),
        version: '1.0'
      };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      return { success: true, message: `State saved to ${filePath}` };
    } catch (error) {
      console.error('Error saving state:', error);
      return { success: false, message: error.message };
    }
  }

  // 加载状态
  async loadState(key) {
    const filePath = path.join(this.storagePath, `${key}.json`);
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, message: 'State not found' };
      }
      const data = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(data);
      return { success: true, data: parsed.state, timestamp: parsed.timestamp };
    } catch (error) {
      console.error('Error loading state:', error);
      return { success: false, message: error.message };
    }
  }

  // 删除状态
  async deleteState(key) {
    const filePath = path.join(this.storagePath, `${key}.json`);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return { success: true, message: `State deleted: ${key}` };
      }
      return { success: false, message: 'State not found' };
    } catch (error) {
      console.error('Error deleting state:', error);
      return { success: false, message: error.message };
    }
  }

  // 列出所有状态
  listStates() {
    try {
      const files = fs.readdirSync(this.storagePath);
      const states = files
        .filter(file => file.endsWith('.json'))
        .map(file => {
          const key = file.replace('.json', '');
          const filePath = path.join(this.storagePath, file);
          try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            return {
              key,
              timestamp: data.timestamp,
              version: data.version
            };
          } catch (error) {
            return {
              key,
              error: error.message
            };
          }
        });
      return { success: true, states };
    } catch (error) {
      console.error('Error listing states:', error);
      return { success: false, message: error.message };
    }
  }

  // 保存会话状态
  async saveSession(sessionId, sessionData) {
    return this.saveState(`session_${sessionId}`, sessionData);
  }

  // 加载会话状态
  async loadSession(sessionId) {
    return this.loadState(`session_${sessionId}`);
  }

  // 保存Agent状态
  async saveAgentState(agentId, agentState) {
    return this.saveState(`agent_${agentId}`, agentState);
  }

  // 加载Agent状态
  async loadAgentState(agentId) {
    return this.loadState(`agent_${agentId}`);
  }

  // 保存工作流状态
  async saveWorkflowState(workflowId, workflowState) {
    return this.saveState(`workflow_${workflowId}`, workflowState);
  }

  // 加载工作流状态
  async loadWorkflowState(workflowId) {
    return this.loadState(`workflow_${workflowId}`);
  }
}

// 导出单例
const statePersistence = new StatePersistence();

module.exports = {
  StatePersistence,
  statePersistence
};

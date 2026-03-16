class Message {
  constructor(sender, receiver, type, content, metadata = {}) {
    this.id = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.sender = sender;
    this.receiver = receiver;
    this.type = type; // request, response, notification, error
    this.content = content;
    this.metadata = metadata;
    this.timestamp = Date.now();
    this.status = 'sent'; // sent, delivered, processed, failed
  }

  markDelivered() {
    this.status = 'delivered';
    this.deliveredAt = Date.now();
  }

  markProcessed() {
    this.status = 'processed';
    this.processedAt = Date.now();
  }

  markFailed(error) {
    this.status = 'failed';
    this.failedAt = Date.now();
    this.error = error;
  }
}

class MessageQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  enqueue(message) {
    this.queue.push(message);
    if (!this.processing) {
      this.processNext();
    }
  }

  async processNext() {
    if (this.queue.length === 0) {
      this.processing = false;
      return;
    }

    this.processing = true;
    const message = this.queue.shift();

    try {
      message.markDelivered();
      // 这里可以添加消息处理逻辑
      message.markProcessed();
    } catch (error) {
      message.markFailed(error.message);
    }

    await this.processNext();
  }

  getQueueLength() {
    return this.queue.length;
  }

  clear() {
    this.queue = [];
  }
}

class AgentCommunication {
  constructor() {
    this.messageQueue = new MessageQueue();
    this.messageHistory = [];
    this.subscriptions = new Map(); // 角色 -> 回调函数
  }

  // 发送消息
  sendMessage(sender, receiver, type, content, metadata = {}) {
    const message = new Message(sender, receiver, type, content, metadata);
    this.messageQueue.enqueue(message);
    this.messageHistory.push(message);
    return message;
  }

  // 发送请求
  sendRequest(sender, receiver, content, metadata = {}) {
    return this.sendMessage(sender, receiver, 'request', content, metadata);
  }

  // 发送响应
  sendResponse(sender, receiver, content, metadata = {}) {
    return this.sendMessage(sender, receiver, 'response', content, metadata);
  }

  // 发送通知
  sendNotification(sender, receiver, content, metadata = {}) {
    return this.sendMessage(sender, receiver, 'notification', content, metadata);
  }

  // 发送错误
  sendError(sender, receiver, content, metadata = {}) {
    return this.sendMessage(sender, receiver, 'error', content, metadata);
  }

  // 订阅角色消息
  subscribe(role, callback) {
    if (!this.subscriptions.has(role)) {
      this.subscriptions.set(role, []);
    }
    this.subscriptions.get(role).push(callback);
  }

  // 取消订阅
  unsubscribe(role, callback) {
    if (this.subscriptions.has(role)) {
      const callbacks = this.subscriptions.get(role);
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  // 处理消息
  async processMessage(message) {
    // 通知订阅者
    const role = message.receiver;
    if (this.subscriptions.has(role)) {
      const callbacks = this.subscriptions.get(role);
      for (const callback of callbacks) {
        try {
          await callback(message);
        } catch (error) {
          console.error(`Error processing message callback:`, error);
        }
      }
    }
  }

  // 获取消息历史
  getMessageHistory() {
    return this.messageHistory;
  }

  // 获取消息统计
  getMessageStats() {
    const stats = {
      total: this.messageHistory.length,
      byType: {},
      byStatus: {},
      bySender: {},
      byReceiver: {}
    };

    for (const message of this.messageHistory) {
      // 按类型统计
      stats.byType[message.type] = (stats.byType[message.type] || 0) + 1;
      // 按状态统计
      stats.byStatus[message.status] = (stats.byStatus[message.status] || 0) + 1;
      // 按发送者统计
      stats.bySender[message.sender] = (stats.bySender[message.sender] || 0) + 1;
      // 按接收者统计
      stats.byReceiver[message.receiver] = (stats.byReceiver[message.receiver] || 0) + 1;
    }

    return stats;
  }

  // 清理消息历史
  clearMessageHistory() {
    this.messageHistory = [];
  }
}

// 导出单例
const agentCommunication = new AgentCommunication();

module.exports = {
  Message,
  MessageQueue,
  AgentCommunication,
  agentCommunication
};
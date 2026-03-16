class Message {
  constructor(sender, receiver, type, content, metadata = {}) {
    this.id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    this.sender = sender;
    this.receiver = receiver;
    this.type = type;
    this.content = content;
    this.metadata = metadata;
    this.timestamp = Date.now();
    this.status = "sent";
  }

  markDelivered() {
    this.status = "delivered";
    this.deliveredAt = Date.now();
  }

  markProcessed() {
    this.status = "processed";
    this.processedAt = Date.now();
  }

  markFailed(error) {
    this.status = "failed";
    this.failedAt = Date.now();
    this.error = error;
  }
}

class MessageQueue {
  constructor(processor = null) {
    this.queue = [];
    this.processing = false;
    this.processor = processor;
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
      if (typeof this.processor === "function") {
        await this.processor(message);
      }
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
    this.pendingResponses = new Map();
    this.messageQueue = new MessageQueue(this.processMessage.bind(this));
    this.messageHistory = [];
    this.subscriptions = new Map();
  }

  sendMessage(sender, receiver, type, content, metadata = {}) {
    const message = new Message(sender, receiver, type, content, metadata);
    this.messageQueue.enqueue(message);
    this.messageHistory.push(message);
    return message;
  }

  sendRequest(sender, receiver, content, metadata = {}) {
    const requestId = metadata.request_id || `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    return this.sendMessage(sender, receiver, "request", content, {
      ...metadata,
      request_id: requestId
    });
  }

  sendResponse(sender, receiver, content, metadata = {}) {
    const correlationId = metadata.correlation_id || metadata.request_id || null;
    return this.sendMessage(sender, receiver, "response", content, {
      ...metadata,
      correlation_id: correlationId
    });
  }

  sendNotification(sender, receiver, content, metadata = {}) {
    return this.sendMessage(sender, receiver, "notification", content, metadata);
  }

  sendError(sender, receiver, content, metadata = {}) {
    const correlationId = metadata.correlation_id || metadata.request_id || null;
    return this.sendMessage(sender, receiver, "error", content, {
      ...metadata,
      correlation_id: correlationId
    });
  }

  subscribe(role, callback) {
    if (!this.subscriptions.has(role)) {
      this.subscriptions.set(role, []);
    }
    this.subscriptions.get(role).push(callback);
  }

  unsubscribe(role, callback) {
    if (this.subscriptions.has(role)) {
      const callbacks = this.subscriptions.get(role);
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  waitForResponse(requestId, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(requestId);
        reject(new Error(`Timed out waiting for response to request ${requestId}`));
      }, timeoutMs);

      this.pendingResponses.set(requestId, {
        resolve: (message) => {
          clearTimeout(timeout);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }

  async requestResponse(sender, receiver, content, metadata = {}) {
    const request = this.sendRequest(sender, receiver, content, metadata);
    const response = await this.waitForResponse(request.metadata.request_id, metadata.timeout_ms || 15000);
    return { request, response };
  }

  async requestToolCreation(sender, receiver, toolSpecs, metadata = {}) {
    return this.requestResponse(sender, receiver, {
      request_type: "tool_creation",
      tool_specs: toolSpecs
    }, metadata);
  }

  respondToolCreation(sender, receiver, requestId, content, metadata = {}) {
    return this.sendResponse(sender, receiver, {
      request_type: "tool_creation_result",
      ...content
    }, {
      ...metadata,
      correlation_id: requestId
    });
  }

  async processMessage(message) {
    const correlationId = message.metadata?.correlation_id;
    if ((message.type === "response" || message.type === "error") && correlationId && this.pendingResponses.has(correlationId)) {
      const pending = this.pendingResponses.get(correlationId);
      this.pendingResponses.delete(correlationId);
      pending.resolve(message);
    }

    const role = message.receiver;
    if (this.subscriptions.has(role)) {
      const callbacks = this.subscriptions.get(role);
      for (const callback of callbacks) {
        try {
          await callback(message);
        } catch (error) {
          console.error("Error processing message callback:", error);
        }
      }
    }
  }

  getMessageHistory() {
    return this.messageHistory;
  }

  getMessageStats() {
    const stats = {
      total: this.messageHistory.length,
      byType: {},
      byStatus: {},
      bySender: {},
      byReceiver: {}
    };

    for (const message of this.messageHistory) {
      stats.byType[message.type] = (stats.byType[message.type] || 0) + 1;
      stats.byStatus[message.status] = (stats.byStatus[message.status] || 0) + 1;
      stats.bySender[message.sender] = (stats.bySender[message.sender] || 0) + 1;
      stats.byReceiver[message.receiver] = (stats.byReceiver[message.receiver] || 0) + 1;
    }

    return stats;
  }

  clearMessageHistory() {
    this.messageHistory = [];
    this.pendingResponses.clear();
    this.messageQueue.clear();
  }
}

const agentCommunication = new AgentCommunication();

module.exports = {
  Message,
  MessageQueue,
  AgentCommunication,
  agentCommunication
};

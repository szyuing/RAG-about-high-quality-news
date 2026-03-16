const { AgentStatus } = require("./agents");

function createRuntimeTaskId(agentId, taskType) {
  return `${agentId}:${taskType}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function createAgentRegistry() {
  return {
    supervisor: {
      id: "supervisor",
      prompt: "Plan rounds, dispatch specialist tasks, and enforce stop policy."
    },
    web_researcher: {
      id: "web_researcher",
      prompt: "Discover breadth-first source candidates and return structured candidate cards."
    },
    video_parser: {
      id: "video_parser",
      prompt: "Parse video sources into normalized Markdown, transcripts, timelines, and key evidence."
    },
    long_text_collector: {
      id: "long_text_collector",
      prompt: "Read long-form pages or documents and return normalized Markdown evidence units."
    },
    chart_parser: {
      id: "chart_parser",
      prompt: "Parse chart-heavy documents and multimodal pages into Markdown, visual observations, and structured facts."
    },
    table_parser: {
      id: "table_parser",
      prompt: "Extract tables and spreadsheet-like evidence into normalized JSON and Markdown previews."
    },
    fact_verifier: {
      id: "fact_verifier",
      prompt: "Compare conflicting evidence and explain which source is more credible and why."
    },
    synthesizer: {
      id: "synthesizer",
      prompt: "Assemble the final evidence-backed answer with uncertainty and conflicts."
    }
  };
}

function createAgentRuntime(agentRegistry) {
  const agents = {};
  for (const [agentId, config] of Object.entries(agentRegistry || {})) {
    agents[agentId] = {
      id: config.id || agentId,
      prompt: config.prompt || "",
      status: AgentStatus.IDLE,
      current_task_id: null,
      inbox: [],
      outbox: [],
      completed_tasks: 0,
      failed_tasks: 0,
      last_result: null,
      last_error: null,
      last_updated_at: new Date().toISOString()
    };
  }

  return {
    agents,
    tasks: [],
    messages: []
  };
}

function pushRuntimeMessage(runtime, message) {
  const entry = {
    id: `msg:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    ...message
  };
  runtime.messages.push(entry);

  if (entry.to && runtime.agents[entry.to]) {
    runtime.agents[entry.to].inbox.push(entry);
    runtime.agents[entry.to].last_updated_at = entry.at;
  }
  if (entry.from && runtime.agents[entry.from]) {
    runtime.agents[entry.from].outbox.push(entry);
    runtime.agents[entry.from].last_updated_at = entry.at;
  }

  return entry;
}

function dispatchAgentTask(runtime, { from = "supervisor", agentId, taskType, input = null, metadata = {} }) {
  if (!runtime?.agents?.[agentId]) {
    throw new Error(`Unknown runtime agent: ${agentId}`);
  }

  const now = new Date().toISOString();
  const task = {
    id: createRuntimeTaskId(agentId, taskType),
    agent_id: agentId,
    from,
    task_type: taskType,
    status: "running",
    input,
    metadata,
    created_at: now,
    updated_at: now,
    result: null,
    error: null
  };

  runtime.tasks.push(task);
  runtime.agents[agentId].status = AgentStatus.RUNNING;
  runtime.agents[agentId].current_task_id = task.id;
  runtime.agents[agentId].last_error = null;
  runtime.agents[agentId].last_updated_at = task.updated_at;

  pushRuntimeMessage(runtime, {
    type: "task_dispatched",
    from,
    to: agentId,
    task_id: task.id,
    task_type: taskType,
    metadata
  });

  return task;
}

function completeAgentTask(runtime, taskId, result = null, metadata = {}) {
  const task = runtime?.tasks?.find((item) => item.id === taskId);
  if (!task) {
    throw new Error(`Unknown runtime task: ${taskId}`);
  }

  task.status = "completed";
  task.result = result;
  task.metadata = { ...task.metadata, ...metadata };
  task.updated_at = new Date().toISOString();

  const agent = runtime.agents[task.agent_id];
  agent.status = AgentStatus.COMPLETED;
  agent.current_task_id = null;
  agent.completed_tasks += 1;
  agent.last_result = result;
  agent.last_updated_at = task.updated_at;

  pushRuntimeMessage(runtime, {
    type: "task_completed",
    from: task.agent_id,
    to: task.from,
    task_id: task.id,
    task_type: task.task_type,
    metadata
  });

  return task;
}

function failAgentTask(runtime, taskId, error, metadata = {}) {
  const task = runtime?.tasks?.find((item) => item.id === taskId);
  if (!task) {
    throw new Error(`Unknown runtime task: ${taskId}`);
  }

  task.status = "failed";
  task.error = typeof error === "string" ? error : error?.message || "unknown error";
  task.metadata = { ...task.metadata, ...metadata };
  task.updated_at = new Date().toISOString();

  const agent = runtime.agents[task.agent_id];
  agent.status = AgentStatus.FAILED;
  agent.current_task_id = null;
  agent.failed_tasks += 1;
  agent.last_error = task.error;
  agent.last_updated_at = task.updated_at;

  pushRuntimeMessage(runtime, {
    type: "task_failed",
    from: task.agent_id,
    to: task.from,
    task_id: task.id,
    task_type: task.task_type,
    metadata: {
      ...metadata,
      error: task.error
    }
  });

  return task;
}

function getAgentRuntimeSnapshot(runtime) {
  return {
    tasks: runtime.tasks.map((task) => ({
      id: task.id,
      agent_id: task.agent_id,
      from: task.from,
      task_type: task.task_type,
      status: task.status,
      created_at: task.created_at,
      updated_at: task.updated_at,
      metadata: task.metadata
    })),
    agents: Object.values(runtime.agents).map((agent) => ({
      id: agent.id,
      status: agent.status,
      current_task_id: agent.current_task_id,
      completed_tasks: agent.completed_tasks,
      failed_tasks: agent.failed_tasks,
      inbox_count: agent.inbox.length,
      outbox_count: agent.outbox.length,
      last_updated_at: agent.last_updated_at
    })),
    messages: runtime.messages.slice(-30)
  };
}

module.exports = {
  createAgentRegistry,
  createAgentRuntime,
  dispatchAgentTask,
  completeAgentTask,
  failAgentTask,
  getAgentRuntimeSnapshot
};

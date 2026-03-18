const DEFAULT_TOOL_MAX_ATTEMPTS = Math.max(1, Number(process.env.OPENSEARCH_TOOL_MAX_ATTEMPTS || 2));
const DEFAULT_TOOL_RETRY_BASE_MS = Math.max(50, Number(process.env.OPENSEARCH_TOOL_RETRY_BASE_MS || 250));

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyToolExecutionError(error) {
  const message = String(error?.message || error || "unknown error");
  const statusCode = Number(error?.statusCode || error?.status || error?.response?.status || 0) || null;

  if (/missing required parameter|either .* is required|must be a string|validation/i.test(message)) {
    return { type: "validation_error", retriable: false, statusCode };
  }
  if (/deprecated|tool not found|unsupported source tool action/i.test(message)) {
    return { type: "configuration_error", retriable: false, statusCode };
  }
  if (statusCode === 401 || statusCode === 403 || /unauthorized|forbidden|api key|access denied/i.test(message)) {
    return { type: "authentication_error", retriable: false, statusCode };
  }
  if (statusCode === 404 || /not found|404/i.test(message)) {
    return { type: "not_found", retriable: false, statusCode };
  }
  if (statusCode === 429 || /rate limit|too many requests/i.test(message)) {
    return { type: "rate_limit", retriable: true, statusCode };
  }
  if (/timeout|timed out|AbortError/i.test(message)) {
    return { type: "timeout", retriable: true, statusCode };
  }
  if (/ECONNRESET|ENOTFOUND|EAI_AGAIN|network|fetch failed|socket hang up/i.test(message)) {
    return { type: "network_error", retriable: true, statusCode };
  }
  if (/unsupported connector|unsupported|not implemented/i.test(message)) {
    return { type: "unsupported_source", retriable: false, statusCode };
  }
  if (statusCode >= 500 || /internal server error|bad gateway|service unavailable|upstream/i.test(message)) {
    return { type: "upstream_service_error", retriable: true, statusCode };
  }
  if (/parse|invalid json|malformed/i.test(message)) {
    return { type: "parse_error", retriable: false, statusCode };
  }

  return { type: "unknown", retriable: false, statusCode };
}

function inferFallbackTask(toolId, input, options, normalizeCapability) {
  if (options?.task && typeof options.task === "object") {
    return {
      ...options.task,
      preferred_tool_id: options.task.preferred_tool_id || options.task.preferredToolId || toolId,
      candidate: options.task.candidate || input?.candidate || null
    };
  }

  const candidate = options?.candidate || input?.candidate || null;
  const requestedCapability = normalizeCapability(options?.capability || "");
  const contentType = String(candidate?.content_type || candidate?.source_type || "").toLowerCase();
  const inferredAgent = options?.agent || (() => {
    if (contentType === "video") {
      return "video_parser";
    }
    if (contentType === "forum") {
      return "fact_verifier";
    }
    if (contentType === "document") {
      return "chart_parser";
    }
    return "long_text_collector";
  })();
  const capability = requestedCapability || (() => {
    if (toolId === "extract_video_intel") {
      return "parse_video";
    }
    if (toolId === "cross_check_facts") {
      return "verify_facts";
    }
    if (toolId === "layout_analysis") {
      return "analyze_document_layout";
    }
    if (toolId === "analyze_document_multimodal") {
      return "analyze_visual_document";
    }
    if (toolId === "read_document_intel" || contentType === "document") {
      return "read_document";
    }
    return "read_web_page";
  })();

  return {
    agent: inferredAgent,
    capability,
    candidate,
    preferred_tool_id: toolId
  };
}

function createToolRegistry(deps = {}) {
  const { normalizeCapability, scoreToolForTask } = deps;

  if (typeof normalizeCapability !== "function") {
    throw new Error("createToolRegistry requires normalizeCapability");
  }
  if (typeof scoreToolForTask !== "function") {
    throw new Error("createToolRegistry requires scoreToolForTask");
  }

  return {
    tools: new Map(),
    toolVersions: new Map(),
    toolAliases: new Map(),
    lifecycleEvents: [],

    registerTool(toolDefinition) {
      if (!toolDefinition.id) {
        throw new Error("Tool must have an id");
      }
      if (!toolDefinition.name) {
        throw new Error("Tool must have a name");
      }
      if (!toolDefinition.execute) {
        throw new Error("Tool must have an execute function");
      }

      const baseToolId = toolDefinition.base_tool_id || toolDefinition.id;
      const version = String(toolDefinition.version || "1.0.0");
      const registeredAt = new Date().toISOString();
      const existingActive = this.tools.get(toolDefinition.id);
      const normalized = {
        id: toolDefinition.id,
        name: toolDefinition.name,
        description: toolDefinition.description || "",
        parameters: toolDefinition.parameters || [],
        execute: toolDefinition.execute,
        validate: toolDefinition.validate || null,
        inputSchema: toolDefinition.inputSchema || null,
        outputSchema: toolDefinition.outputSchema || null,
        base_tool_id: baseToolId,
        version,
        status: toolDefinition.status || "active",
        source: toolDefinition.source || "builtin",
        created_by: toolDefinition.created_by || null,
        created_for: toolDefinition.created_for || null,
        promoted_to_builtin: Boolean(toolDefinition.promoted_to_builtin),
        replaced_by: null,
        supersedes: toolDefinition.supersedes || existingActive?.id || null,
        request_id: toolDefinition.request_id || null,
        registered_at: registeredAt,
        runtime: toolDefinition.runtime || "node",
        site_scope: toolDefinition.site_scope || null,
        safety_level: toolDefinition.safety_level || "restricted",
        implementation_plan: toolDefinition.implementation_plan || null,
        lifecycle_state:
          toolDefinition.lifecycle_state
          || (toolDefinition.status === "candidate"
            ? "candidate"
            : (toolDefinition.status === "ephemeral" ? "ephemeral" : "registered")),
        verifier_verdict: toolDefinition.verifier_verdict || null,
        last_verified_at: toolDefinition.last_verified_at || null,
        code_hash: toolDefinition.code_hash || null,
        spec_hash: toolDefinition.spec_hash || null
      };

      if (existingActive && existingActive.id !== normalized.id) {
        existingActive.status = "superseded";
        existingActive.replaced_by = normalized.id;
        this.lifecycleEvents.push({
          type: "superseded",
          tool_id: existingActive.id,
          base_tool_id: baseToolId,
          replaced_by: normalized.id,
          at: registeredAt
        });
      }

      this.tools.set(toolDefinition.id, normalized);
      this.toolAliases.set(baseToolId, toolDefinition.id);

      const history = this.toolVersions.get(baseToolId) || [];
      history.push(normalized);
      this.toolVersions.set(baseToolId, history);
      this.lifecycleEvents.push({
        type: "registered",
        tool_id: normalized.id,
        base_tool_id: baseToolId,
        version,
        at: registeredAt
      });
    },

    getTool(toolId) {
      const resolvedId = this.toolAliases.get(toolId) || toolId;
      return this.tools.get(resolvedId);
    },

    getTools() {
      return Array.from(this.tools.values());
    },

    getToolHistory(toolId) {
      const current = this.getTool(toolId);
      const baseToolId = current?.base_tool_id || toolId;
      return (this.toolVersions.get(baseToolId) || []).map((item) => ({ ...item }));
    },

    deprecateTool(toolId, reason = "deprecated") {
      const tool = this.getTool(toolId);
      if (!tool) {
        throw new Error(`Tool not found: ${toolId}`);
      }
      tool.status = "deprecated";
      tool.deprecated_at = new Date().toISOString();
      tool.deprecation_reason = reason;
      this.lifecycleEvents.push({
        type: "deprecated",
        tool_id: tool.id,
        base_tool_id: tool.base_tool_id,
        reason,
        at: tool.deprecated_at
      });
      return { ...tool };
    },

    rollbackTool(toolId, targetToolId = null) {
      const current = this.getTool(toolId);
      if (!current) {
        throw new Error(`Tool not found: ${toolId}`);
      }

      const history = this.toolVersions.get(current.base_tool_id) || [];
      const target = targetToolId
        ? history.find((item) => item.id === targetToolId)
        : [...history].reverse().find((item) => item.id !== current.id && item.status !== "deprecated");

      if (!target) {
        throw new Error(`No rollback target found for ${toolId}`);
      }

      current.status = "superseded";
      current.replaced_by = target.id;
      target.status = "active";
      target.reactivated_at = new Date().toISOString();
      this.toolAliases.set(current.base_tool_id, target.id);
      this.lifecycleEvents.push({
        type: "rolled_back",
        tool_id: current.id,
        base_tool_id: current.base_tool_id,
        target_tool_id: target.id,
        at: target.reactivated_at
      });
      return { active: { ...target }, previous: { ...current } };
    },

    promoteTool(toolId, reason = "promoted_to_builtin_candidate") {
      const tool = this.getTool(toolId);
      if (!tool) {
        throw new Error(`Tool not found: ${toolId}`);
      }
      tool.promoted_to_builtin = true;
      tool.promotion_reason = reason;
      tool.promoted_at = new Date().toISOString();
      this.lifecycleEvents.push({
        type: "promoted",
        tool_id: tool.id,
        base_tool_id: tool.base_tool_id,
        reason,
        at: tool.promoted_at
      });
      return { ...tool };
    },

    getLifecycleEvents(toolId = null) {
      if (!toolId) {
        return this.lifecycleEvents.map((item) => ({ ...item }));
      }
      const current = this.getTool(toolId);
      const baseToolId = current?.base_tool_id || toolId;
      return this.lifecycleEvents
        .filter((item) => item.base_tool_id === baseToolId || item.tool_id === toolId)
        .map((item) => ({ ...item }));
    },

    resolveToolForTask(task = {}) {
      const ranked = this.getTools()
        .map((tool) => ({
          tool,
          score: scoreToolForTask(tool, task)
        }))
        .filter((item) => item.score >= 0)
        .sort((left, right) => right.score - left.score);

      const preferredToolId = task.preferred_tool_id || task.preferredToolId || null;
      const preferredTool = preferredToolId ? this.getTool(preferredToolId) : null;
      if (preferredTool && preferredTool.status !== "deprecated") {
        return {
          tool_id: preferredTool.id,
          capability: normalizeCapability(task.capability),
          reason: preferredToolId === task.capability
            ? "matched_requested_tool_id"
            : "matched_preferred_tool",
          tool: { ...preferredTool },
          alternatives: ranked
            .filter((item) => item.tool.id !== preferredTool.id)
            .slice(0, 3)
            .map((item) => ({
              tool_id: item.tool.id,
              score: item.score
            }))
        };
      }

      const best = ranked[0];
      if (!best || best.score <= 0) {
        return null;
      }

      return {
        tool_id: best.tool.id,
        capability: normalizeCapability(task.capability),
        reason: "matched_tool_capability",
        tool: { ...best.tool },
        alternatives: ranked.slice(1, 3).map((item) => ({
          tool_id: item.tool.id,
          score: item.score
        }))
      };
    },

    async executeTool(toolId, input, options = {}) {
      const requestedTool = this.getTool(toolId);
      if (!requestedTool) {
        throw new Error(`Tool not found: ${toolId}`);
      }

      const maxAttempts = Math.max(1, Number(options.maxAttempts || DEFAULT_TOOL_MAX_ATTEMPTS));
      const retryBaseMs = Math.max(10, Number(options.retryBaseMs || DEFAULT_TOOL_RETRY_BASE_MS));
      const allowRetry = options.allowRetry !== false;
      const allowFallback = options.allowFallback !== false;
      const attempts = [];
      const fallbackChain = [];
      const visited = new Set();
      const queue = [requestedTool.id];

      if (Array.isArray(options.fallbackToolIds)) {
        for (const fallbackToolId of options.fallbackToolIds.filter(Boolean)) {
          if (fallbackToolId !== requestedTool.id) {
            queue.push(fallbackToolId);
          }
        }
      }

      if (allowFallback) {
        const fallbackTask = inferFallbackTask(requestedTool.id, input, options, normalizeCapability);
        const resolution = this.resolveToolForTask(fallbackTask);
        for (const alternative of resolution?.alternatives || []) {
          if (alternative.tool_id !== requestedTool.id) {
            queue.push(alternative.tool_id);
          }
        }
      }

      let lastFailure = null;
      while (queue.length) {
        const activeToolId = queue.shift();
        if (!activeToolId || visited.has(activeToolId)) {
          continue;
        }
        visited.add(activeToolId);

        const activeTool = this.getTool(activeToolId);
        if (!activeTool) {
          continue;
        }

        if (activeToolId !== requestedTool.id) {
          fallbackChain.push(activeToolId);
        }

        for (let attemptIndex = 1; attemptIndex <= maxAttempts; attemptIndex += 1) {
          try {
            if (activeTool.status === "deprecated") {
              throw new Error(`Tool is deprecated: ${activeTool.id}`);
            }
            this.validateToolInput(activeToolId, input);
            const result = await activeTool.execute(input);
            return {
              success: true,
              data: result,
              toolId: activeToolId,
              requestedToolId: requestedTool.id,
              timestamp: new Date().toISOString(),
              meta: {
                attempts,
                fallback_chain: fallbackChain,
                retries_used: attempts.filter((item) => item.tool_id === activeToolId).length,
                fallback_used: activeToolId !== requestedTool.id
              }
            };
          } catch (error) {
            const classification = classifyToolExecutionError(error);
            const failure = {
              tool_id: activeToolId,
              attempt: attemptIndex,
              error_type: classification.type,
              retriable: classification.retriable,
              message: error.message,
              status_code: classification.statusCode,
              timestamp: new Date().toISOString()
            };
            attempts.push(failure);
            lastFailure = { error, classification, toolId: activeToolId };

            if (allowRetry && classification.retriable && attemptIndex < maxAttempts) {
              await wait(retryBaseMs * attemptIndex);
              continue;
            }
            break;
          }
        }
      }

      return {
        success: false,
        error: {
          message: lastFailure?.error?.message || `Tool execution failed: ${requestedTool.id}`,
          stack: lastFailure?.error?.stack,
          type: lastFailure?.classification?.type || "unknown"
        },
        toolId: lastFailure?.toolId || requestedTool.id,
        requestedToolId: requestedTool.id,
        timestamp: new Date().toISOString(),
        meta: {
          attempts,
          fallback_chain: fallbackChain,
          fallback_used: Boolean(fallbackChain.length),
          final_error_type: lastFailure?.classification?.type || "unknown"
        }
      };
    },

    validateToolInput(toolId, input) {
      const tool = this.getTool(toolId);
      if (!tool) {
        throw new Error(`Tool not found: ${toolId}`);
      }

      const payload = input && typeof input === "object" ? input : {};
      for (const param of tool.parameters) {
        if (param.required && !Object.prototype.hasOwnProperty.call(payload, param.name)) {
          throw new Error(`Missing required parameter: ${param.name}`);
        }
      }

      if (typeof tool.validate === "function") {
        tool.validate(payload);
      }

      return true;
    },

    getToolCapabilities() {
      return this.getTools().map((tool) => ({
        id: tool.id,
        base_tool_id: tool.base_tool_id,
        version: tool.version,
        status: tool.status,
        lifecycle_state: tool.lifecycle_state || null,
        source: tool.source,
        promoted_to_builtin: tool.promoted_to_builtin,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        hasInputSchema: !!tool.inputSchema,
        hasOutputSchema: !!tool.outputSchema,
        verifier_verdict: tool.verifier_verdict || null
      }));
    },

    testTool(toolId, testInput) {
      const tool = this.getTool(toolId);
      if (!tool) {
        return { success: false, error: `Tool not found: ${toolId}` };
      }

      try {
        this.validateToolInput(toolId, testInput);
        return { success: true, message: "Input validation passed" };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  };
}

module.exports = {
  createToolRegistry
};

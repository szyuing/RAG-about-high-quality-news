const { invokeSourceTool, ToolRegistry } = require("./source-connectors");
const { createEvidenceUnit, scoreQuestionCoverage } = require("./evidence-model");
const { synthesizeTool, runEphemeralTool } = require("./ephemeral-tooling");
const {
  dispatchAgentTask,
  completeAgentTask,
  failAgentTask
} = require("./agent-runtime");

function dedupeBy(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item);
    const current = map.get(key);
    if (!current || (item.score || 0) > (current.score || 0)) {
      map.set(key, item);
    }
  }
  return Array.from(map.values());
}

function buildToolCreationGoal(candidate, error) {
  const contentType = candidate.content_type || candidate.source_type || "web";
  return `Recover a failed ${contentType} read for ${candidate.url} after ${error.message}`;
}

function buildToolCreationConstraints(candidate, error) {
  return [
    "Use the existing ephemeral tooling execution path.",
    "Return a normalized read object compatible with createEvidenceUnit.",
    `Target connector: ${candidate.connector || "unknown"}`,
    `Original failure: ${error.message}`
  ];
}

function createRecoveredRead(candidate, execution, toolId) {
  const data = execution.extracted_data || {};
  const contentType = candidate.content_type || candidate.source_type || "web";
  const timeline = data.timeline || [];
  const transcript = data.transcript || [];
  const keyPoints = data.key_points || data.paragraphs || [];
  const markdown = data.markdown || [
    `# ${data.title || candidate.title || "Recovered source"}`,
    data.description || "",
    ...(data.paragraphs || [])
  ].filter(Boolean).join("\n\n");

  return {
    source_id: candidate.id,
    content_type: contentType,
    source_type: contentType,
    tool: toolId,
    title: data.title || candidate.title,
    url: candidate.url,
    author: data.author || candidate.author || null,
    published_at: data.published_at || candidate.published_at || null,
    duration: data.duration || null,
    markdown,
    timeline,
    transcript,
    key_points: keyPoints.slice(0, 6),
    key_frames: data.key_frames || timeline.slice(0, 3).map((item) => item.summary || item.title).filter(Boolean),
    facts: []
  };
}

async function attemptToolCreationRecovery(agent, candidate, error, telemetry, runtime = null, runtimeTask = null) {
  const agentSystem = telemetry?.agent_system;
  if (!agentSystem || typeof agentSystem.requestToolCreation !== "function") {
    return null;
  }

  const toolSpec = {
    name: `Recovery Tool ${candidate.connector || agent}`,
    description: `Recover failed ${candidate.content_type || candidate.source_type || "source"} reads for ${candidate.url}`,
    parameters: [
      {
        name: "candidate",
        type: "object",
        required: true,
        description: "Source candidate requiring recovery"
      }
    ],
    implementation: async (input) => {
      const targetCandidate = input?.candidate || candidate;
      const tool = await synthesizeTool({
        goal: buildToolCreationGoal(targetCandidate, error),
        target: {
          url: targetCandidate.url,
          title: targetCandidate.title,
          platform: targetCandidate.platform,
          connector: targetCandidate.connector,
          content_type: targetCandidate.content_type || targetCandidate.source_type
        },
        constraints: buildToolCreationConstraints(targetCandidate, error)
      });
      const execution = await runEphemeralTool(tool, {
        timeout_ms: 15000,
        network: true
      });
      if (!execution.success) {
        throw new Error(execution.error || "recovery tool failed");
      }
      return createRecoveredRead(targetCandidate, execution, tool.tool_id);
    }
  };

  const response = await agentSystem.requestToolCreation(agent, [toolSpec], {
    purpose: `Recover failed source read for ${candidate.url}`,
    timeout_ms: 15000
  });

  const createdTool = response?.tools?.[0];
  if (!createdTool?.id) {
    return null;
  }

  telemetry.tool_creation_requests = telemetry.tool_creation_requests || [];
  telemetry.tool_creation_requests.push({
    agent,
    candidate_id: candidate.id,
    tool_id: createdTool.id,
    created_for: createdTool.created_for,
    request_id: createdTool.request_id
  });

  const recoveryExecution = await ToolRegistry.executeTool(createdTool.id, { candidate });
  if (!recoveryExecution.success) {
    throw new Error(recoveryExecution.error?.message || "tool-created recovery failed");
  }

  if (runtimeTask) {
    completeAgentTask(runtime, runtimeTask.id, {
      source_id: candidate.id,
      tool: createdTool.id,
      recovered_via: "tool_creation_request"
    });
  }

  return {
    candidate,
    read: recoveryExecution.data,
    recovered_by: createdTool.id
  };
}

function isChartHeavyCandidate(candidate) {
  const contentType = candidate.content_type || candidate.source_type;
  if (contentType !== "document") {
    return false;
  }

  const documentKind = String(candidate.metadata?.mime_type || candidate.metadata?.content_type || candidate.url || "").toLowerCase();
  if (/pdf|xlsx|xls|spreadsheet|chart|dashboard/.test(documentKind)) {
    return true;
  }
  if (candidate.metadata?.page_images?.length || candidate.metadata?.preview_image) {
    return true;
  }

  const blob = `${candidate.title || ""} ${candidate.summary || ""}`.toLowerCase();
  return /chart|graph|figure|dashboard|tableau|plot|trend/.test(blob);
}

function routeCandidate(candidate) {
  const contentType = candidate.content_type || candidate.source_type;
  if (contentType === "video") {
    return "video_parser";
  }
  if (contentType === "forum") {
    return "fact_verifier";
  }
  if (isChartHeavyCandidate(candidate)) {
    return "chart_parser";
  }
  return "long_text_collector";
}

function collectorToolForCandidate(candidate) {
  const agent = routeCandidate(candidate);
  if (agent === "video_parser") {
    return "extract_video_intel";
  }
  if (agent === "chart_parser") {
    return "read_document_intel";
  }
  return "deep_read_page";
}

function collectorCapabilityForTask(agent, candidate) {
  if (agent === "video_parser") {
    return "parse_video";
  }
  if (agent === "chart_parser") {
    return "parse_chart_document";
  }
  if (agent === "table_parser") {
    return "parse_table";
  }
  if (agent === "fact_verifier") {
    return "verify_facts";
  }

  const contentType = candidate?.content_type || candidate?.source_type;
  if (contentType === "document") {
    return "read_document";
  }
  return "read_web_page";
}

function mergeUniqueStrings(values, limit = 6) {
  return Array.from(new Set((values || []).filter(Boolean))).slice(0, limit);
}

function buildTableFacts(tableData, sourceId, subjectHint) {
  const rows = tableData?.rows || [];
  const headers = tableData?.headers || Object.keys(rows[0] || {});

  return rows.slice(0, 5).map((row, index) => ({
    source_id: sourceId,
    subject: subjectHint,
    kind: "table_row",
    claim: `Table row ${index + 1}: ${headers.map((header) => `${header}=${row[header] || ""}`).join(", ")}`,
    value: null,
    unit: null,
    evidence: JSON.stringify(row)
  }));
}

function buildDocumentTaskToolInput(candidate, baseRead, task) {
  return {
    candidate,
    read: baseRead,
    markdown: baseRead.markdown,
    page_images: baseRead.page_images || [],
    table_data: baseRead.table_data || null,
    layout_task: task
  };
}

function resolveDocumentTaskPreferredTool(task, baseRead) {
  if (task.agent === "chart_parser" && (baseRead.page_images?.length || baseRead.visual_observations?.length)) {
    return "analyze_document_multimodal";
  }
  return "read_document_intel";
}

function buildTaskScopedRead(baseRead, candidate, task, toolId, toolData = null) {
  const taskId = task?.task_id || `${candidate.id}:${task.agent}`;
  const pageLabel = Array.isArray(task?.pages) ? task.pages.join("-") : "unknown";
  const toolResult = toolData && typeof toolData === "object" ? toolData : {};
  const sharedBase = {
    ...baseRead,
    tool: toolId || baseRead.tool,
    parent_source_id: candidate.id,
    segment_pages: task.pages || [],
    parser_task_id: taskId
  };

  if (task.agent === "table_parser") {
    const tableData = toolResult.table_data || baseRead.table_data || { headers: [], rows: [] };
    const tableRows = tableData.rows || [];
    const headers = tableData.headers || Object.keys(tableRows[0] || {});
    return {
      ...sharedBase,
      source_id: `${candidate.id}::table::${pageLabel}`,
      title: `${candidate.title} Table Segment`,
      markdown: [
        "# Table Segment",
        "",
        `Pages: ${pageLabel}`,
        "",
        `Columns: ${headers.join(", ") || "none"}`,
        "",
        JSON.stringify(tableRows.slice(0, 10), null, 2)
      ].join("\n"),
      key_points: mergeUniqueStrings([
        `Extracted ${tableRows.length} table rows`,
        ...(headers.length ? [`Columns: ${headers.join(", ")}`] : [])
      ]),
      sections: [
        {
          heading: "Table Segment",
          excerpt: `Extracted ${tableRows.length} rows from pages ${pageLabel}.`
        }
      ],
      table_data: tableData,
      facts: buildTableFacts(tableData, `${candidate.id}::table::${pageLabel}`, candidate.title || "document table"),
      visual_observations: [],
      page_images: [],
      parser_agent: "table_parser"
    };
  }

  if (task.agent === "chart_parser") {
    const visualObservations = mergeUniqueStrings([
      ...(toolResult.visual_observations || []),
      ...(baseRead.visual_observations || [])
    ], 4);
    const visualFacts = (toolResult.structured_facts || []).slice(0, 4).map((item) => ({
      source_id: `${candidate.id}::visual::${pageLabel}`,
      subject: item.subject,
      kind: "visual_document_fact",
      claim: item.claim,
      value: item.value,
      unit: item.unit || null,
      evidence: item.claim
    }));
    return {
      ...sharedBase,
      source_id: `${candidate.id}::visual::${pageLabel}`,
      title: `${candidate.title} Visual Segment`,
      markdown: [
        "# Visual Segment",
        "",
        `Pages: ${pageLabel}`,
        "",
        ...(toolResult.summary ? [`Summary: ${toolResult.summary}`, ""] : []),
        ...visualObservations.map((item) => `- ${item}`)
      ].join("\n"),
      key_points: mergeUniqueStrings([
        ...(toolResult.key_points || []),
        ...visualObservations,
        ...(baseRead.key_points || []).slice(0, 2)
      ]),
      sections: [
        {
          heading: "Visual Segment",
          excerpt: visualObservations[0] || toolResult.summary || task.objective || "Visual evidence extracted from document layout."
        }
      ],
      facts: visualFacts,
      visual_observations: visualObservations,
      parser_agent: "chart_parser"
    };
  }

  const sections = (baseRead.sections || []).slice(0, 6);
  return {
    ...sharedBase,
    source_id: `${candidate.id}::text::${pageLabel}`,
    title: `${candidate.title} Text Segment`,
    markdown: [
      "# Text Segment",
      "",
      `Pages: ${pageLabel}`,
      "",
      ...sections.map((section) => `## ${section.heading || "Section"}\n${section.excerpt || ""}`)
    ].join("\n"),
    key_points: mergeUniqueStrings(baseRead.key_points || [], 5),
    sections,
    facts: (baseRead.facts || []).slice(0, 6),
    visual_observations: [],
    page_images: [],
    parser_agent: "long_text_collector"
  };
}

async function runDocumentParsingTasks(candidate, telemetry, runtime, parentTask = null) {
  const baseExecution = await ToolRegistry.executeTool("read_document_intel", { candidate });
  if (!baseExecution.success) {
    throw new Error(baseExecution.error?.message || "read_document_intel failed");
  }

  const baseRead = baseExecution.data;
  const layoutExecution = await ToolRegistry.executeTool("layout_analysis", { candidate, read: baseRead });
  if (!layoutExecution.success) {
    throw new Error(layoutExecution.error?.message || "layout_analysis failed");
  }

  const layout = layoutExecution.data.layout || { task_suggestions: [] };
  const taskSuggestions = layout.task_suggestions?.length
    ? layout.task_suggestions
    : [{
        task_id: `${candidate.id}:task:text`,
        agent: "long_text_collector",
        capability: "read_document",
        pages: [1, layout.total_pages || 1],
        objective: "Summarize the document text sections and extract core claims."
      }];

  const parserResults = [];
  const routedTasks = [];
  for (const task of taskSuggestions) {
    const preferredToolId = resolveDocumentTaskPreferredTool(task, baseRead);
    const toolResolution = telemetry?.agent_system?.resolveToolForTask
      ? telemetry.agent_system.resolveToolForTask({
          agent: task.agent,
          capability: task.capability,
          candidate,
          preferred_tool_id: preferredToolId
        })
      : null;
    const toolId = toolResolution?.tool_id || preferredToolId;
    const runtimeTask = runtime
      ? dispatchAgentTask(runtime, {
          from: "supervisor",
          agentId: task.agent,
          taskType: `parse_document_${task.agent}`,
          input: {
            candidate,
            task
          },
          metadata: {
            source_id: candidate.id,
            pages: task.pages,
            modality: task.capability,
            tool: toolId
          }
        })
      : null;

    try {
      let taskToolData = null;
      if (toolId && toolId !== "read_document_intel") {
        const execution = await ToolRegistry.executeTool(toolId, buildDocumentTaskToolInput(candidate, baseRead, task));
        if (!execution.success) {
          throw new Error(execution.error?.message || `${toolId} failed`);
        }
        taskToolData = execution.data;
      }

      const read = buildTaskScopedRead(baseRead, candidate, task, toolId, taskToolData);
      const routedTask = {
        source_id: candidate.id,
        segment_source_id: read.source_id,
        agent: task.agent,
        tool: toolId,
        capability: task.capability,
        pages: task.pages,
        objective: task.objective,
        layout_analysis_mode: layoutExecution.data.layout_analysis_mode || "heuristic"
      };
      parserResults.push({
        candidate,
        read,
        evidence_unit: createEvidenceUnit(read, candidate),
        layout
      });
      routedTasks.push(routedTask);
      if (runtimeTask) {
        completeAgentTask(runtime, runtimeTask.id, {
          source_id: read.source_id,
          pages: task.pages,
          parser_agent: task.agent,
          tool: toolId
        });
      }
    } catch (error) {
      if (runtimeTask) {
        failAgentTask(runtime, runtimeTask.id, error, {
          source_id: candidate.id,
          parser_agent: task.agent
        });
      }
      throw error;
    }
  }

  if (parentTask) {
    completeAgentTask(runtime, parentTask.id, {
      source_id: candidate.id,
      parser_task_count: parserResults.length,
      layout_blocks: layout.blocks?.length || 0,
      layout_analysis_mode: layoutExecution.data.layout_analysis_mode || "heuristic"
    });
  }

  return {
    results: parserResults,
    layout,
    routed_tasks: routedTasks,
    layout_analysis_mode: layoutExecution.data.layout_analysis_mode || "heuristic"
  };
}

function scoreCandidateFit(candidate, question, plan) {
  let score = candidate.score || 0;
  const contentType = candidate.content_type || candidate.source_type;
  const preferred = plan.preferred_connectors || [];
  const preferredIndex = preferred.findIndex((item) => item.id === candidate.connector);

  if (preferredIndex !== -1) {
    score += Math.max(0.05, 0.24 - preferredIndex * 0.05);
  }
  if (/[\u4e00-\u9fff]/.test(question) && /segmentfault|bilibili|ithome|douyin/.test(candidate.connector || "")) {
    score += 0.1;
  }
  if (/最新|当前|发布|现在|动态|新闻/.test(question) && contentType === "web") {
    score += 0.12;
  }
  if (/教程|演讲|视频|访谈|体验|测评/.test(question) && contentType === "video") {
    score += 0.16;
  }

  return score;
}

function selectCandidates(candidates, question, plan) {
  const selected = [];
  const remaining = [...candidates].map((item) => ({
    ...item,
    selection_score: scoreCandidateFit(item, question, plan)
  }));

  while (selected.length < 4 && remaining.length) {
    const selectedConnectors = new Set(selected.map((item) => item.connector));
    const selectedContentTypes = new Set(selected.map((item) => item.content_type || item.source_type));
    const next = remaining
      .map((item) => ({
        ...item,
        final_score: item.selection_score
          + (selectedConnectors.has(item.connector) ? 0 : 0.08)
          + (selectedContentTypes.has(item.content_type || item.source_type) ? 0 : 0.05)
      }))
      .sort((left, right) => right.final_score - left.final_score)[0];

    selected.push(next);
    const index = remaining.findIndex((item) => item.url === next.url);
    if (index >= 0) {
      remaining.splice(index, 1);
    }
  }

  return selected;
}

function evaluateResearch(plan, scratchpad, evidenceUnits, verification, roundsCompleted) {
  const safeVerification = {
    confirmations: verification?.confirmations || [],
    conflicts: verification?.conflicts || [],
    coverage_gaps: verification?.coverage_gaps || []
  };
  const stopPolicy = plan.stop_policy || {};
  const sourceTypesCovered = new Set([
    ...evidenceUnits.map((item) => item.source_type).filter(Boolean),
    ...((scratchpad.sources_read || []).map((item) => item.content_type || item.source_type).filter(Boolean))
  ]);
  const overallCoverage = scoreQuestionCoverage(plan.task_goal, evidenceUnits);
  const hasEnoughDiversity = sourceTypesCovered.size >= (stopPolicy.min_source_types || 2);
  const hasEnoughEvidence = evidenceUnits.length >= (stopPolicy.min_evidence_items || 3);
  const resolvedQuestions = [];
  const missingQuestions = [];

  if (overallCoverage >= (stopPolicy.overall_coverage_threshold || 0.18) && hasEnoughDiversity && hasEnoughEvidence) {
    resolvedQuestions.push(...plan.sub_questions);
  } else {
    for (const question of plan.sub_questions) {
      const coverage = scoreQuestionCoverage(`${plan.task_goal} ${question}`, evidenceUnits);
      if (
        coverage >= (stopPolicy.sub_question_coverage_threshold || 0.18)
        || (hasEnoughEvidence && coverage >= (stopPolicy.fallback_sub_question_coverage_threshold || 0.12))
      ) {
        resolvedQuestions.push(question);
      } else {
        missingQuestions.push(question);
      }
    }
  }

  const hardConflict = safeVerification.conflicts.length > (stopPolicy.max_relevant_conflicts ?? 1);
  const isSufficient = (
    (stopPolicy.require_all_sub_questions === false ? resolvedQuestions.length > 0 : missingQuestions.length === 0)
    && hasEnoughDiversity
    && hasEnoughEvidence
    && !hardConflict
  );

  scratchpad.resolved_questions = resolvedQuestions;
  scratchpad.missing_questions = missingQuestions;
  scratchpad.conflicts_found = verification.conflicts;
  scratchpad.facts_collected = evidenceUnits.flatMap((item) => item.facts || []);

  return {
    is_sufficient: isSufficient,
    resolved_questions: resolvedQuestions,
    missing_questions: missingQuestions,
    risk_notes: [
      ...(!hasEnoughDiversity ? ["source type diversity is still insufficient"] : []),
      ...(safeVerification.conflicts.length ? ["conflicting evidence remains and must be disclosed"] : []),
      ...(safeVerification.coverage_gaps.length ? ["some conclusions still rely on a single source"] : [])
    ],
    next_best_action: isSufficient
      ? "synthesize_answer"
      : roundsCompleted >= (stopPolicy.max_rounds || 2)
        ? "stop_with_partial_answer"
        : "run_follow_up_search",
    reason: isSufficient
      ? "required questions are covered by enough evidence types"
      : "evidence is still missing, too narrow, or still conflicted",
    metrics: {
      source_types_covered: sourceTypesCovered.size,
      evidence_units: evidenceUnits.length,
      overall_coverage: Number(overallCoverage.toFixed(2)),
      conflict_count: safeVerification.conflicts.length,
      single_source_claims: safeVerification.coverage_gaps.length
    }
  };
}

async function runWebResearcher(plan, queries, telemetry, runtime = null) {
  const startedAt = Date.now();
  const queryReports = await Promise.all(queries.map(async (query) => {
    const runtimeTask = runtime
      ? dispatchAgentTask(runtime, {
          from: "supervisor",
          agentId: "web_researcher",
          taskType: "discover_sources",
          input: { query, connector_ids: plan.chosen_connector_ids },
          metadata: { query }
        })
      : null;
    try {
      const candidates = await invokeSourceTool({
        action: "discover",
        query,
        connector_ids: plan.chosen_connector_ids
      });
      if (runtimeTask) {
        completeAgentTask(runtime, runtimeTask.id, {
          query,
          candidate_count: candidates.length
        });
      }
      return { query, candidates, error: null };
    } catch (error) {
      if (runtimeTask) {
        failAgentTask(runtime, runtimeTask.id, error, { query });
      }
      return { query, candidates: [], error };
    }
  }));

  const failures = queryReports.filter((item) => item.error);
  for (const failure of failures) {
    telemetry.failures.push({
      stage: "discover",
      query: failure.query,
      reason: failure.error.message
    });
  }

  telemetry.events.push({
    stage: "web_researcher",
    duration_ms: Date.now() - startedAt,
    query_count: queries.length,
    result_count: queryReports.reduce((total, item) => total + item.candidates.length, 0)
  });

  return dedupeBy(queryReports.flatMap((item) => item.candidates), (item) => item.url)
    .sort((left, right) => right.score - left.score);
}

async function runSpecialistReads(selected, telemetry, runtime = null) {
  const longTextCandidates = selected.filter((item) => routeCandidate(item) === "long_text_collector");
  const videoCandidates = selected.filter((item) => routeCandidate(item) === "video_parser");
  const chartCandidates = selected.filter((item) => routeCandidate(item) === "chart_parser");
  const forumCandidates = selected.filter((item) => routeCandidate(item) === "fact_verifier");

  async function readGroup(agent, candidates) {
    const startedAt = Date.now();
    const settled = await Promise.all(candidates.map(async (candidate) => {
      const taskType = agent === "video_parser"
        ? "parse_video_source"
        : agent === "chart_parser"
          ? "parse_chart_source"
          : "collect_long_text";
      const runtimeTask = runtime
        ? dispatchAgentTask(runtime, {
            from: "supervisor",
            agentId: agent,
            taskType,
            input: { candidate },
            metadata: {
              source_id: candidate.id,
              connector: candidate.connector
            }
          })
        : null;
      try {
        if ((candidate.content_type === "document" || candidate.source_type === "document") && agent !== "fact_verifier") {
          const parsed = await runDocumentParsingTasks(candidate, telemetry, runtime, runtimeTask);
          return {
            candidate,
            reads: parsed.results.map((item) => item.read),
            evidence_units: parsed.results.map((item) => item.evidence_unit),
            layout: parsed.layout,
            routed_tasks: parsed.routed_tasks || [],
            error: null
          };
        }

        const preferredToolId = collectorToolForCandidate(candidate);
        const capability = collectorCapabilityForTask(agent, candidate);
        const toolResolution = telemetry?.agent_system?.resolveToolForTask
          ? telemetry.agent_system.resolveToolForTask({
              agent,
              capability,
              candidate,
              preferred_tool_id: preferredToolId
            })
          : null;
        const toolId = toolResolution?.tool_id || preferredToolId;
        const execution = await ToolRegistry.executeTool(toolId, { candidate });
        if (!execution.success) {
          throw new Error(execution.error?.message || `${toolId} failed`);
        }
        if (runtimeTask) {
          completeAgentTask(runtime, runtimeTask.id, {
            source_id: candidate.id,
            tool: toolId,
            capability
          });
        }
        return {
          candidate,
          reads: [execution.data],
          evidence_units: [createEvidenceUnit(execution.data, candidate)],
          routed_tasks: [{
            source_id: candidate.id,
            segment_source_id: execution.data.source_id,
            agent,
            tool: toolId,
            capability,
            pages: null,
            objective: null
          }],
          error: null
        };
      } catch (error) {
        try {
          const recovered = await attemptToolCreationRecovery(agent, candidate, error, telemetry, runtime, runtimeTask);
          if (recovered?.read) {
            return {
              candidate,
              reads: [recovered.read],
              evidence_units: [createEvidenceUnit(recovered.read, candidate)],
              routed_tasks: [{
                source_id: candidate.id,
                segment_source_id: recovered.read.source_id,
                agent,
                tool: recovered.recovered_by || recovered.read.tool || collectorToolForCandidate(candidate),
                capability: collectorCapabilityForTask(agent, candidate),
                pages: null,
                objective: "Recovered after tool creation"
              }],
              error: null,
              recovered_by: recovered.recovered_by
            };
          }
        } catch (recoveryError) {
          telemetry.failures.push({
            stage: `${agent}_tool_creation_recovery`,
            query: candidate.url,
            connector: candidate.connector,
            reason: recoveryError.message
          });
        }

        if (runtimeTask) {
          failAgentTask(runtime, runtimeTask.id, error, {
            source_id: candidate.id
          });
        }
        return { candidate, read: null, error };
      }
    }));

    telemetry.events.push({
      stage: agent,
      duration_ms: Date.now() - startedAt,
      task_count: candidates.length,
      success_count: settled.filter((item) => item.reads?.length).length
    });

    for (const failure of settled.filter((item) => item.error)) {
      telemetry.failures.push({
        stage: agent,
        query: failure.candidate.url,
        connector: failure.candidate.connector,
        reason: failure.error.message
      });
    }

    return {
      results: settled
        .filter((item) => item.reads?.length)
        .flatMap((item) => item.reads.map((read, index) => ({
          candidate: item.candidate,
          read,
          evidence_unit: item.evidence_units?.[index] || createEvidenceUnit(read, item.candidate),
          layout: item.layout || null
        }))),
      routed_tasks: settled.flatMap((item) => item.routed_tasks || []),
      failures: settled
        .filter((item) => item.error)
        .map((item) => ({
          agent,
          candidate: item.candidate,
          error: item.error
        }))
    };
  }

  const [longTextReads, videoReads, chartReads, forumReads] = await Promise.all([
    readGroup("long_text_collector", longTextCandidates),
    readGroup("video_parser", videoCandidates),
    readGroup("chart_parser", chartCandidates),
    readGroup("fact_verifier", forumCandidates)
  ]);

  return {
    results: [...longTextReads.results, ...videoReads.results, ...chartReads.results, ...forumReads.results],
    routed_tasks: [...longTextReads.routed_tasks, ...videoReads.routed_tasks, ...chartReads.routed_tasks, ...forumReads.routed_tasks],
    failures: [...longTextReads.failures, ...videoReads.failures, ...chartReads.failures, ...forumReads.failures]
  };
}

async function runFactVerifierReview(verification, telemetry, runtime = null) {
  const reviewItems = [
    ...(verification?.conflicts || []).map((item) => ({ kind: "conflict", item })),
    ...(verification?.coverage_gaps || []).map((item) => ({ kind: "coverage_gap", item }))
  ];

  const tasks = reviewItems.map(({ kind, item }) => {
    const runtimeTask = runtime
      ? dispatchAgentTask(runtime, {
          from: "supervisor",
          agentId: "fact_verifier",
          taskType: "review_evidence_consistency",
          input: {
            key: item.key,
            kind,
            preferred_claim: item.preferred_fact?.claim || null
          },
          metadata: {
            kind,
            key: item.key
          }
        })
      : null;

    const resolution = {
      key: item.key,
      kind,
      preferred_source: item.comparison?.preferred_source || item.preferred_fact?.source_id || null,
      preferred_claim: item.preferred_fact?.claim || null,
      reason: item.reason,
      status: kind === "conflict" ? "needs_disclosure" : "needs_more_sources",
      competing_sources: item.comparison?.competing_sources || []
    };

    if (runtimeTask) {
      completeAgentTask(runtime, runtimeTask.id, resolution);
    }

    return resolution;
  });

  telemetry.events.push({
    stage: "fact_verifier_review",
    task_count: tasks.length,
    conflict_count: verification?.conflicts?.length || 0,
    coverage_gap_count: verification?.coverage_gaps?.length || 0
  });

  return {
    tasks,
    summary: {
      conflicts: verification?.conflicts?.length || 0,
      coverage_gaps: verification?.coverage_gaps?.length || 0,
      review_count: tasks.length
    }
  };
}

module.exports = {
  routeCandidate,
  collectorToolForCandidate,
  collectorCapabilityForTask,
  selectCandidates,
  evaluateResearch,
  runWebResearcher,
  runSpecialistReads,
  runFactVerifierReview
};

# OpenSearch Operational Workflow

This document visualizes the project's current runtime behavior from inbound API request to final answer synthesis, including planner-guided site connector provisioning, search/read execution, verification, stopping logic, and persistence.

## End-to-End Runtime Flowchart

```mermaid
flowchart TD
    S([Start]) --> C[Client / UI / API Consumer<br/>Input: query or question, mode=deep]
    C --> R{Which entry point?}

    R -->|POST /api/search| A1[Search API Handler<br/>Validates request body<br/>Normalizes query -> runResearch(question, mode)]
    R -->|POST /api/research| A2[Research API Handler<br/>Validates question payload<br/>Calls runResearch(question, mode)]
    R -->|GET /api/research/stream| A3[Streaming Handler<br/>SSE heartbeat + incremental progress events<br/>Calls runResearch(question, mode, onProgress)]
    R -->|GET /api/search/capabilities| A4[Capabilities Handler<br/>Returns runtime modes, limits,<br/>source_capabilities incl. generated connectors]
    R -->|Tool / memory APIs| A5[Operational Support APIs<br/>Samples, experience, audit, synthesize-tool,<br/>run-ephemeral-tool]

    A1 --> P0
    A2 --> P0
    A3 --> P0

    subgraph P[Planning and Runtime Setup]
        P0[buildPlan(question)<br/>Input: user question] --> P1[buildLlmPlanningContext<br/>Collects source_capabilities, site hints,<br/>task goal, stop policy skeleton]
        P1 --> P2[LLM Planner Request<br/>Returns sub_questions, initial_queries,<br/>chosen_connector_ids, site_search_strategies]
        P2 --> P3[mergePlanWithModelSelection<br/>Strict validation + normalization<br/>Output: executable plan]
        P3 --> P4[applyExecutionModeToPlan<br/>Attaches budgets and execution limits]
        P4 --> P5[Initialize runtime state<br/>scratchpad + agent registry + agent runtime + knowledge graph + telemetry]
    end

    P5 --> G0{Plan contains site_search_strategies?}
    G0 -->|No| L0[Emit initial plan progress event]

    subgraph G[Generated Site Connector Provisioning]
        G1[Iterate each site_search_strategy<br/>Input: domain, search_mode, query_variants] --> G2{Existing connector covers domain?}
        G2 -->|Yes| G3[Reuse static or prior generated connector<br/>Set resolved_connector_id<br/>Mark provisioning_status=existing/reused]
        G2 -->|No| G4[Normalize domain + build stable connector id<br/>Example: https://www.openai.com -> site_openai_com]
        G4 --> G5[Detect site search capability<br/>Homepage fetch + form parsing + common search URL probes]
        G5 --> G6{Search capability validated?}
        G6 -->|Yes| G7[Request formal tool creation via tool platform<br/>Requester=llm_orchestrator<br/>Generate search + read tools]
        G6 -->|No| G8[Generate read-only connector draft<br/>Search disabled, read enabled]
        G7 --> G9[Validate generated connector<br/>Read homepage; search verification query]
        G8 --> G9
        G9 --> G10{Read validation succeeded?}
        G10 -->|No| G11[Provisioning failed<br/>Audit failure + downgrade to site_query fallback]
        G10 -->|Yes| G12{Search validation succeeded?}
        G12 -->|Yes| G13[Persist generated connector record<br/>Register connector + tools immediately<br/>Expose in source_capabilities]
        G12 -->|No| G14[Persist read-only generated connector<br/>effective_search_mode=site_query_with_generated_read]
    end

    G0 -->|Yes| G1
    G3 --> L0
    G11 --> L0
    G13 --> L0
    G14 --> L0

    L0 --> Q0[Seed activeConnectorIds + round state<br/>queries=plan.initial_queries]
    Q0 --> LOOP{Round <= stop_policy.max_rounds?}
    LOOP -->|No| E8[If no evaluation yet, force stop evaluation]

    subgraph D[Per-Round Discovery and Reading Loop]
        D0[runRound(plan, question, queries)<br/>Record queries in scratchpad + timeline] --> D1[runWebResearcher(plan, queries, telemetry)]
        D1 --> D2[Base discovery tasks<br/>For each query -> invokeSourceTool(action=discover)<br/>connector_ids=plan.chosen_connector_ids]
        D1 --> D3{Site strategy tasks available?}
        D3 -->|Yes| D4[buildSiteStrategyTasks<br/>Modes:<br/>connector_search / site_query / hybrid / verify_only / site_query_with_generated_read]
        D3 -->|No| D5[Fallback site-hint queries via bing_web + site:domain]
        D4 --> D6[Execute strategy tasks<br/>connector search or bing_web site:domain]
        D6 --> D7{Read-only generated connector attached?}
        D7 -->|Yes| D8[Rewrite discovered candidates<br/>candidate.connector = generated read connector]
        D7 -->|No| D9[Keep discovered candidate connector]
        D2 --> D10[Aggregate candidate reports]
        D5 --> D10
        D8 --> D10
        D9 --> D10
        D10 --> D11[Deduplicate + score candidates<br/>Preferred domain boosts + telemetry failures]
        D11 --> D12[LLM candidate routing<br/>Select best candidates + assign agent + preferred tool]
        D12 --> D13[runSpecialistReads(selected)]
        D13 --> D14[Agent groups<br/>long_text_collector / video_parser / chart_parser / fact_verifier]
        D14 --> D15[Tool resolution via ToolRegistry / AgentSystem<br/>Primary tool + fallback tool chain]
        D15 --> D16{Read/tool execution succeeded?}
        D16 -->|Yes| D17[Normalize reads + createEvidenceUnit<br/>Update scratchpad artifacts and handoffs]
        D16 -->|No| D18{Ephemeral fallback allowed?}
        D18 -->|Yes| D19[Attempt ephemeral fallback<br/>Legacy synthesizeTool / runEphemeralTool path<br/>Validate + record tool outcome]
        D18 -->|No| D20[Record read failure in telemetry]
        D19 --> D21{Fallback produced usable read?}
        D21 -->|Yes| D17
        D21 -->|No| D20
    end

    LOOP -->|Yes| D0
    D17 --> E0[Collect round outputs<br/>candidates, reads, evidence_items, executed_search_tasks]
    D20 --> E0

    subgraph E[Evaluation, Verification, and Stopping]
        E0 --> E1[crossCheckFacts + runFactVerifierReview<br/>Compare claims, confirmations, conflicts, coverage gaps]
        E1 --> E2[runStopEvaluation<br/>LLM stop controller evaluates sufficiency,<br/>missing questions, follow-up queries, connector suggestions]
        E2 --> E3{Stop decision = continue_search?}
        E3 -->|Yes| E4[buildFollowUpQueries<br/>Use evaluator suggestions + coverage gaps]
        E4 --> E5[buildNextRoundConnectorIds<br/>Drop unhealthy connectors, add suggested healthy reserves]
        E5 --> E6[Update connector health snapshot + next queries]
        E6 --> LOOP
        E3 -->|No| E7[Finalize evaluation + stop_reason]
    end

    E7 --> F0
    E8 --> F0

    subgraph F[Final Synthesis and Persistence]
        F0[synthesize(question, mode, evidence, verification, evaluation)<br/>LLM answer composer creates quick_answer,<br/>conclusion, claims, confidence, uncertainty] --> F1[Build final response payload<br/>sources + claims + deep_research_summary + rounds + telemetry]
        F1 --> F2[Persist memory and state<br/>experience-memory.json<br/>knowledge-graph.json<br/>tool-platform memory/audit]
        F2 --> F3{Original endpoint type?}
        F3 -->|/api/search| F4[Return normalized search response]
        F3 -->|/api/research| F5[Return full research payload]
        F3 -->|/api/research/stream| F6[Emit SSE done event + normalized result]
    end

    F4 --> Z([End])
    F5 --> Z
    F6 --> Z

    subgraph DS[Persistent Data Stores and Shared Runtime Artifacts]
        M1[(generated-site-connectors.json<br/>Persistent generated connector registry)]
        M2[(experience-memory.json<br/>Reusable query / connector lessons)]
        M3[(knowledge-graph.json<br/>Graph of claims and evidence)]
        M4[(tool-platform-memory.json<br/>Tool versions, promotion, reuse)]
        M5[(tool-platform-audit.jsonl<br/>Execution and provisioning audit trail)]
        M6[(source_capabilities<br/>Static + generated connectors exposed to planner and API)]
    end

    G13 -.writes.-> M1
    G14 -.writes.-> M1
    G11 -.audits.-> M5
    G3 -.updates visibility.-> M6
    G13 -.updates visibility.-> M6
    G14 -.updates visibility.-> M6
    P1 -.reads.-> M6
    F2 -.writes.-> M2
    F2 -.writes.-> M3
    D19 -.records.-> M4
    D19 -.audits.-> M5
```

## Step Annotations

| Stage | Primary Inputs | Core Processing Action | Primary Outputs | Key Branching / Conditions |
| --- | --- | --- | --- | --- |
| API ingress | HTTP request, query/question, mode | Validate payload, normalize parameters, select handler | `runResearch(...)` call or metadata response | Different behavior for search, research, streaming, capabilities, and tooling endpoints |
| Planning context | Question, site hints, `source_capabilities` | Assemble planner context with stop policy and connector catalog | `basePlan` | If planner output is invalid, retry once before failing |
| LLM planning | `basePlan`, question | Produce structured plan with connectors, queries, and `site_search_strategies` | Executable plan | Must return valid connector ids, sub-questions, and initial queries |
| Runtime init | Plan | Create scratchpad, agent registry, runtime snapshot, telemetry, knowledge graph | In-memory execution state | Knowledge graph is initialized or reused from persisted state |
| Site connector provisioning | `site_search_strategies` | Reuse existing connector or dynamically generate a domain-specific connector | Updated strategies with `resolved_connector_id`, `provisioning_status`, `effective_search_mode` | Generate only when planner selected a site and no existing connector covers the domain |
| Search capability detection | Site homepage, query variants | Parse search form / probe common search URL patterns | `search_config` or `null` | If search validation fails but read works, connector becomes read-only |
| Tool platform generation | Formal tool specs, requester=`llm_orchestrator` | Register generated search/read tools via tool platform | Active generated tools | If read validation fails, provisioning falls back to `bing_web site:domain` |
| Discovery | Initial queries, chosen connectors, site tasks | Run connector discovery and Bing site queries | Candidate set + executed task list | `verify_only` strategies skip discovery; read-only generated connectors rewrite only read path |
| Candidate routing | Candidate list, question, plan | LLM picks best sources and assigns specialist/tool | Routed candidate tasks | Returns empty set if no candidates survive filtering |
| Specialist reads | Routed candidates | Read pages/videos/documents/forums through ToolRegistry and agents | Normalized reads + evidence units | If primary read fails and ephemeral fallback is allowed, try tool synthesis/execution |
| Verification | Evidence units, scratchpad | Cross-check facts and ask fact verifier to resolve issues | Confirmations, conflicts, coverage gaps | Verification quality influences follow-up search and stop decision |
| Stop control | Plan, verification, evidence, rounds completed | LLM stop controller decides continue vs stop | Evaluation object + next action | If continue, system derives next queries and healthy connectors for next round |
| Final synthesis | Evidence, verification, evaluation | LLM composes final answer and confidence summary | Final response payload | Output shape varies slightly by endpoint (`/api/search`, `/api/research`, SSE stream) |
| Persistence | Final answer, telemetry, memory signals | Write experience memory, knowledge graph, tool audit, generated connectors | Durable state for future runs | Generated connectors become builtin-like on subsequent startups |

## Notation Guide

- Rounded nodes indicate start/end points.
- Rectangles indicate processing actions.
- Diamonds indicate decisions or branching conditions.
- Cylinders represent persisted data stores or shared capability catalogs.
- Solid arrows show runtime control flow.
- Dashed arrows show read/write relationships to persistent stores.

## Recommended Viewing Options

- Open this file in a Mermaid-capable Markdown viewer such as VS Code Markdown Preview or GitHub.
- For a presentation-friendly rendering, open `docs/operational-workflow.html`, which renders the diagram as scalable SVG in a browser.

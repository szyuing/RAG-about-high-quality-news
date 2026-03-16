# API 文档

## 概述

深度网页研究台 API 提供了一系列接口，用于执行深度网页搜索、工具合成和执行、以及获取系统信息。本文档详细说明了所有可用的 API 接口及其使用方法。

## 基础信息

- **基础 URL**: `http://localhost:3000`
- **Content-Type**: `application/json`
- **字符编码**: `utf-8`

## API 接口列表

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/samples` | 获取样本数据 |
| POST | `/api/tools/synthesize` | 合成工具 |
| POST | `/api/tools/run-ephemeral` | 运行临时工具 |
| GET | `/api/research/stream` | 流式研究（SSE） |
| POST | `/api/research` | 研究请求 |

## 接口详情

### 1. 健康检查

**请求**
- 方法: `GET`
- 路径: `/api/health`
- 参数: 无

**响应**
- 状态码: `200 OK`
- 响应体:
  ```json
  {
    "ok": true,
    "service": "deep-web-search-mvp"
  }
  ```

### 2. 获取样本数据

**请求**
- 方法: `GET`
- 路径: `/api/samples`
- 参数: 无

**响应**
- 状态码: `200 OK`
- 响应体:
  ```json
  {
    "prompts": ["样本提示 1", "样本提示 2"],
    "experience_memory": ["经验记忆项 1"],
    "tool_memory": ["工具记忆项 1"],
    "source_capabilities": ["源能力 1"]
  }
  ```

### 3. 合成工具

**请求**
- 方法: `POST`
- 路径: `/api/tools/synthesize`
- 请求体:
  ```json
  {
    "goal": "工具目标",
    "target": "目标对象",
    "constraints": ["约束条件 1", "约束条件 2"]
  }
  ```

**响应**
- 状态码: `200 OK`
- 响应体: 工具对象
  ```json
  {
    "tool_id": "工具 ID",
    "strategy": "工具策略",
    "target": "目标对象",
    "constraints": ["约束条件"]
  }
  ```

**错误响应**
- 状态码: `500 Internal Server Error`
- 响应体:
  ```json
  {
    "error": "tool_synthesis_failed",
    "message": "错误消息"
  }
  ```

### 4. 运行临时工具

**请求**
- 方法: `POST`
- 路径: `/api/tools/run-ephemeral`
- 请求体:
  ```json
  {
    "tool": { "tool_id": "工具 ID", "strategy": "工具策略" },
    "goal": "工具目标",
    "target": "目标对象",
    "constraints": ["约束条件"],
    "sandbox": { "timeout_ms": 15000, "network": true }
  }
  ```

**响应**
- 状态码: `200 OK`
- 响应体: 工具执行结果
  ```json
  {
    "success": true,
    "logs": ["执行日志"],
    "extracted_data": { "key": "value" },
    "worth_promoting": { "should_promote": false }
  }
  ```

**错误响应**
- 状态码: `500 Internal Server Error`
- 响应体:
  ```json
  {
    "error": "ephemeral_tool_failed",
    "message": "错误消息"
  }
  ```

### 5. 流式研究（SSE）

**请求**
- 方法: `GET`
- 路径: `/api/research/stream`
- 查询参数:
  - `question`: 研究问题（必填）
  - `mode`: 研究模式（可选，值为 `quick` 或 `deep`，默认 `deep`）

**响应**
- 状态码: `200 OK`
- Content-Type: `text/event-stream`
- 响应流:
  ```
  event: plan
  data: {"plan": {...}}

  event: round
  data: {"round": {...}}

  event: evaluation
  data: {"evaluation": {...}}

  event: tool
  data: {"tool_attempt": {...}}

  event: synthesizing
  data: {"counts": {...}}

  event: done
  data: {"type": "done", "result": {...}}
  ```

**错误响应**
- 状态码: `200 OK`（SSE 格式）
- 响应流:
  ```
  event: failed
  data: {"type": "failed", "error": "错误消息"}
  ```

### 6. 研究请求

**请求**
- 方法: `POST`
- 路径: `/api/research`
- 请求体:
  ```json
  {
    "question": "研究问题",
    "mode": "研究模式"  // 可选，值为 "quick" 或 "deep"，默认 "deep"
  }
  ```

**响应**
- 状态码: `200 OK`
- 响应体:
  ```json
  {
    "task_id": "任务 ID",
    "question": "研究问题",
    "plan": {...},
    "rounds": [...],
    "candidates": [...],
    "reads": [...],
    "evidence": [...],
    "verification": {...},
    "evaluation": {...},
    "scratchpad": {...},
    "runtime": {
      "capabilities": {
        "tools": [...],
        "state": [...],
        "memory": [...],
        "execution": [...]
      }
    },
    "agent_runtime": {...},
    "telemetry": {...},
    "tool_memory": [...],
    "experience": {...},
    "final_answer": {...}
  }
  ```

**错误响应**
- 状态码: `400 Bad Request`（缺少问题）
  ```json
  {
    "error": "question is required"
  }
  ```

- 状态码: `500 Internal Server Error`（研究失败）
  ```json
  {
    "error": "research_failed",
    "message": "错误消息"
  }
  ```

## 数据结构

### 研究计划 (Plan)

```json
{
  "task_goal": "研究目标",
  "sub_questions": ["子问题 1", "子问题 2"],
  "required_evidence": ["证据要求 1"],
  "source_strategy": "源策略",
  "preferred_connectors": [{"id": "connector1", "label": "连接器 1", "reason": "原因"}],
  "chosen_connector_ids": ["connector1", "connector2"],
  "source_capabilities": [...],
  "initial_queries": ["初始查询 1"],
  "stop_policy": {...},
  "stop_condition": "停止条件"
}
```

### 研究结果 (Final Answer)

```json
{
  "mode": "研究模式",
  "headline": "研究标题",
  "quick_answer": "快速回答",
  "deep_research_summary": {
    "headline": "研究标题",
    "conclusion": "结论",
    "key_sources": [...],
    "evidence_chain": [...],
    "conflicts": [...],
    "uncertainty": [...],
    "stop_decision": {...},
    "confidence": 0.85,
    "dynamic_tools": [...],
    "task_observability": {...}
  }
}
```

## 示例请求

### 1. 合成工具

```bash
curl -X POST http://localhost:3000/api/tools/synthesize \
  -H "Content-Type: application/json" \
  -d '{"goal": "Extract information about OpenAI Sora", "target": "https://openai.com/sora", "constraints": ["Use no third-party dependencies"]}'
```

### 2. 运行研究

```bash
curl -X POST http://localhost:3000/api/research \
  -H "Content-Type: application/json" \
  -d '{"question": "What is OpenAI Sora?", "mode": "deep"}'
```

### 3. 流式研究

```bash
curl -N http://localhost:3000/api/research/stream?question=What%20is%20OpenAI%20Sora?
```

## 环境变量

| 变量名 | 描述 | 默认值 |
|--------|------|--------|
| `PORT` | 服务器端口 | 3000 |
| `OPENAI_API_KEY` | OpenAI API 密钥 | 无 |
| `OPENAI_RESPONSES_URL` | OpenAI 响应 API URL | https://api.openai.com/v1/responses |
| `OPENAI_PLANNER_MODEL` | 规划器模型 | gpt-4o-mini |
| `OPENAI_EVALUATOR_MODEL` | 评估器模型 | gpt-4o-mini |

## 错误处理

API 使用标准 HTTP 状态码来表示请求的结果：

- `200 OK`: 请求成功
- `400 Bad Request`: 请求参数错误
- `404 Not Found`: 资源不存在
- `500 Internal Server Error`: 服务器内部错误

错误响应通常包含以下字段：

- `error`: 错误类型
- `message`: 错误详细信息

## 最佳实践

1. **流式研究 vs 普通研究**:
   - 对于需要实时反馈的场景，使用流式研究接口
   - 对于后台处理或不需要实时反馈的场景，使用普通研究接口

2. **工具合成与执行**:
   - 先合成工具，再执行工具，以获得更好的结果
   - 为工具提供明确的目标和约束条件

3. **研究模式选择**:
   - `quick`: 快速获得答案，适用于简单问题
   - `deep`: 深度研究，适用于复杂问题

4. **参数优化**:
   - 提供具体、明确的研究问题
   - 对于复杂问题，考虑分步骤进行研究

## 故障排除

1. **API 无响应**:
   - 检查服务器是否运行
   - 检查网络连接
   - 检查端口是否正确

2. **研究失败**:
   - 检查 OpenAI API 密钥是否配置正确
   - 检查网络连接是否正常
   - 尝试简化研究问题

3. **工具执行失败**:
   - 检查目标 URL 是否可访问
   - 检查约束条件是否合理
   - 增加超时时间

## 版本信息

- **版本**: 0.1.0
- **最后更新**: 2026-03-16

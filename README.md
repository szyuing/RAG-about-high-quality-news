# Deep Web Search Console

基于 [web-search-product.md](/d:/opensearch/web-search-product.md) 落地的研究控制台。

## 当前架构

- `LLM-Orchestrator` 负责 `plan / route / stop / synthesize`
- `Fact Verifier / Evaluator Agent` 负责研究质量验证、冲突识别和覆盖缺口判断
- `Runtime` 负责工具注册与调用、工作流状态、Scratchpad / Experience Memory、任务执行与追踪
- 统一输出 `Quick Answer / Deep Research Summary`

## 当前能力

- LLM-Orchestrator 驱动的任务规划与多轮 research loop
- 统一 `source tool` 的真实来源发现与读取
- `deep_read_page` 风格的网页与文档深读
- `extract_video_intel` 风格的视频 transcript / timeline 提取
- 轻量 `cross_check_facts`
- Scratchpad / Experience Memory / Knowledge Graph 闭环
- Agent runtime trace 与前端可视化

## 当前接入来源

- Bing Web + Jina Reader
- IT Home
- Hacker News
- SegmentFault
- arXiv
- Bilibili
- Douyin
- TED

## 运行

```bash
node server.js
```

打开 `http://localhost:3000`。

## 测试

```bash
npm test
```

测试会使用临时数据目录，避免污染仓库内的 `data/`。

## LLM 配置

- 项目会优先读取仓库根目录的 `.env.local` / `.env`
- 如果未显式设置 `OPENAI_RESPONSES_URL` 和 `OPENAI_*_MODEL`，会尝试从 `~/.codex/config.toml` 推断
- 建议把 `OPENAI_API_KEY` 放在 `.env.local`，不要提交到仓库

```bash
copy env.local.template .env.local
npm run start:llm
```

也可以直接临时传入：

```bash
powershell -ExecutionPolicy Bypass -File scripts/start-with-llm.ps1 -ApiKey "<new-key>" -Model "gpt-5.4"
```

# 深度网页研究台

基于 [web-search-product.md](d:/opensearch/web-search-product.md) 落地的第一版研究控制台。

## 运行

```bash
node server.js
```

打开 `http://localhost:3000`。

## 当前范围

- Supervisor / Planner 风格的任务规划
- `enhanced_search` 风格的真实候选搜索
- `deep_read_page` 风格的网页与文档深读
- `extract_video_intel` 风格的视频 transcript 提取
- 轻量 `cross_check_facts`
- Scratchpad / Evaluator / Experience Memory 闭环
- 快速回答 / 深度研究摘要输出

## 当前真实接入层

- Bing Web + Jina Reader：通用网页搜索与正文抽取
- Hacker News：讨论型来源
- arXiv：文档与研究来源
- TED：视频 Talk 与 transcript 来源

## 说明

- 当前版本已经去掉静态 `source-pack`，改为真实联网来源。
- 由于运行环境可达性限制，第一批来源优先选用了不需要额外密钥且在当前环境稳定可用的 4 类来源。
- 架构已经按 connector 方式组织，后续可以继续补官方站点、视频平台和更多新闻源。

## 测试

```bash
node --test --test-isolation=none
```

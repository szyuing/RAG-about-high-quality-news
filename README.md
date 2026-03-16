# 深度网页研究台

基于 [web-search-product.md](d:/opensearch/web-search-product.md) 落地的第一版研究控制台。

## 运行

```bash
node server.js
```

打开 `http://localhost:3000`。

## 当前范围

- Supervisor / Planner 风格的任务规划
- 统一 `source tool` 风格的真实候选搜索
- `deep_read_page` 风格的网页与文档深读
- `extract_video_intel` 风格的视频 transcript 提取
- 轻量 `cross_check_facts`
- Scratchpad / Evaluator / Experience Memory 闭环
- 快速回答 / 深度研究摘要输出

## 当前真实接入层

- Bing Web + Jina Reader：通用网页搜索与正文抽取
- IT之家：中文科技新闻来源
- Hacker News：讨论型来源
- SegmentFault：中文技术长文来源
- arXiv：文档与研究来源
- Bilibili：中文视频来源
- 抖音：中文短视频来源
- TED：视频 Talk 与 transcript 来源

## 说明

- 当前版本已经去掉静态 `source-pack`，改为真实联网来源。
- 所有站点调用已经收敛到统一 `source tool`，不再在架构层把网站硬编码成“只能承担某一种来源角色”。
- 当前版本会先根据问题主题对 connector 做优先级判断，再从统一 source tool 返回的候选中选择高价值来源。
- 由于运行环境可达性限制，第一批来源优先选用了不需要额外密钥且在当前环境稳定可用的 4 类来源。
- 架构已经按 connector 方式组织，后续可以继续补官方站点、视频平台和更多新闻源。

## 测试

```bash
node --test --test-isolation=none
```

# Deep Web Search MVP

基于 `web-search-product.md` 落地的第一版本地可运行产品。

## 运行

```bash
node server.js
```

打开 `http://localhost:3000`。

## 当前范围

- Planner / Supervisor 任务规划
- `enhanced_search` 候选搜索
- `deep_read_page` 正文深读
- `extract_video_intel` 视频转写与时间轴摘要
- 轻量 `cross_check_facts`
- Scratchpad / Evaluator / Experience Memory
- Quick Answer / Deep Research Summary 输出

## 说明

- 当前版本使用本地演示语料包模拟 3 到 4 类来源能力，重点验证 MVP 主链路，而不是实时联网抓取。
- 架构已经按可扩展接入层组织，后续可把本地 source pack 替换成真实网页、视频和文档连接器。

## 测试

```bash
node --test
```

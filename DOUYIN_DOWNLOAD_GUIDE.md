# 抖音视频下载工具使用指南

## 概述

本工具提供了抖音视频下载功能，支持多种下载模式和配置选项。基于GitHub上的优秀开源项目分析，我们实现了以下功能：

## 功能特性

1. **多种下载模式**
   - 直接解析页面模式（默认）
   - API接口模式
   - Cookie认证模式

2. **支持的链接类型**
   - 完整视频链接：`https://www.douyin.com/video/1234567890`
   - 短链接：`https://v.douyin.com/xxxxx`

3. **下载选项**
   - 选择是否带水印
   - 自定义输出目录
   - 自定义视频格式

## 使用方法

### 基本用法

```javascript
const { ToolRegistry } = require('./src/source-connectors');

// 下载视频
const result = await ToolRegistry.executeTool('download_douyin_video', {
  videoUrl: 'https://www.douyin.com/video/7617686082800323840',
  outputDir: './downloads',
  format: 'mp4',
  watermark: false
});

console.log(result);
```

### 使用API模式

```javascript
const result = await ToolRegistry.executeTool('download_douyin_video', {
  videoUrl: 'https://www.douyin.com/video/7617686082800323840',
  useApi: true,
  outputDir: './downloads',
  format: 'mp4',
  watermark: false
});
```

### 使用Cookie认证

```javascript
const result = await ToolRegistry.executeTool('download_douyin_video', {
  videoUrl: 'https://www.douyin.com/video/7617686082800323840',
  cookie: 'your_douyin_cookie_here',
  outputDir: './downloads',
  format: 'mp4',
  watermark: false
});
```

## 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| videoUrl | string | 是 | - | 抖音视频链接 |
| outputDir | string | 否 | './downloads' | 视频保存目录 |
| format | string | 否 | 'mp4' | 视频格式 |
| watermark | boolean | 否 | false | 是否带水印 |
| useApi | boolean | 否 | false | 是否使用API接口 |
| cookie | string | 否 | null | 抖音Cookie |

## 技术实现

### 基于GitHub项目分析的改进

1. **API接口支持**
   - 参考了Douyin_TikTok_Download_API项目
   - 集成了第三方API接口用于视频解析

2. **Cookie认证**
   - 借鉴了douyin-downloader项目的Cookie处理方式
   - 支持用户登录后的Cookie认证

3. **多种解析方法**
   - SSR数据提取
   - RENDER_DATA提取
   - video标签提取
   - 正则表达式匹配

### 已知限制

1. **反爬虫机制**
   - 抖音使用JavaScript虚拟机保护
   - 需要有效的Cookie或使用API接口

2. **短链接处理**
   - 某些短链接重定向到应用协议
   - 建议使用完整视频链接

3. **API接口稳定性**
   - 第三方API可能不稳定
   - 建议提供备用API地址

## 故障排除

### 问题1：找不到视频下载URL

**原因**：抖音页面结构变化或反爬虫机制

**解决方案**：
1. 使用API模式：`useApi: true`
2. 提供有效的Cookie
3. 尝试不同的视频链接

### 问题2：API调用失败

**原因**：第三方API不可用或网络问题

**解决方案**：
1. 检查网络连接
2. 尝试直接解析模式
3. 提供Cookie认证

### 问题3：短链接无法解析

**原因**：短链接重定向到应用协议

**解决方案**：
1. 使用完整视频链接
2. 在浏览器中打开短链接获取完整URL

## 测试

运行测试脚本：

```bash
node test-douyin-improved.js
```

## 注意事项

1. **版权问题**：仅下载自己拥有版权或获得授权的视频
2. **使用频率**：避免频繁请求，以免被抖音封禁
3. **Cookie安全**：妥善保管Cookie信息，不要泄露
4. **API限制**：第三方API可能有使用限制

## 参考项目

- [Douyin-Downloader](https://github.com/jiji262/douyin-downloader) - Python实现的抖音下载工具
- [Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API) - 短视频解析API服务
- [douyin-downloader](https://github.com/HeLiangHIT/douyin_downloader) - 另一个Python实现的抖音下载器

## 更新日志

### v2.0 (当前版本)
- 新增API接口模式
- 新增Cookie认证支持
- 改进错误处理和提示
- 增加短链接处理

### v1.0
- 基本视频下载功能
- 支持完整链接和短链接
- 水印选项支持

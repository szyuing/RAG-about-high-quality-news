# 抖音视频信息提取工具使用指南

## 概述

本工具提供了抖音视频信息提取功能，可以分析抖音视频链接并提取相关信息，包括视频地址、标题、视频ID等。基于GitHub上的优秀开源项目分析，我们实现了稳定可靠的信息提取方案。

## 功能特性

1. **视频信息提取**
   - 提取视频标题
   - 提取视频ID
   - 提取视频下载地址（如果可用）
   - 检测页面保护机制

2. **支持的链接类型**
   - 完整视频链接：`https://www.douyin.com/video/1234567890`
   - 短链接：`https://v.douyin.com/xxxxx`

3. **智能分析**
   - 自动检测JavaScript保护
   - 提供解决方案建议
   - 支持Cookie认证

## 使用方法

### 基本用法

```javascript
const { ToolRegistry } = require('./src/source-connectors');

// 提取视频信息
const result = await ToolRegistry.executeTool('extract_douyin_video_info', {
  videoUrl: 'https://www.douyin.com/video/7617686082800323840'
});

console.log(result);
```

### 使用Cookie认证

```javascript
const result = await ToolRegistry.executeTool('extract_douyin_video_info', {
  videoUrl: 'https://www.douyin.com/video/7617686082800323840',
  cookie: 'your_douyin_cookie_here'
});
```

## 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| videoUrl | string | 是 | - | 抖音视频链接 |
| cookie | string | 否 | null | 抖音Cookie，用于访问需要登录的视频 |

## 返回结果

### 成功响应

```json
{
  "success": true,
  "data": {
    "title": "视频标题",
    "videoId": "7617686082800323840",
    "originalUrl": "https://www.douyin.com/video/7617686082800323840",
    "resolvedUrl": "https://www.douyin.com/video/7617686082800323840",
    "shortUrlRedirect": null,
    "videoDownloadUrl": "https://...",
    "extractionMethod": "SSR_HYDRATED_DATA",
    "hasJsProtection": false,
    "pageLength": 123456,
    "extractionStatus": "success",
    "suggestions": []
  }
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| title | string | 视频标题 |
| videoId | string | 视频ID |
| originalUrl | string | 原始输入的URL |
| resolvedUrl | string | 解析后的URL（处理短链接后） |
| shortUrlRedirect | string | 短链接重定向地址 |
| videoDownloadUrl | string | 视频下载地址（可能为null） |
| extractionMethod | string | 提取方法 |
| hasJsProtection | boolean | 是否有JavaScript保护 |
| pageLength | number | 页面内容长度 |
| extractionStatus | string | 提取状态：success/js_protection/not_found |
| suggestions | array | 建议列表 |

### 提取方法

- `SSR_HYDRATED_DATA.playAddr` - 从SSR数据中提取的无水印地址
- `SSR_HYDRATED_DATA.downloadAddr` - 从SSR数据中提取的下载地址
- `RENDER_DATA` - 从渲染数据中提取
- `video_tag` - 从video标签中提取
- `play_url_param` - 从play_url参数中提取
- `regex_mp4` - 通过正则表达式匹配
- `null` - 未找到视频地址

### 提取状态

- `success` - 成功提取视频地址
- `js_protection` - 页面使用了JavaScript保护
- `not_found` - 未找到视频地址

## 技术实现

### 基于GitHub项目分析的改进

1. **多种解析方法**
   - SSR数据提取
   - RENDER_DATA提取
   - video标签提取
   - 正则表达式匹配

2. **智能检测**
   - JavaScript虚拟机保护检测
   - 短链接处理
   - 页面结构分析

3. **错误处理**
   - 详细的错误提示
   - 解决方案建议
   - 降级处理

### 已知限制

1. **反爬虫机制**
   - 抖音使用JavaScript虚拟机保护
   - 需要有效的Cookie才能绕过保护
   - 某些视频可能需要登录才能访问

2. **短链接处理**
   - 某些短链接重定向到应用协议
   - 建议使用完整视频链接

## 故障排除

### 问题1：无法提取视频地址

**原因**：页面使用了JavaScript保护

**解决方案**：
1. 提供有效的Cookie
2. 使用浏览器开发者工具手动获取
3. 考虑使用Selenium/Playwright

### 问题2：短链接无法解析

**原因**：短链接重定向到应用协议

**解决方案**：
1. 使用完整视频链接
2. 在浏览器中打开短链接获取完整URL

### 问题3：提取到的地址无法下载

**原因**：视频地址可能有时效性

**解决方案**：
1. 尽快使用提取的地址下载
2. 重新提取获取新的地址

## 测试

运行测试脚本：

```bash
node test-douyin-extract.js
```

## 注意事项

1. **版权问题**：仅提取自己拥有版权或获得授权的视频信息
2. **使用频率**：避免频繁请求，以免被抖音封禁
3. **Cookie安全**：妥善保管Cookie信息，不要泄露
4. **地址时效性**：提取的视频地址可能有时效性

## 参考项目

- [Douyin-Downloader](https://github.com/jiji262/douyin-downloader) - Python实现的抖音下载工具
- [Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API) - 短视频解析API服务
- [douyin-downloader](https://github.com/HeLiangHIT/douyin_downloader) - 另一个Python实现的抖音下载器

## 更新日志

### v2.0 (当前版本)
- 从下载工具改为信息提取工具
- 增加JavaScript保护检测
- 增加智能建议功能
- 改进错误处理

### v1.0
- 基本视频下载功能
- 支持完整链接和短链接
- 水印选项支持

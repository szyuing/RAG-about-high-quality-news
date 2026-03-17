# 抖音视频工具使用指南（增强版）

## 概述

本工具集提供了强大的抖音视频信息提取功能，包括单个视频提取和批量提取。基于GitHub上的优秀开源项目分析，我们实现了智能分析、多种下载方式建议和完整的元数据支持。

## 工具列表

### 1. 单个视频信息提取工具

**工具ID**: `extract_douyin_video_info`

提取单个抖音视频的详细信息，包括视频地址、下载方法建议等。

#### 使用方法

```javascript
const { ToolRegistry } = require('./src/source-connectors');

// 基本用法
const result = await ToolRegistry.executeTool('extract_douyin_video_info', {
  videoUrl: 'https://www.douyin.com/video/7617686082800323840'
});

// 使用Cookie认证
const result = await ToolRegistry.executeTool('extract_douyin_video_info', {
  videoUrl: 'https://www.douyin.com/video/7617686082800323840',
  cookie: 'your_douyin_cookie_here'
});
```

#### 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| videoUrl | string | 是 | - | 抖音视频链接 |
| cookie | string | 否 | null | 抖音Cookie，用于访问需要登录的视频 |

#### 返回结果

```json
{
  "title": "视频标题",
  "videoId": "7617686082800323840",
  "originalUrl": "https://www.douyin.com/video/7617686082800323840",
  "resolvedUrl": "https://www.douyin.com/video/7617686082800323840",
  "shareUrl": "https://v.douyin.com/7617686082800323840/",
  "videoDownloadUrl": null,
  "extractionStatus": "js_protection",
  "hasJsProtection": true,
  "downloadMethods": [
    {
      "name": "浏览器开发者工具",
      "description": "手动获取视频地址",
      "steps": ["..."],
      "difficulty": "中等",
      "successRate": "高"
    }
  ],
  "metadata": {
    "platform": "douyin",
    "urlType": "full",
    "extractedAt": "2026-03-16T16:24:41.516Z",
    "toolVersion": "2.0"
  }
}
```

### 2. 批量视频信息提取工具

**工具ID**: `batch_extract_douyin_video_info`

批量提取多个抖音视频的信息，支持并发控制和延迟设置。

#### 使用方法

```javascript
const result = await ToolRegistry.executeTool('batch_extract_douyin_video_info', {
  videoUrls: [
    'https://www.douyin.com/video/7617686082800323840',
    'https://www.douyin.com/video/1234567890',
    'https://v.douyin.com/iFRqB6x/'
  ],
  concurrency: 2,  // 并发数
  delay: 500       // 请求间隔（毫秒）
});
```

#### 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| videoUrls | array | 是 | - | 抖音视频链接数组 |
| cookie | string | 否 | null | 抖音Cookie |
| concurrency | number | 否 | 3 | 并发数 |
| delay | number | 否 | 1000 | 请求间隔延迟（毫秒） |

#### 返回结果

```json
{
  "total": 3,
  "successful": 2,
  "failed": 1,
  "results": [...],
  "errors": [...]
}
```

## 功能特性

### 1. 智能分析

- **JavaScript保护检测**: 自动检测页面是否使用了JavaScript虚拟机保护
- **提取方法识别**: 记录成功提取视频地址的方法
- **状态分类**: 提取状态分为 success/js_protection/not_found

### 2. 下载方法建议

当无法直接提取视频地址时，工具会提供多种下载方法建议：

#### 方法1: 使用Cookie认证
- **难度**: 中等
- **成功率**: 高
- **步骤**:
  1. 登录抖音网页版
  2. 打开开发者工具(F12)
  3. 切换到Application/Storage标签
  4. 复制Cookie字符串
  5. 使用本工具的cookie参数

#### 方法2: 浏览器开发者工具
- **难度**: 中等
- **成功率**: 高
- **步骤**:
  1. 在浏览器中打开视频页面
  2. 按F12打开开发者工具
  3. 切换到Network标签
  4. 播放视频，查找.mp4请求
  5. 复制视频地址

#### 方法3: 第三方在线工具
- **难度**: 简单
- **成功率**: 中
- **示例**:
  - https://douyin.video
  - https://www.tiktok.com/download
  - 各种抖音去水印小程序

#### 方法4: Python + Selenium
- **难度**: 困难
- **成功率**: 高
- **代码示例**:
```python
from selenium import webdriver
from selenium.webdriver.common.by import By
import time

driver = webdriver.Chrome()
driver.get('https://www.douyin.com/video/7617686082800323840')
time.sleep(5)  # 等待页面加载
video = driver.find_element(By.TAG_NAME, 'video')
video_url = video.get_attribute('src')
print(video_url)
```

#### 方法5: 移动端分享
- **难度**: 简单
- **成功率**: 高
- **步骤**:
  1. 在抖音APP中打开视频
  2. 点击分享按钮
  3. 选择复制链接
  4. 使用第三方工具解析

### 3. 批量处理

- **并发控制**: 支持设置并发数，避免请求过快
- **延迟设置**: 支持设置请求间隔，降低被封禁风险
- **错误处理**: 批量处理时单个失败不影响其他
- **结果汇总**: 提供成功/失败统计

### 4. 元数据支持

每个提取结果都包含完整的元数据：

```json
{
  "metadata": {
    "platform": "douyin",          // 平台标识
    "urlType": "full",             // 链接类型: full/short
    "extractedAt": "...",          // 提取时间
    "toolVersion": "2.0"           // 工具版本
  }
}
```

## 支持的链接类型

- **完整链接**: `https://www.douyin.com/video/1234567890`
- **短链接**: `https://v.douyin.com/xxxxx`

## 测试结果示例

```
开始测试增强版抖音视频信息提取工具...

测试1: 单个视频信息提取

提取结果:
标题: unknown
视频ID: 7617686082800323840
分享链接: https://v.douyin.com/7617686082800323840/
提取状态: js_protection
是否有JS保护: true

推荐的下载方法:

1. 使用Cookie认证
   描述: 提供有效的抖音Cookie
   难度: 中等
   成功率: 高
   步骤:
     1. 登录抖音网页版
     2. 打开开发者工具(F12)
     3. 切换到Application/Storage标签
     4. 复制Cookie字符串
     5. 使用本工具的cookie参数

... (其他方法)

元数据:
平台: douyin
链接类型: full
提取时间: 2026-03-16T16:24:41.516Z
工具版本: 2.0

测试2: 批量视频信息提取

批量提取结果:
总数: 3
成功: 2
失败: 0
```

## 测试

运行测试脚本：

```bash
# 基础测试
node test-douyin-extract.js

# 增强功能测试
node test-douyin-enhanced.js

# 调试测试
node test-douyin-debug.js
```

## 注意事项

1. **版权问题**: 仅提取自己拥有版权或获得授权的视频信息
2. **使用频率**: 避免频繁请求，建议设置合理的delay值
3. **Cookie安全**: 妥善保管Cookie信息，不要泄露
4. **反爬虫机制**: 抖音有严格的反爬虫机制，可能需要多种方法配合

## 故障排除

### 问题1: 无法提取视频信息

**原因**: 页面使用了JavaScript保护

**解决方案**: 
- 使用Cookie认证
- 尝试其他下载方法

### 问题2: 短链接解析失败

**原因**: 短链接重定向到应用协议

**解决方案**: 
- 使用完整视频链接
- 在浏览器中打开短链接获取完整URL

### 问题3: 批量处理部分失败

**原因**: 网络问题或个别链接无效

**解决方案**: 
- 检查失败的链接
- 调整concurrency和delay参数
- 重新处理失败的链接

## 参考项目

- [Douyin-Downloader](https://github.com/jiji262/douyin-downloader)
- [Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API)
- [douyin-downloader](https://github.com/HeLiangHIT/douyin_downloader)

## 更新日志

### v2.0 (当前版本)
- 从下载工具改为信息提取工具
- 增加批量提取功能
- 增加多种下载方法建议
- 增加元数据支持
- 增加智能分析和建议

### v1.0
- 基本视频下载功能
- 支持完整链接和短链接

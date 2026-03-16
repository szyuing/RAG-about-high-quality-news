class SmartInformationRetriever {
  constructor() {
    this.searchHistory = [];
    this.filteredResults = new Map();
  }

  // 智能搜索查询生成
  generateSearchQueries(question, options = {}) {
    const queries = [];
    
    // 基础查询
    queries.push(question);
    
    // 同义词扩展
    const synonyms = this.getSynonyms(question);
    synonyms.forEach(synonym => {
      queries.push(synonym);
    });
    
    // 关键词提取
    const keywords = this.extractKeywords(question);
    if (keywords.length > 1) {
      queries.push(keywords.join(' '));
    }
    
    // 限制查询数量
    return queries.slice(0, options.maxQueries || 5);
  }

  // 智能搜索结果筛选
  filterSearchResults(results, options = {}) {
    const filtered = results
      // 去重
      .filter((result, index, self) => 
        index === self.findIndex(r => r.url === result.url)
      )
      // 质量评估
      .map(result => ({
        ...result,
        qualityScore: this.evaluateQuality(result)
      }))
      // 相关性评估
      .map(result => ({
        ...result,
        relevanceScore: this.evaluateRelevance(result, options.query || '')
      }))
      // 排序
      .sort((a, b) => {
        const scoreA = a.relevanceScore * 0.7 + a.qualityScore * 0.3;
        const scoreB = b.relevanceScore * 0.7 + b.qualityScore * 0.3;
        return scoreB - scoreA;
      })
      // 限制结果数量
      .slice(0, options.maxResults || 10);
    
    return filtered;
  }

  // 评估结果质量
  evaluateQuality(result) {
    let score = 0;
    
    // 域名质量
    const domainScore = this.evaluateDomain(result.url);
    score += domainScore * 0.4;
    
    // 内容长度
    if (result.content && result.content.length > 500) {
      score += 0.3;
    } else if (result.content && result.content.length > 200) {
      score += 0.15;
    }
    
    // 标题质量
    if (result.title && result.title.length > 10) {
      score += 0.1;
    }
    
    // 新鲜度（如果有日期）
    if (result.date) {
      const age = Date.now() - new Date(result.date).getTime();
      const daysOld = age / (1000 * 60 * 60 * 24);
      if (daysOld < 30) {
        score += 0.2;
      } else if (daysOld < 90) {
        score += 0.1;
      }
    }
    
    return Math.min(score, 1.0);
  }

  // 评估结果相关性
  evaluateRelevance(result, query) {
    let score = 0;
    const queryLower = query.toLowerCase();
    
    // 标题匹配
    if (result.title) {
      const titleLower = result.title.toLowerCase();
      if (titleLower.includes(queryLower)) {
        score += 0.4;
      } else if (this.hasKeywordMatch(titleLower, queryLower)) {
        score += 0.2;
      }
    }
    
    // 内容匹配
    if (result.content) {
      const contentLower = result.content.toLowerCase();
      if (contentLower.includes(queryLower)) {
        score += 0.3;
      } else if (this.hasKeywordMatch(contentLower, queryLower)) {
        score += 0.15;
      }
    }
    
    // URL匹配
    if (result.url) {
      const urlLower = result.url.toLowerCase();
      if (urlLower.includes(queryLower.replace(/\s+/g, '-'))) {
        score += 0.15;
      }
    }
    
    return Math.min(score, 1.0);
  }

  // 评估域名质量
  evaluateDomain(url) {
    const trustedDomains = [
      'google.com', 'microsoft.com', 'apple.com', 'amazon.com',
      'wikipedia.org', 'github.com', 'stackoverflow.com',
      'nytimes.com', 'washingtonpost.com', 'bbc.com',
      'arxiv.org', 'nature.com', 'science.org'
    ];
    
    const domain = new URL(url).hostname;
    
    for (const trustedDomain of trustedDomains) {
      if (domain.includes(trustedDomain)) {
        return 1.0;
      }
    }
    
    // 教育和研究机构
    if (domain.endsWith('.edu') || domain.endsWith('.ac.')) {
      return 0.9;
    }
    
    // 政府网站
    if (domain.endsWith('.gov') || domain.endsWith('.gov.')) {
      return 0.9;
    }
    
    // 一般商业网站
    if (domain.endsWith('.com') || domain.endsWith('.org')) {
      return 0.7;
    }
    
    // 其他
    return 0.5;
  }

  // 检查关键词匹配
  hasKeywordMatch(text, query) {
    const keywords = query.split(/\s+/).filter(word => word.length > 2);
    let matchCount = 0;
    
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        matchCount++;
      }
    }
    
    return matchCount > 0;
  }

  // 获取同义词
  getSynonyms(text) {
    // 简单的同义词映射
    const synonymMap = {
      'AI': ['artificial intelligence', 'machine learning'],
      'Sora': ['Sora model', 'OpenAI Sora'],
      'video': ['video generation', 'video creation'],
      'model': ['AI model', 'machine learning model'],
      'capabilities': ['features', 'abilities', 'functions']
    };
    
    const synonyms = [];
    const words = text.split(/\s+/);
    
    words.forEach(word => {
      const wordLower = word.toLowerCase();
      for (const [key, syns] of Object.entries(synonymMap)) {
        if (wordLower.includes(key.toLowerCase())) {
          syns.forEach(syn => {
            const newQuery = text.replace(new RegExp(key, 'gi'), syn);
            if (!synonyms.includes(newQuery)) {
              synonyms.push(newQuery);
            }
          });
        }
      }
    });
    
    return synonyms;
  }

  // 提取关键词
  extractKeywords(text) {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'with', 'by',
      'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did'
    ]);
    
    return text
      .toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word))
      .slice(0, 5);
  }

  // 执行智能搜索
  async executeSmartSearch(query, options = {}) {
    const searchQueries = this.generateSearchQueries(query, options);
    const allResults = [];
    
    // 模拟搜索执行（实际项目中应集成真实的搜索API）
    for (const searchQuery of searchQueries) {
      console.log(`Executing search: ${searchQuery}`);
      // 模拟搜索结果
      const mockResults = this.generateMockResults(searchQuery);
      allResults.push(...mockResults);
    }
    
    // 筛选和排序结果
    const filteredResults = this.filterSearchResults(allResults, {
      query,
      maxResults: options.maxResults || 10
    });
    
    // 保存搜索历史
    this.searchHistory.push({
      query,
      timestamp: Date.now(),
      results: filteredResults.length
    });
    
    return filteredResults;
  }

  // 生成模拟搜索结果
  generateMockResults(query) {
    const domains = ['wikipedia.org', 'github.com', 'arxiv.org', 'nytimes.com', 'bbc.com'];
    const results = [];
    
    for (let i = 0; i < 3; i++) {
      const domain = domains[Math.floor(Math.random() * domains.length)];
      results.push({
        url: `https://${domain}/search?q=${encodeURIComponent(query)}`,
        title: `${query} - ${domain}`,
        content: `This is a sample result for ${query} from ${domain}. It contains relevant information about the topic.`,
        date: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString()
      });
    }
    
    return results;
  }

  // 获取搜索历史
  getSearchHistory() {
    return this.searchHistory;
  }

  // 清理搜索历史
  clearSearchHistory() {
    this.searchHistory = [];
  }

  // 批量处理搜索结果
  batchProcessResults(results, options = {}) {
    return results.map(result => {
      const processed = {
        ...result,
        qualityScore: this.evaluateQuality(result),
        relevanceScore: this.evaluateRelevance(result, options.query || ''),
        processedAt: Date.now()
      };
      
      return processed;
    }).sort((a, b) => {
      const scoreA = a.relevanceScore * 0.7 + a.qualityScore * 0.3;
      const scoreB = b.relevanceScore * 0.7 + b.qualityScore * 0.3;
      return scoreB - scoreA;
    });
  }
}

// 导出单例
const smartInformationRetriever = new SmartInformationRetriever();

module.exports = {
  SmartInformationRetriever,
  smartInformationRetriever
};
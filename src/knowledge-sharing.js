class KnowledgeUnit {
  constructor(id, source, content, confidence = 0.8) {
    this.id = id || `ku_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.source = source; // Agent ID or system
    this.content = content;
    this.confidence = confidence;
    this.timestamp = Date.now();
    this.tags = [];
    this.references = [];
  }

  addTag(tag) {
    if (!this.tags.includes(tag)) {
      this.tags.push(tag);
    }
  }

  addReference(reference) {
    this.references.push(reference);
  }

  updateConfidence(newConfidence) {
    this.confidence = newConfidence;
    this.timestamp = Date.now();
  }
}

class KnowledgeBase {
  constructor() {
    this.knowledgeUnits = new Map();
    this.index = new Map(); // 标签 -> 知识单元ID
  }

  // 添加知识单元
  addKnowledgeUnit(knowledgeUnit) {
    this.knowledgeUnits.set(knowledgeUnit.id, knowledgeUnit);
    
    // 更新索引
    for (const tag of knowledgeUnit.tags) {
      if (!this.index.has(tag)) {
        this.index.set(tag, new Set());
      }
      this.index.get(tag).add(knowledgeUnit.id);
    }
    
    return knowledgeUnit.id;
  }

  // 获取知识单元
  getKnowledgeUnit(id) {
    return this.knowledgeUnits.get(id);
  }

  // 根据标签搜索知识单元
  searchByTag(tag) {
    if (!this.index.has(tag)) {
      return [];
    }
    return Array.from(this.index.get(tag))
      .map(id => this.knowledgeUnits.get(id))
      .filter(Boolean);
  }

  // 搜索相关知识
  searchRelated(content) {
    const results = [];
    for (const [id, unit] of this.knowledgeUnits.entries()) {
      if (unit.content.includes(content)) {
        results.push(unit);
      }
    }
    return results.sort((a, b) => b.confidence - a.confidence);
  }

  // 更新知识单元
  updateKnowledgeUnit(id, updates) {
    const unit = this.knowledgeUnits.get(id);
    if (unit) {
      Object.assign(unit, updates);
      unit.timestamp = Date.now();
      return true;
    }
    return false;
  }

  // 删除知识单元
  removeKnowledgeUnit(id) {
    const unit = this.knowledgeUnits.get(id);
    if (unit) {
      // 从索引中删除
      for (const tag of unit.tags) {
        if (this.index.has(tag)) {
          this.index.get(tag).delete(id);
        }
      }
      this.knowledgeUnits.delete(id);
      return true;
    }
    return false;
  }

  // 获取所有知识单元
  getAllKnowledgeUnits() {
    return Array.from(this.knowledgeUnits.values());
  }

  // 获取知识单元数量
  getSize() {
    return this.knowledgeUnits.size;
  }

  // 清理过期知识
  cleanupOldKnowledge(maxAge = 24 * 60 * 60 * 1000) { // 默认24小时
    const now = Date.now();
    const toRemove = [];
    
    for (const [id, unit] of this.knowledgeUnits.entries()) {
      if (now - unit.timestamp > maxAge) {
        toRemove.push(id);
      }
    }
    
    for (const id of toRemove) {
      this.removeKnowledgeUnit(id);
    }
    
    return toRemove.length;
  }
}

class ConflictResolver {
  constructor() {
    this.conflicts = new Map();
  }

  // 检测冲突
  detectConflict(knowledgeUnits) {
    const conflicts = [];
    
    // 简单的冲突检测：检查内容是否存在矛盾
    for (let i = 0; i < knowledgeUnits.length; i++) {
      for (let j = i + 1; j < knowledgeUnits.length; j++) {
        const ku1 = knowledgeUnits[i];
        const ku2 = knowledgeUnits[j];
        
        if (this.isConflicting(ku1.content, ku2.content)) {
          conflicts.push({
            id: `conflict_${Date.now()}_${i}_${j}`,
            timestamp: Date.now(),
            knowledgeUnits: [ku1.id, ku2.id],
            status: 'detected', // detected, resolving, resolved
            severity: this.calculateSeverity(ku1, ku2)
          });
        }
      }
    }
    
    return conflicts;
  }

  // 判断两个内容是否冲突
  isConflicting(content1, content2) {
    // 简单的冲突检测逻辑
    const conflictingPairs = [
      ['yes', 'no'],
      ['true', 'false'],
      ['available', 'unavailable'],
      ['exists', 'does not exist'],
      ['supported', 'not supported']
    ];
    
    const lowerContent1 = content1.toLowerCase();
    const lowerContent2 = content2.toLowerCase();
    
    for (const [term1, term2] of conflictingPairs) {
      if (lowerContent1.includes(term1) && lowerContent2.includes(term2)) {
        return true;
      }
      if (lowerContent1.includes(term2) && lowerContent2.includes(term1)) {
        return true;
      }
    }
    
    return false;
  }

  // 计算冲突严重程度
  calculateSeverity(ku1, ku2) {
    const confidenceDiff = Math.abs(ku1.confidence - ku2.confidence);
    if (confidenceDiff < 0.2) {
      return 'high';
    } else if (confidenceDiff < 0.4) {
      return 'medium';
    } else {
      return 'low';
    }
  }

  // 解决冲突
  resolveConflict(conflictId, resolution) {
    const conflict = this.conflicts.get(conflictId);
    if (conflict) {
      conflict.status = 'resolved';
      conflict.resolution = resolution;
      conflict.resolvedAt = Date.now();
      return true;
    }
    return false;
  }

  // 获取所有冲突
  getConflicts() {
    return Array.from(this.conflicts.values());
  }

  // 获取未解决的冲突
  getUnresolvedConflicts() {
    return Array.from(this.conflicts.values())
      .filter(conflict => conflict.status !== 'resolved');
  }
}

class KnowledgeSharingSystem {
  constructor() {
    this.knowledgeBase = new KnowledgeBase();
    this.conflictResolver = new ConflictResolver();
  }

  // 共享知识
  shareKnowledge(source, content, tags = [], confidence = 0.8) {
    const knowledgeUnit = new KnowledgeUnit(null, source, content, confidence);
    tags.forEach(tag => knowledgeUnit.addTag(tag));
    
    const id = this.knowledgeBase.addKnowledgeUnit(knowledgeUnit);
    
    // 检测冲突
    const relatedKnowledge = this.knowledgeBase.searchRelated(content);
    if (relatedKnowledge.length > 0) {
      const conflicts = this.conflictResolver.detectConflict([knowledgeUnit, ...relatedKnowledge]);
      conflicts.forEach(conflict => {
        this.conflictResolver.conflicts.set(conflict.id, conflict);
      });
    }
    
    return id;
  }

  // 获取知识
  getKnowledge(id) {
    return this.knowledgeBase.getKnowledgeUnit(id);
  }

  // 搜索知识
  searchKnowledge(query, tags = []) {
    if (tags.length > 0) {
      const results = new Set();
      for (const tag of tags) {
        const tagResults = this.knowledgeBase.searchByTag(tag);
        tagResults.forEach(result => results.add(result));
      }
      return Array.from(results);
    } else {
      return this.knowledgeBase.searchRelated(query);
    }
  }

  // 解决冲突
  resolveConflict(conflictId, resolution) {
    return this.conflictResolver.resolveConflict(conflictId, resolution);
  }

  // 获取冲突
  getConflicts() {
    return this.conflictResolver.getConflicts();
  }

  // 获取未解决的冲突
  getUnresolvedConflicts() {
    return this.conflictResolver.getUnresolvedConflicts();
  }

  // 获取知识统计
  getKnowledgeStats() {
    const units = this.knowledgeBase.getAllKnowledgeUnits();
    const conflicts = this.conflictResolver.getConflicts();
    
    return {
      totalKnowledgeUnits: units.length,
      totalConflicts: conflicts.length,
      unresolvedConflicts: conflicts.filter(c => c.status !== 'resolved').length,
      averageConfidence: units.length > 0 
        ? units.reduce((sum, unit) => sum + unit.confidence, 0) / units.length 
        : 0
    };
  }

  // 清理过期知识
  cleanupOldKnowledge(maxAge) {
    return this.knowledgeBase.cleanupOldKnowledge(maxAge);
  }
}

// 导出单例
const knowledgeSharingSystem = new KnowledgeSharingSystem();

module.exports = {
  KnowledgeUnit,
  KnowledgeBase,
  ConflictResolver,
  KnowledgeSharingSystem,
  knowledgeSharingSystem
};
const crypto = require("crypto");

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeEntityId(label) {
  return `entity:${crypto.createHash("sha1").update(normalizeToken(label)).digest("hex").slice(0, 10)}`;
}

function makeClaimKey(claim) {
  return [
    normalizeToken(claim.subject),
    normalizeToken(claim.type),
    normalizeToken(claim.unit),
    normalizeToken(claim.source_id)
  ].join("|");
}

function makeRelationKey(subjectId, predicate, objectId) {
  return [subjectId, normalizeToken(predicate), objectId].join("|");
}

function currentIsoTime() {
  return new Date().toISOString();
}

class KnowledgeGraph {
  constructor(context = {}) {
    this.context = context;
    this.entities = new Map();
    this.claims = new Map();
    this.relations = new Map();
    this.versions = [];
    this.versionCounter = 0;
    this.evolutionLog = [];
  }

  static fromExport(payload = {}) {
    const graph = new KnowledgeGraph(payload.context || {});
    graph.versionCounter = Number(payload.version_counter || payload.versions?.length || 0);
    graph.versions = Array.isArray(payload.versions) ? clone(payload.versions) : [];
    graph.evolutionLog = Array.isArray(payload.evolution_log) ? clone(payload.evolution_log) : [];

    for (const entity of payload.entities || []) {
      graph.entities.set(entity.id, clone(entity));
    }
    for (const claim of payload.claims || []) {
      graph.claims.set(claim.key, clone(claim));
    }
    for (const relation of payload.relations || []) {
      graph.relations.set(relation.key, clone(relation));
    }

    return graph;
  }

  upsertEntity(label, metadata = {}) {
    const cleanLabel = String(label || "").trim();
    if (!cleanLabel) {
      return null;
    }

    const id = makeEntityId(cleanLabel);
    const existing = this.entities.get(id);
    if (existing) {
      existing.aliases = Array.from(new Set([...existing.aliases, cleanLabel]));
      existing.metadata = { ...existing.metadata, ...metadata };
      return existing;
    }

    const entity = {
      id,
      label: cleanLabel,
      aliases: [cleanLabel],
      metadata: { ...metadata }
    };
    this.entities.set(id, entity);
    return entity;
  }

  buildClaimSnapshot(claim, metadata = {}) {
    return {
      claim: claim.claim || null,
      value: claim.value ?? null,
      unit: claim.unit || null,
      authority_score: Number(claim.authority_score || 0),
      published_at: claim.published_at || null,
      source_id: claim.source_id || null,
      source_type: metadata.source_type || null,
      evidence_span_ids: claim.evidence_span_ids || [],
      observed_at: currentIsoTime()
    };
  }

  upsertClaim(claim, metadata = {}) {
    const key = makeClaimKey(claim);
    const existing = this.claims.get(key);
    const snapshot = this.buildClaimSnapshot(claim, metadata);
    const now = currentIsoTime();

    if (!existing) {
      this.claims.set(key, {
        key,
        subject: claim.subject || metadata.subject_hint || "unknown",
        type: claim.type || "fact",
        status: "active",
        current: snapshot,
        history: [],
        first_seen_at: now,
        last_seen_at: now,
        observation_count: 1,
        evolution: {
          updates: 0,
          reaffirmations: 0,
          stale_transitions: 0,
          revivals: 0
        }
      });
      return { key, changed: true, operation: "claim_added" };
    }

    const changed = JSON.stringify(existing.current) !== JSON.stringify(snapshot);
    if (changed) {
      const conflict = this.detectConflict(existing.current, snapshot);
      if (conflict.conflict) {
        const resolved = this.resolveConflict(existing.current, snapshot, conflict);
        existing.history.push(existing.current);
        existing.current = resolved;
        existing.status = "active";
        existing.last_seen_at = now;
        existing.observation_count += 1;
        existing.evolution.updates += 1;
        if (existing.status === "stale") {
          existing.evolution.revivals += 1;
        }
        return {
          key,
          changed: true,
          operation: "claim_updated",
          conflict: true,
          resolution: resolved
        };
      }

      const revived = existing.status === "stale";
      existing.history.push(existing.current);
      existing.current = snapshot;
      existing.status = "active";
      existing.last_seen_at = now;
      existing.observation_count += 1;
      existing.evolution.updates += 1;
      if (revived) {
        existing.evolution.revivals += 1;
      }
      return {
        key,
        changed: true,
        operation: revived ? "claim_revived" : "claim_updated"
      };
    }

    const revived = existing.status === "stale";
    existing.status = "active";
    existing.last_seen_at = now;
    existing.observation_count += 1;
    existing.evolution.reaffirmations += 1;
    if (revived) {
      existing.evolution.revivals += 1;
    }
    return {
      key,
      changed: revived,
      operation: revived ? "claim_revived" : "claim_reaffirmed"
    };
  }

  detectConflict(existing, newClaim) {
    if (existing.value !== newClaim.value || existing.claim !== newClaim.claim) {
      const timeConflict = this.compareTimestamps(existing.published_at, newClaim.published_at);
      const authorityConflict = newClaim.authority_score - existing.authority_score;

      return {
        conflict: true,
        type: "value_conflict",
        existing_value: existing.value,
        new_value: newClaim.value,
        time_advantage: timeConflict,
        authority_advantage: authorityConflict
      };
    }
    return { conflict: false };
  }

  compareTimestamps(time1, time2) {
    if (!time1 || !time2) return 0;
    const date1 = new Date(time1);
    const date2 = new Date(time2);
    return date2.getTime() - date1.getTime();
  }

  resolveConflict(existing, newClaim, conflict) {
    let resolved = { ...existing };
    const timeScore = conflict.time_advantage > 0 ? 1 : 0;
    const authorityScore = conflict.authority_advantage > 0.1 ? 1 : 0;
    const totalScore = timeScore + authorityScore;

    if (totalScore >= 1) {
      resolved = { ...newClaim };
    }

    resolved.conflict_resolved = true;
    resolved.resolution_strategy = totalScore >= 1 ? "newer_more_authoritative" : "keep_existing";
    resolved.resolved_at = currentIsoTime();
    return resolved;
  }

  addRelation(subjectId, predicate, objectId, metadata = {}) {
    if (!subjectId || !objectId || !predicate) {
      return null;
    }
    const key = makeRelationKey(subjectId, predicate, objectId);
    if (!this.relations.has(key)) {
      this.relations.set(key, {
        key,
        subject_id: subjectId,
        predicate,
        object_id: objectId,
        metadata: { ...metadata }
      });
      return { key, changed: true };
    }
    return { key, changed: false };
  }

  markMissingClaimsAsStale(observedClaimKeys = []) {
    const observed = new Set(observedClaimKeys);
    const staleKeys = [];

    for (const [key, claim] of this.claims.entries()) {
      if (claim.status !== "active") {
        continue;
      }
      if (observed.has(key)) {
        continue;
      }

      claim.status = "stale";
      claim.stale_at = currentIsoTime();
      claim.evolution.stale_transitions += 1;
      staleKeys.push(key);
    }

    return staleKeys;
  }

  collectCounts() {
    const activeClaims = Array.from(this.claims.values()).filter((item) => item.status === "active").length;
    const staleClaims = Array.from(this.claims.values()).filter((item) => item.status === "stale").length;
    return {
      entities: this.entities.size,
      claims: this.claims.size,
      active_claims: activeClaims,
      stale_claims: staleClaims,
      relations: this.relations.size
    };
  }

  createEvolutionSummary(operations = [], hiddenLinks = [], staleClaims = []) {
    const summary = {
      added: 0,
      updated: 0,
      reaffirmed: 0,
      revived: 0,
      stale_marked: staleClaims.length,
      conflicts_resolved: 0,
      hidden_links_discovered: hiddenLinks.length
    };

    for (const item of operations) {
      if (item.type === "claim_added") summary.added += 1;
      if (item.type === "claim_updated") summary.updated += 1;
      if (item.type === "claim_reaffirmed") summary.reaffirmed += 1;
      if (item.type === "claim_revived") summary.revived += 1;
      if (item.conflict) summary.conflicts_resolved += 1;
    }

    return summary;
  }

  evolve(evidenceItems = [], metadata = {}) {
    const operations = [];
    const observedClaimKeys = [];
    for (const item of evidenceItems) {
      const sourceEntity = this.upsertEntity(item.title || item.source_id, {
        kind: "source",
        source_id: item.source_id,
        source_type: item.source_type,
        connector: item.source_metadata?.connector || null
      });

      for (const claim of item.claims || []) {
        const subjectEntity = this.upsertEntity(claim.subject || item.title || item.source_id, {
          kind: "subject"
        });
        const claimResult = this.upsertClaim(claim, {
          source_type: item.source_type,
          subject_hint: claim.subject
        });
        observedClaimKeys.push(claimResult.key);
        operations.push({
          type: claimResult.operation,
          key: claimResult.key,
          conflict: Boolean(claimResult.conflict)
        });

        if (sourceEntity && subjectEntity) {
          const relation = this.addRelation(subjectEntity.id, "supported_by", sourceEntity.id, {
            claim_key: claimResult.key
          });
          if (relation?.changed) {
            operations.push({
              type: "relation_added",
              key: relation.key
            });
          }
        }

        if (claim.value !== null && claim.value !== undefined && claim.value !== "") {
          const valueEntity = this.upsertEntity(
            claim.unit ? `${claim.value} ${claim.unit}` : String(claim.value),
            { kind: "value" }
          );
          if (subjectEntity && valueEntity) {
            const relation = this.addRelation(subjectEntity.id, claim.type || "states", valueEntity.id, {
              claim_key: claimResult.key
            });
            if (relation?.changed) {
              operations.push({
                type: "relation_added",
                key: relation.key
              });
            }
          }
        }
      }
    }

    const staleClaims = this.markMissingClaimsAsStale(observedClaimKeys);
    const hiddenLinks = this.discoverHiddenLinks();
    const evolutionSummary = this.createEvolutionSummary(operations, hiddenLinks, staleClaims);
    const version = this.createVersion(metadata.label || `version_${this.versionCounter + 1}`, {
      ...metadata,
      operations,
      stale_claim_keys: staleClaims,
      hidden_links: hiddenLinks,
      evolution_summary: evolutionSummary
    });

    this.evolutionLog.push({
      version_id: version.id,
      label: version.label,
      created_at: version.created_at,
      summary: evolutionSummary
    });

    return version;
  }

  importEvidence(evidenceItems = [], metadata = {}) {
    return this.evolve(evidenceItems, metadata);
  }

  createVersion(label, metadata = {}) {
    this.versionCounter += 1;
    const version = {
      id: `kgv_${this.versionCounter}`,
      label,
      created_at: currentIsoTime(),
      metadata: clone(metadata),
      counts: this.collectCounts()
    };
    this.versions.push(version);
    return version;
  }

  export() {
    return {
      context: this.context,
      version_counter: this.versionCounter,
      versions: clone(this.versions),
      latest_version: this.versions[this.versions.length - 1] || null,
      evolution_log: clone(this.evolutionLog),
      entities: Array.from(this.entities.values()).map(clone),
      claims: Array.from(this.claims.values()).map(clone),
      relations: Array.from(this.relations.values()).map(clone)
    };
  }

  discoverHiddenLinks() {
    const hiddenLinks = [];
    const claimsArray = Array.from(this.claims.values());

    for (let i = 0; i < claimsArray.length; i += 1) {
      const claim1 = claimsArray[i];
      for (let j = i + 1; j < claimsArray.length; j += 1) {
        const claim2 = claimsArray[j];
        if (this.isPotentialLink(claim1, claim2)) {
          const link = this.buildHiddenLink(claim1, claim2);
          if (link) {
            hiddenLinks.push(link);
          }
        }
      }
    }

    return hiddenLinks.slice(0, 20);
  }

  isPotentialLink(claim1, claim2) {
    if (claim1.subject === claim2.subject) return false;
    if (claim1.status === "stale" && claim2.status === "stale") return false;

    const text1 = (claim1.current.claim || "").toLowerCase();
    const text2 = (claim2.current.claim || "").toLowerCase();
    const keywords1 = this.extractKeywords(text1);
    const keywords2 = this.extractKeywords(text2);
    const commonKeywords = keywords1.filter((item) => keywords2.includes(item));

    return commonKeywords.length >= 1;
  }

  extractKeywords(text) {
    const stopWords = new Set(["the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "with", "by", "from"]);
    return (text.match(/\b\w+\b/g) || [])
      .filter((word) => word.length > 2 && !stopWords.has(word.toLowerCase()));
  }

  buildHiddenLink(claim1, claim2) {
    return {
      id: `hidden_link_${crypto.createHash("sha1").update(`${claim1.key}_${claim2.key}`).digest("hex").slice(0, 10)}`,
      subject: claim1.subject,
      object: claim2.subject,
      confidence: this.calculateConfidence(claim1, claim2),
      evidence: [
        { claim_key: claim1.key, text: claim1.current.claim },
        { claim_key: claim2.key, text: claim2.current.claim }
      ],
      discovered_at: currentIsoTime()
    };
  }

  calculateConfidence(claim1, claim2) {
    const text1 = (claim1.current.claim || "").toLowerCase();
    const text2 = (claim2.current.claim || "").toLowerCase();
    const keywords1 = this.extractKeywords(text1);
    const keywords2 = this.extractKeywords(text2);
    const commonKeywords = keywords1.filter((item) => keywords2.includes(item));

    const keywordScore = commonKeywords.length / Math.max(keywords1.length || 1, keywords2.length || 1);
    const authorityScore = (claim1.current.authority_score + claim2.current.authority_score) / 2;
    return Math.min(1, (keywordScore * 0.7) + (authorityScore * 0.3));
  }

  async updateFromNewEvidence(evidenceItems, context = {}) {
    const version = this.evolve(evidenceItems, {
      ...context,
      source: "auto_update"
    });

    return {
      success: true,
      operations: version.metadata?.operations || [],
      stale_claims: version.metadata?.stale_claim_keys || [],
      hidden_links: version.metadata?.hidden_links || [],
      evolution_summary: version.metadata?.evolution_summary || null,
      version
    };
  }
}

function buildKnowledgeGraphFromEvidence(evidenceItems = [], context = {}, label = "imported_evidence") {
  const graph = new KnowledgeGraph(context);
  graph.createVersion("initialized", { operations: [] });
  graph.importEvidence(evidenceItems, { label });
  return graph.export();
}

module.exports = {
  KnowledgeGraph,
  buildKnowledgeGraphFromEvidence
};

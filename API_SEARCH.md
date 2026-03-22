# Search API

## POST `/api/search`

Unified search-answer endpoint with normalized citations.

### Request

```json
{
  "query": "What changed in Sora recently?",
  "search_profile": "quality"
}
```

- `query` or `question`: required (either one)
- `search_profile`: optional, only `quality` is supported (default: `quality`)
- `mode`: optional, only `deep` is supported (default: `deep`)

### Response

```json
{
  "response_schema_version": "search_response.v1",
  "schema_version": "search.v1",
  "query": "What changed in Sora recently?",
  "mode": "deep",
  "search_profile": "quality",
  "task_id": "task_123",
  "answer": "short answer",
  "summary": "longer conclusion",
  "confidence": 0.82,
  "uncertainty": [],
  "citations": [
    {
      "source_id": "source-1",
      "title": "Example Source",
      "url": "https://example.com/source-1",
      "connector": "bing_web",
      "platform": "Bing Web",
      "published_at": "2026-03-18T00:00:00Z",
      "snippet": "Important finding"
    }
  ],
  "stop_state": {
    "should_stop_now": true,
    "reason": "llm_stop_decision"
  },
  "diagnostics": {
    "rounds": 2,
    "evidence_units": 1,
    "evaluator_mode": "llm",
    "mode_source": "search_profile"
  }
}
```

### Errors

- `400 invalid_request`: invalid payload (e.g. missing `query`)
- `400 invalid_json`: malformed JSON
- `500 search_failed`: research execution failed

## GET `/api/search/capabilities`

Returns supported mode, search profile, limits, and source capabilities.

### Response

```json
{
  "schema_version": "search-capabilities.v1",
  "modes": ["deep"],
  "default_mode": "deep",
  "search_profiles": {
    "values": ["quality"],
    "default": "quality",
    "mode_mapping": {
      "quality": "deep"
    }
  },
  "limits": {
    "max_citations": 10
  },
  "source_capabilities": [
    {
      "id": "bing_web",
      "label": "Bing Web",
      "capabilities": ["search", "web"]
    }
  ]
}
```

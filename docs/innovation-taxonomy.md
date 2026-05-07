# Innovation Taxonomy v1

> Source-of-truth for the Innovation Layer. All Phase 1–5 code MUST refer back to this document for canonical names, judgment conditions, and required data fields. Any change here triggers re-validation of Phase 2 `classifyInnovation()` and Phase 4 strategy selector.

## Layered concepts

The Innovation Layer separates four distinct concerns. They MUST NOT be collapsed into one score.

| Concept | Question it answers | Storage | Computed by |
|---------|---------------------|---------|-------------|
| **Landscape** | What does the existing literature look like? | `constructRelationshipsTable` + `sessions.landscapeMeta.theoryClusters` | Pure algorithm (Phase 1) |
| **Gap** | What evidence-backed holes exist? | `sessions.landscapeMeta.gapReport` (cached, version-keyed) | One AI call per session (Phase 3) |
| **Novelty** | How does THIS model differ from what's known? | `researchModels.edgeNoveltyTags` + `researchModels.noveltyScore` | Pure lookup (Phase 2) |
| **Contribution** | WHY does this difference have theoretical value? | `researchModels.contributionStatement` (jsonb) + `researchModels.contributionScore` | AI fills statement, server computes score (Phase 2) |

**Headline formula**:
```
Contribution = (Differentiation × GapFit × TheoreticalSoundness × EvidenceSupport) ^ 0.25 × 100
```
Geometric mean — any single dimension at 0 forces overall contribution to 0. This avoids the "rare = innovative" trap.

---

## The 6 innovation types

Every generated model carries `innovationTypes: string[]` (a model can satisfy multiple types). Five are auto-detectable from structured data; one is AI-judged in the gap report.

### 1. `mechanism` — 机制揭示 Mechanism Revelation

**Plain explanation**: Prior work shows X → Y but doesn't explain *why*. You insert a mediator.

**Auto-detect condition**:
- Model contains an edge `X --[mediated by M]--> Y` where:
  - `ConstructRelationship(X, Y, direct).totalOccurrences ≥ 3`, AND
  - `ConstructRelationship(X, M, direct).totalOccurrences ≤ 1` OR `ConstructRelationship(M, Y, direct).totalOccurrences ≤ 1`

**Required data**:
- `constructRelationshipsTable.totalOccurrences`
- model edges with `relationshipType = "mediation"`

**Auto-detectable**: ✅ Yes

---

### 2. `boundary` — 边界发现 Boundary Discovery

**Plain explanation**: Prior work assumes X → Y is universal. You find it depends on a moderator W.

**Auto-detect condition**:
- Model contains a moderator edge `W moderates (X → Y)` where:
  - `ConstructRelationship(X, Y, direct).totalOccurrences ≥ 3`, AND
  - W has never appeared as a moderator on this edge in any source paper's `perPaperGraph.moderators`

**Required data**:
- `constructRelationshipsTable.supportingPapers[].statement`
- model edges with `relationshipType = "moderation"`

**Auto-detectable**: ✅ Yes

---

### 3. `integration` — 理论整合 Theory Integration

**Plain explanation**: Two theories that don't normally talk to each other are first joined here.

**Auto-detect condition**:
- Model has both `backbone` and `secondaryBackbone` set, AND
- `backbone` and `secondaryBackbone` map to **different** clusters in `sessions.landscapeMeta.theoryClusters`

**Required data**:
- `papersTable.theoryBackbone[].id` (per-paper, multi-theory)
- `sessions.landscapeMeta.theoryClusters[]`

**Auto-detectable**: ✅ Yes

---

### 4. `correction` — 矛盾解决 Correction

**Plain explanation**: Prior papers disagree on the sign of X → Y. Your model explains why both can be right.

**Auto-detect condition**:
- Model contains edge X → Y where `ConstructRelationship(X, Y).signConflict = true`, AND
- Model also contains a moderator/mediator that connects to this edge (i.e. the model is not just re-asserting one side)

**Required data**:
- `constructRelationshipsTable.signConflict`
- model edges incident to the contested pair

**Auto-detectable**: ✅ Yes

---

### 5. `construct` — 构念延展 Construct Extension

**Plain explanation**: A construct rarely studied in this literature is brought in and connected to the core network.

**Auto-detect condition**:
- Model has at least one node N where:
  - `count of constructRelationships involving N within this session ≤ 1`, AND
  - N has ≥ 1 incident edge in the model (not orphaned)

**Required data**:
- `constructRelationshipsTable` per-variable occurrence counts
- model node connectivity

**Auto-detectable**: ✅ Yes

---

### 6. `context` — 情境迁移 Context Transfer

**Plain explanation**: Existing model is solid, but it's only been validated in setting A. You're applying it to setting B.

**Auto-detect condition**:
- Main structure overlap with literature ≥ 60% (most edges exist in `constructRelationshipsTable` with `totalOccurrences ≥ 2`), AND
- Session topic context (e.g. `objectType = "AI"`) **does not** appear in any source paper's `studyContext.objectType` set

**Required data**:
- `papersTable.studyContext.objectType` (and `industry`, `country`, `platformOrSetting`)
- session topic + extracted topic context

**Auto-detectable**: ❌ NO — handed off to AI in the Phase 3 gap report.

**Why not auto**: The "topic context not covered" check requires NLP-grade understanding of the topic string vs the papers' settings. A simple string-equality check is too fragile. The AI gap report (Phase 3.2) inspects studyContext + topic together and emits a `context` flag in `gapReport.gaps[].type` if applicable; Phase 4 then propagates this into `innovationTypes` for any model whose strategy was `context`.

---

## Hard rules (Phase 2)

These rules are added to the existing 19 generation Hard Rules. They MUST NOT appear in `SOFT_FAIL_PATTERNS` — failure triggers regeneration, not salvage.

- **Hard Rule #20**: `contributionStatement` MUST be present and all 7 sub-fields non-empty (`whatIsKnown`, `whatIsMissing`, `whatThisAdds`, `whyItMatters`, `researchGapClaim`, `theoreticalContribution`, `gapTypes` non-empty array, `contributionType` set).
- **Hard Rule #21**: `innovationTypes` MUST contain at least one of the 5 auto-detectable types OR the model's `gapTarget.strategyType` was `context` (in which case AI must justify in `whyItMatters`).
- **Hard Rule #22 (relaxed reject)**: Reject the model only if **all three** are true:
  - Every edge's `noveltyTag` ∈ {`saturated`, `established`}
  - `innovationTypes` is empty
  - `contributionScore < 30`

---

## Edge novelty tags (7 levels)

Every model edge gets exactly one tag from this enum. Tags are derived from `constructRelationshipsTable` lookup; no AI involved.

| Tag | Trigger | Subscore | Visual (Phase 2.6) |
|-----|---------|----------|--------------------|
| `saturated` | `totalOccurrences ≥ 7` | 10 | thin solid, gray |
| `established` | `totalOccurrences` 3–6 | 25 | medium solid, dark green |
| `underexplored` | `totalOccurrences` 1–2 | 60 | medium dashed, orange |
| `novel` | not in table | 85 | thick dashed, red |
| `contradicting` | `signConflict = true` | **95** | thick dotted, gold |
| `context_transferred` | in table BUT `studyContext.objectType` differs | 70 | medium solid, purple |
| `mechanism_inserted` | edge sits between 2 nodes that themselves are saturated, but this edge's full triple `(X, M, Y)` is not in table | 80 | medium dashed, blue |

`contradicting > novel` because challenging consensus is academically more valuable than a brand-new pairing.

---

## Score formulas

### `noveltyPotentialScore` (per ConstructRelationship row)

Bracketed, not linear, to avoid penalizing classic backbones:

| Occurrences | Score | Interpretation |
|-------------|-------|----------------|
| 0 | 100 | Pure novel space |
| 1 | 75 | Frontier (1 paper supports) |
| 2–3 | 50 | Initial validation |
| 4–6 | 25 | Established base |
| 7+ | 10 | Classical / saturated |

### `noveltyScore` (per model)

`= mean(edge.noveltyTag.subscore for edge in model.edges)`

### `contributionScore` (per model, the headline number)

```
differentiation       = noveltyScore  (already 0-100)
gapFit                = 100 if model.gapTypes ∩ landscapeMeta.gapReport.topGapTypes ≠ ∅ else 30
theoreticalSoundness  = 100 if backbone in evidencedBackbonesTally else 50
                      (further reduced by 10 per invalid operator usage; floor 30)
evidenceSupport       = 100 * (1 - droppedUngroundedEdges / totalEdges)

contributionScore     = round( ( differentiation/100 * gapFit/100 * theoreticalSoundness/100 * evidenceSupport/100 ) ^ 0.25 * 100 )
```

---

## Field naming contract (cross-Phase)

Phase 1 schema MUST use these exact names. Renaming requires updating this doc + Phase 2/3/4/5.

| Layer | Table | Column | Type |
|-------|-------|--------|------|
| Landscape | `papersTable` | `theoryBackbone` | `jsonb` (`Array<{id, label, evidenceText, confidence}>`) |
| Landscape | `papersTable` | `statedGaps` | `jsonb` (`Array<{text, sourceSection, gapType, confidence}>`) |
| Landscape | `papersTable` | `studyContext` | `jsonb` (object with industry, country, demographic, sampleType, method, platformOrSetting, objectType) |
| Landscape | `constructRelationshipsTable` | `sessionId, canonicalFrom, canonicalTo, contextQualifierFrom, contextQualifierTo, relationshipType, sign, totalOccurrences, supportingPapers, signConflict, earliestYear, latestYear, domainsCovered, noveltyPotentialScore, landscapeVersion` | as documented in Phase 1 |
| Landscape | `sessionsTable` | `landscapeMeta` | `jsonb` (theoryClusters, gapReport, lastRebuildAt, landscapeVersion) |
| Novelty | `researchModelsTable` | `noveltyScore` | `integer` |
| Novelty | `researchModelsTable` | `edgeNoveltyTags` | `jsonb` (`Map<edgeId, EdgeNoveltyTag>`) |
| Contribution | `researchModelsTable` | `contributionStatement` | `jsonb` |
| Contribution | `researchModelsTable` | `contributionScore` | `integer` |
| Contribution | `researchModelsTable` | `innovationTypes` | `text[]` (Postgres array, indexable) |
| Contribution | `researchModelsTable` | `gapTarget` | `jsonb` (which gap drove generation) |

---

## Three-layer canonicalize spec

`canonicalize(rawName)` returns:

```ts
{
  rawName: string,             // user-visible original
  canonicalName: string,       // normalized core construct ("trust")
  contextQualifier: string|null, // "AI streamer", "platform" — null if none
  constructFamily: string,     // canonicalName (alias for cross-family grouping)
}
```

Aggregation key in `constructRelationshipsTable` = `canonicalName + contextQualifier`. This separates `trust in AI streamer` from `trust in platform` while still allowing family-level rollups via `constructFamily`.

Implementation MUST be shared between `routes/variables.ts` and `lib/literature-landscape.ts` (single source in `lib/focus-selection.ts`). The 6-step normalization (NFKC → lowercase → punctuation→space → drop leading articles → drop residual punctuation → collapse whitespace) becomes the second of three layers.

---

## What this taxonomy does NOT cover

- **Method innovation** (e.g. "first to use longitudinal data") — out of scope; system focuses on construct/relationship innovation
- **Sample innovation** (e.g. "first to use Chinese teenagers") — partly captured under `context` but not as a primary type
- **Measurement innovation** (e.g. new scale development) — out of scope
- These are surfaced only in the Phase 5 reviewer-questions output, not in the structured `innovationTypes` field

---

## Change log

| Version | Date | Change |
|---------|------|--------|
| v1 | TBD (Phase 0) | Initial taxonomy locked. 6 types, 7 edge tags, 4-dim contribution formula. |

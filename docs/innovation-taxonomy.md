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

**Plain explanation**: Prior work assumes X → Y is universal. You find it depends on a moderator W. W *may* exist in the literature elsewhere — the innovation is using it as a moderator on *this* specific relationship for the first time, OR migrating it from another context.

**Auto-detect condition** (relaxed v2):
- Model contains a moderator edge `W moderates (X → Y)` where:
  - `ConstructRelationship(X, Y, direct).totalOccurrences ≥ 3` (X → Y is established/saturated), AND
  - **W has never appeared as a moderator on this specific (X, Y) edge** in any source paper's `perPaperGraph.moderators` — even if W appears elsewhere in the literature pool as a different role (IV / DV / mediator) or as a moderator on other edges.

**Required data**:
- `constructRelationshipsTable.supportingPapers[].statement`
- per-paper moderator structure (which W moderates which (X,Y) pair)
- model edges with `relationshipType = "moderation"`

**Auto-detectable**: ✅ Yes

**Note**: This relaxation captures the more common doctoral-thesis pattern where the moderator W is borrowed from an adjacent literature (e.g. self-construal from cross-cultural research) and applied as a boundary condition on a known relationship, rather than requiring W to be entirely absent from the literature pool.

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

**Plain explanation**: Prior papers disagree on the sign of X → Y. The contradiction itself is NOT the innovation — your model must *explain* the contradiction with a mechanism (mediator) or a boundary (moderator).

**Auto-detect condition** (two-tier):
- **Tier A — `correction` qualifies as an innovation type ONLY if BOTH**:
  1. Model contains edge X → Y where `ConstructRelationship(X, Y).signConflict = true`, AND
  2. Model also contains a moderator OR mediator that is structurally connected to this contested edge (moderator's `moderatedEdge` = (X,Y), OR a mediator on the X → M → Y path).
- **Tier B — observed-but-unresolved**: When (1) is true but (2) is false, the edge still gets the `contradicting` novelty tag for visualization, BUT `correction` is NOT added to `innovationTypes`. The contribution writeup must instead acknowledge the conflict as future work.

**Required data**:
- `constructRelationshipsTable.signConflict`
- model edges incident to the contested pair (mediator/moderator presence check)

**Auto-detectable**: ✅ Yes

**Note**: Discovering disagreement is descriptive. Resolving disagreement is theoretical contribution. This two-tier rule prevents models from claiming credit for `correction` just by re-stating a known controversy.

---

### 5. `construct` — 构念延展 Construct Extension

**Plain explanation**: A construct rarely studied in this literature is brought in AND connected to a core construct or core outcome of the network. Rare alone is not enough — it must hook into the central nervous system of the model.

**Auto-detect condition** (tightened v2):
- Model has at least one node N where ALL of:
  - `count of constructRelationships involving N within this session ≤ 1` (low-frequency in literature pool), AND
  - N has ≥ 1 incident edge in the model (not orphaned), AND
  - **At least one of N's incident edges connects to a "core" node M**, where M qualifies as core if EITHER:
    - M has `count of constructRelationships involving M ≥ 4` (high-frequency / saturated), OR
    - M has `type === "dependent"` in the model (a primary outcome variable).

**Required data**:
- `constructRelationshipsTable` per-variable occurrence counts
- model node types and edge incidence

**Auto-detectable**: ✅ Yes

**Note**: Without the core-connection clause, the system would reward dragging marginal variables into the model just because they're rare. The tightened rule enforces "rare AND structurally meaningful".

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

Every model edge gets exactly one tag from this enum. Tags are derived from `constructRelationshipsTable` lookup; no AI involved. Subscores are calibrated so doctoral-thesis-grade innovations (mechanism insertion, boundary extension) score on par with brand-new pairings.

| Tag | Trigger | Subscore | UI label (zh-CN) | Visual (Phase 2.6) |
|-----|---------|----------|------------------|--------------------|
| `saturated` | `totalOccurrences ≥ 7` | 10 | 成熟依据 | thin solid, gray |
| `established` | `totalOccurrences` 3–6 | 25 | 已建立 | medium solid, dark green |
| `underexplored` | `totalOccurrences` 1–2 | 55 | 未充分探索 | medium dashed, orange |
| `context_transferred` | in table BUT `studyContext.objectType` differs from session topic context | 70 | 情境迁移 | medium solid, purple |
| `novel` | not in table | 75 | 全新关系 | thick dashed, red |
| `mechanism_inserted` | edge sits on a path X → M → Y where X, Y, and X→Y are saturated but the full triple `(X, M, Y)` is not in table | 80 | 新机制嵌入 | medium dashed, blue |
| `boundary_extended` (renamed from moderated_extension) | edge is a moderator on an established (X, Y) pair, where this moderator has never been used on this specific (X, Y) | 80 | 新边界条件 | medium dashed, teal |
| `contradicting` (two-tier — see below) | `signConflict = true` | 80 base / 95 if resolved | 文献矛盾 / 已解释矛盾 | thick dotted, gold |

> **Threshold contract (single source of truth)**: the bracket boundaries
> live in `bracketByOccurrences()` (`artifacts/api-server/src/lib/innovation-scoring.ts`):
> `≥7 → saturated`, `≥3 → established`, `1–2 → underexplored`. The
> Landscape page UI MUST use the same `≥3` cutoff when classifying a
> relationship row as "established". Any change to these constants requires
> updating both this section and the UI labels in `i18n.tsx`
> (`landscape.bracket.*`, `landscape.relationships.help`).

### Why these scores

- **`saturated = 10` is intentionally low** for innovation purposes, but UI must label it neutrally as "成熟依据" — saturated edges are *necessary* skeleton for any defensible model. They are not "bad", just not innovative.
- **`underexplored = 55`** (was 25) recognizes that a 1–2 paper edge is meaningfully more open than a 3+ paper edge.
- **`novel = 75`** (was 85). A brand-new pairing without theoretical scaffolding is risky; mechanism / boundary insertions on established edges are doctorally safer and equally valuable.
- **`mechanism_inserted = 80` and `boundary_extended = 80`** equal-weight novel because "evidenced new mechanism / new boundary" is the most common high-quality doctoral-thesis innovation pattern.
- **`contradicting` is two-tier**:
  - **Base = 80** when `signConflict = true` and the edge appears in a model.
  - **Resolved = 95** when, additionally, the model contains a moderator (with `moderatedEdge = (X, Y)`) OR a mediator on the X → ... → Y path that structurally explains the conflict. Resolution check is the same as `correction` Tier A clause 2.

### Tag precedence (when multiple triggers fire)

Per-edge tag is determined by this single-pick precedence (top wins):

1. `contradicting` (resolved or base)
2. `mechanism_inserted`
3. `boundary_extended`
4. `context_transferred`
5. `novel`
6. `underexplored`
7. `established`
8. `saturated`

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

Four academically-named dimensions, geometric mean. Each dimension has a **non-zero floor** so that "cannot determine" never collapses the whole score to 0 — only an explicit violation does.

| Dimension | Academic name (UI label) | Computation |
|-----------|--------------------------|-------------|
| `differentiation` | 新颖性 / Novelty | `noveltyScore` (mean of edge subscores, 0–100) |
| `gapFit` | 间隙匹配 / Gap Fit | `100` if `model.gapTypes ∩ landscapeMeta.gapReport.topGapTypes ≠ ∅`; `60` if model claims a gap type not in the top set but defensible; `30` floor when no gap link claimed |
| `theoreticalSoundness` | 理论一致性 / Theoretical Soundness | `100` if `backbone` ∈ `evidencedBackbonesTally`; minus 10 per invalid operator usage; **floor 30** |
| `evidenceSupport` | 证据基础 / Evidence Base | tiered (see below); **floor 20** |

**`evidenceSupport` tiering** (no longer linear):

```
direct  = (totalEdges - droppedUngroundedEdges) / totalEdges  # verbatim corpus match
analog  = fraction of remaining edges that AI tagged as "analogically supported" in evidenceCitationText
theory  = fraction of remaining edges grounded only by the chosen backbone's theoretical predictions

evidenceSupport = round( min(100, 100*direct + 60*analog + 40*theory) )
                  with floor of 20 when at least one edge has any of the three
                  with hard 0 only when ALL edges are ungrounded
```

This prevents truly novel edges (which inherently lack direct citations) from being unfairly penalized when they have analogical or theoretical support.

**Headline formula** (geometric mean):

```
contributionScore = round(
  ( differentiation/100
  * gapFit/100
  * theoreticalSoundness/100
  * evidenceSupport/100
  ) ^ 0.25 * 100
)
```

**Zero rules — explicit only**:

| Dimension | Score = 0 only when | "Cannot judge" defaults to |
|-----------|--------------------|-----------------------------|
| `differentiation` | All edges are `saturated` (every edge subscore = 10 → mean = 10, never literal 0) | n/a — always computable |
| `gapFit` | Model claims a `gapType` that does not exist in `gapReport.allGapTypes` (fabricated gap) | floor 30 (no claim made) |
| `theoreticalSoundness` | `backbone` is empty string OR contradicts every paper's `theoryBackbone[]` | floor 30 |
| `evidenceSupport` | ALL edges have zero direct + zero analog + zero theory grounding | floor 20 (any one form present) |

**UI requirement (Phase 2.6)**: model card MUST display all four sub-scores alongside the headline `contributionScore` so the user sees the short axis. Hovering each sub-score shows its computation and the "if you want to raise this" tip.

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
| v1 | Phase 0 draft | Initial taxonomy. 6 types, 7 edge tags, 4-dim contribution formula. |
| **v2** | Phase 0 final | (1) `boundary` relaxed: W not required to be absent from literature, only absent as moderator on this (X,Y). (2) `correction` two-tier: requires resolution mechanism for innovationType credit; otherwise just gets `contradicting` visualization. (3) `construct` tightened: low-freq construct must connect to a high-freq core node OR a dependent variable. (4) Edge novelty subscores rebalanced: underexplored 25→55, novel 85→75, mechanism_inserted/boundary_extended both 80, contradicting two-tier 80/95. (5) `boundary_extended` renamed (was `moderated_extension`). (6) `contributionScore` dimensions academically renamed; non-zero floors added (gapFit 30, theoreticalSoundness 30, evidenceSupport 20); `evidenceSupport` switched from linear-direct to direct/analog/theory tiered. (7) Tag precedence list added for multi-trigger edges. (8) UI sub-score display made mandatory. |

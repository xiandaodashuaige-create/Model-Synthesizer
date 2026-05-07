# Research Model Builder

A full-stack web application for academic researchers to discover papers, extract variables with AI, and generate novel theoretical research models with citation evidence.

## Run & Operate
```bash
pnpm --filter @workspace/api-spec run codegen   # Regenerate client code
pnpm --filter @workspace/db run push            # Push DB schema changes
```
**Environment Variables:**
- `DATABASE_URL`: PostgreSQL connection string
- `SESSION_SECRET`: Session secret
- `AI_INTEGRATIONS_OPENAI_BASE_URL` / `AI_INTEGRATIONS_OPENAI_API_KEY`: OpenAI proxy
- `SERPAPI_API_KEY`: Required for fetching paper model figures
- `REPL_ID`, `ISSUER_URL` (default `https://replit.com/oidc`): Auth via OIDC

## Stack
- **Frontend**: React + Vite (TypeScript), TailwindCSS v4, Wouter, TanStack Query
- **Backend**: Express 5 (TypeScript), Pino, esbuild
- **Database**: PostgreSQL via Drizzle ORM
- **AI**: OpenAI GPT-4o (`gpt-5.4` flagship; `gpt-5-mini` on low-stakes routes) via Replit AI Integrations
- **Paper Search**: OpenAlex API
- **Monorepo**: pnpm workspaces

## Where things live
- `artifacts/api-server`: Express REST API server
- `artifacts/research-model`: React+Vite frontend
- `lib/api-spec/openapi.yaml`: OpenAPI 3.0 spec (source-of-truth for API contracts)
- `lib/db/src/schema`: Drizzle ORM schema (source-of-truth for DB)
- `lib/i18n.tsx`: i18n strings (source-of-truth for translations)
- `docs/innovation-taxonomy.md`: Source-of-truth for the Innovation Layer (Landscape / Gap / Novelty / Contribution)
- `docs/changelog.md`: Stable historical architecture decisions (archive)

## Architecture decisions

### Innovation Layer (in development — see `docs/innovation-taxonomy.md` for the full spec)

The product is being upgraded from "research model generator" to "research model innovation argumentation assistant". Four separated concerns:

- **Landscape**: per-session `constructRelationshipsTable` aggregates every paper's hypothesis edges; `sessions.landscapeMeta` stores theory clusters and the AI-generated gap report. Pure algorithm, scales linearly with paper count via debounced batch rebuild.
- **Gap**: 6 gap categories (`mechanism`, `boundary`, `integration`, `correction`, `construct`, `context`) — 5 auto-detected from landscape, 1 (context) judged by a single AI gap-report call per session, cached by `landscapeVersion`.
- **Novelty**: each model edge gets one of 7 `edgeNoveltyTags` from a pure lookup, with single-pick precedence (contradicting > mechanism_inserted > boundary_extended > context_transferred > novel > underexplored > established > saturated); aggregated to a per-model `noveltyScore`. Subscores are calibrated so doctorally-safe innovations (mechanism_inserted=80, boundary_extended=80) are not outranked by raw novelty (novel=75); `contradicting` is two-tier (80 base, 95 only when the model also contains a moderator/mediator that resolves the conflict).
- **Slice 1 status (shipped)**: `researchModelsTable.innovationMeta jsonb` (nullable) populated on every new model; never hard-rejects (Hard Rules #20–22 warn-only). `coverageRate < 0.7` forces `mode: "analysis_only"`. Each meta carries `computedAgainst.{landscapeVersion, coverageRate, computedAt}`; `formatModel()` decorates with `stale: true` when the session's current `landscapeVersion` ≠ the one the score was computed against. `POST /sessions/:id/models/:modelId/recompute-innovation` (auth-gated by `loadAuthorizedSession`) re-scores against current landscape (used by the "刷新评分" UX and by `scripts selftest:phase-2 <sessionId>`). `contributionStatement` intentionally `null` until slice 2.
- **Contribution**: `contributionStatement` (jsonb) carries the structured 7-field self-explanation (whatIsKnown / whatIsMissing / whatThisAdds / whyItMatters / researchGapClaim / theoreticalContribution / gapTypes / contributionType); `contributionScore` is the geometric mean of `differentiation` × `gapFit` × `theoreticalSoundness` × `evidenceSupport` with non-zero floors (gapFit 30, theoreticalSoundness 30, evidenceSupport 20) so "cannot judge" never collapses the headline to 0; `evidenceSupport` is tiered (direct/analog/theory) so truly novel edges are not unfairly penalized for lacking direct citations. UI MUST display all four sub-scores. Hard Rules #20–22 enforce non-empty statement and reject all-saturated models that match no innovation type.
- **Doctoral-thesis calibration** (taxonomy v2): `boundary` only requires the moderator be unused on this specific (X,Y), not absent from literature; `correction` is two-tier (gets innovationType credit only when the model contains a resolution mechanism, otherwise just visualizes the conflict); `construct` requires the low-freq construct to connect to a high-freq core node OR a dependent variable.

The 3-layer `canonicalize()` returns `{rawName, canonicalName, contextQualifier, constructFamily}` so `trust in AI streamer` and `trust in platform` aggregate as separate rows but can be rolled up by family.

### Paper search & extraction
- **Search relevance pool (`routes/papers.ts`)**: 50-result OpenAlex pool sorted by `relevance_score:desc`, cached by `(query, page)`; sort tabs re-sort the cached pool in memory (no extra API hits). 15s timeout + 1 retry; errors mapped to Chinese toasts.
- **Variable extraction (`routes/variables.ts`)**: concurrency=4. UMBRELLA RULE — when a paper studies a named entity (AI broadcast / chatbot Eva), AI emits a bare-entity umbrella row in addition to perceived-dimension rows.
- **Custom / manual variables**: backed by per-session sentinel paper (`externalId='manual:${sessionId}'`), filtered out of every "real literature" query site.
- See `docs/changelog.md` for OpenAlex retry semantics, sentinel paper rationale, and the umbrella prompt history.

### Model generation reliability (`routes/models.ts`)
- **JSON-mode + parallel per-model fanout** with `{"models":[...]}` envelope. Each parallel call gets a different operator-pair VARIANT HINT, ~5k tokens each.
- **Route-deadline race**: `tRouteStart` anchored at top of route, `ROUTE_DEADLINE_MS = 52_000`. Per-call timeout sized dynamically, plus a 500ms poll that early-aborts pending calls once `fulfilledCount ≥ 1` and 80% of the budget has elapsed. Replaces the old `Promise.allSettled(50s)` that routinely hit the 60s autoscale wall.
- **Prompt structure**: PRIMARY USER DIRECTIVE mirrored at top + end of prompt; RECENT CHAT INTENT injected after directive; PRIOR-WORK PATTERN SUMMARY biases AI toward source-paper patterns when `userPrompt` is empty.
- **Hard Rules** (NOT in `SOFT_FAIL_PATTERNS` — failure triggers regeneration, not salvage):
  - #12 Moderator-targets-a-PATH (`moderatedEdge:{from,to}` must name a real edge)
  - #15 Focus-pick enrichment (≥1 non-pick structural node)
  - #17 No floating nodes (focus picks protected so the focus-orphan check fires)
  - #18 Tangential-paper exclusion overrides #4
  - #19 Chain integrity (every IV reaches DV; mediators have ≥1 incoming AND ≥1 outgoing)
  - **Pending #20–22 from Innovation Layer** — see `docs/innovation-taxonomy.md`
- **Auto-repair passes**: stranded-IV outgoing rescue (clones strongest sibling stimulus IV's edge); dangling-mediator outgoing rescue (clones a mediator-to-DV edge from another mediator); both run BEFORE the floating-node prune; tracked via `repairStats`.
- **Topic + user-named role bindings**: regex extracts `X 对 Y 的影响` and `X 作为中介` from topic and userPrompt, fuzzy-matches against the variable pool with PREFER-UMBRELLA tiebreaker, injects into prompt as SERVER-PARSED ROLE BINDINGS, hard-checks in `validate()`.
- **Tightened SOFT_FAIL_PATTERNS**: node count / edge count / floating focus pick are NOT soft-fails; they trigger regeneration.
- **Rescue/top-up to numModels**: top-up runs whenever `accepted.length < numModels` (not just zero), and dedup is relaxed to "op-pair AND base-set collision" so partial-success cases reach the requested count.
- **Server-side `validate()`** also enforces: Three-Dimension Intent (focus picks must be structural nodes), Hard Rule #16 backbone alignment (soft-fail), Evidence Grounding (per-paper corpus verifies `evidenceCitationText`), Focus Connectivity (≥ min(picks,2) edges touching focus).
- See `docs/changelog.md` for the full history of each fix.

### Live model UX (`pages/sessions/live-model.tsx` + `routes/live-model.ts`)
- Two-pass moderator import (non-moderator edges first, then moderator edges with `moderatesEdgeId` set).
- Edge list shows "X moderates [A → B]" via violet pill resolving `moderatesEdgeId`.
- `hoveredEdgeId` synced bidirectionally with `EditableModelGraph`; deleted edges recyclable via `localStorage["liveModelTrash:${sessionId}"]` (cap 20 FIFO).
- **PNG export (`lib/export-live-model-image.ts`)**: bypasses html-to-image (cross-origin stylesheet errors on Replit). Builds SVG string with no external resources, rasterizes via `data:image/svg+xml` → `<img>` → canvas at 2x. Layout reuses persisted positionX/Y, falls back to deterministic columnar.
- Variable pool keyword search; collapsible "+ 自定义新变量"; auto-jump to live-model after 选用此模型 inside `importLiveModel.onSuccess`.

### Cost & visibility (`lib/ai-usage.ts` + `ai-usage-panel.tsx` + `routes/ai-usage.ts`)
- Per-route tier with date-suffix-stripping resolver and gpt-5.4 fallback so unknown models never under-bill. 5 low-stakes routes downgraded to `gpt-5-mini`; flagship stays on `models/generate*`, `extract-paper-research-model`, `variables/extract`, `chat`.
- **积分**: 1 积分 = $0.01; DB stores micro-USD, rate applied at display only.
- **Savings**: backend recomputes each row at flagship rate, returns `flagshipCostUsd` + `savedCostUsd` per route AND total. Header byline appends ` · N 积分 (−M)`.
- **Value mode (default)**: papers/variables/models from `useGetSessionSummary` + conservative labor estimate (0.5h/paper + 0.2h/variable + 1.5h/model). Cost-audit table behind `localStorage["ai-usage-dev-mode"]` toggle.

### Reference-figure UX
- Chat opening nudge in `model-assistant-chat.tsx` surfaces 2-3 AI-distilled query buttons; dismissal persisted to localStorage.
- `POST /sessions/{id}/model-assistant/distill-nudge-queries` — `gpt-5-mini` returns `{queries: [{label, query}]}` with hard server-side `compactDistilledQuery()` enforcement (≤8 words, banned padding stripped).
- Per-edge "找参考图" button on every unsupported edge opens `ReferenceFigureDialog` with `{from} {REL_WORD[rel]} {to} conceptual model` query.
- See `docs/changelog.md` for the long-query bug history, race-guard, and cache details.

### Evidence search (`lib/evidence-matching.ts` + `evidence-match-dialog.tsx`)
- Per-edge focus mode: 1 fan-out instead of N when `focusEdgeKey` provided; auto-enables `wantImages`.
- Google Scholar source via SerpAPI alongside OpenAlex; library proxy template (`localStorage["evidence.libraryProxyTemplate"]`); per-hit Google Scholar escape-hatch icon.
- Per-edge figures via SerpAPI google_images, only fetched for ≤3 edges.

### Variable cluster dedup (will be wrapped by Phase 1 of Innovation Layer)
- Shared 6-step normalization in `normalizeName()` (`lib/focus-selection.ts`) and `canonicalize()` (`routes/variables.ts`): NFKC → lowercase → hyphens/dashes/underscores/slashes → space → strip leading articles → drop residual punctuation → collapse whitespace. MUST stay in lock-step.
- localStorage v1→v2 migration on focus-pick keys; `/variable-graph` aligned to use the same `canonicalize()`.
- **Phase 1 will wrap this into a 3-layer `canonicalize()`** returning `{rawName, canonicalName, contextQualifier, constructFamily}` — the existing 6-step rule becomes layer 2.

### Cross-cutting
- **Client codegen**: OpenAPI generates Zod validators + React Query hooks; codegen overwrites `lib/api-zod/src/index.ts`.
- **Global 401 interceptor**: throttled `window` event triggers re-login overlay.
- **Image search pipeline**: AI query expansion → parallel search → relevance filter. Literal fallback uses `compactDistilledQuery(rawQuery)` (or first 8 words) when `rawQuery` word count > 10, preventing 25+ word phrases that match nothing on Google Images.
- **Search cache**: in-memory, 15 min TTL.

## Product
- Session management with defined topics
- Paper discovery & management (OpenAlex)
- AI variable extraction with definitions and citations
- Variable & relationship visualization
- AI model generation with citation evidence
- Live model building with provenance-tracked edges
- Quality reports & literature review assembly
- Model figure search (SerpAPI)
- A/B model comparison
- Markdown / DOCX export
- Persistent AI chat history
- **In development**: Landscape view, Gap-driven generation, Innovation type classification, Contribution statement, Reviewer simulator, Conversation positioning

## User preferences
- Language: zh-CN; communicate in plain everyday language (no jargon, no emojis)
- Each upgrade Phase ships an internal self-test (`scripts/src/selftest-phase-N.ts`) before user verification (D1–D8 in `docs/innovation-upgrade-plan.md` if/when created)

## Gotchas
- **OpenAlex**: 15s timeout + 1 retry. Sort tabs serve from cached relevance pool (no extra API calls).
- **AI extraction**: concurrency=4 to stay under proxy rate limits.
- **Codegen**: `lib/api-spec` codegen overwrites `lib/api-zod/src/index.ts`. Post-codegen `typecheck:libs` may fail due to a pre-existing issue in `lib/integrations-openai-ai-server` — orval generation itself still succeeds.
- **Sentinel paper**: never include the manual-additions sentinel in literature counts or AI prompt context — use the `NOT_MANUAL_PAPER` SQL fragment / equivalent filter at every read site.
- **Innovation Layer field names**: `docs/innovation-taxonomy.md` is the source of truth. Renaming any column there triggers re-validation across Phase 1/2/3/4/5.
- **canonicalize() lock-step**: client `normalizeName()` and server `canonicalize()` MUST produce identical output; Phase 1's 3-layer wrapper does not change this requirement.

## Pointers
- OpenAlex API: https://docs.openalex.org/
- Drizzle ORM: https://orm.drizzle.team/
- TanStack Query: https://tanstack.com/query/latest
- Wouter: https://www.npmjs.com/package/wouter
- SerpAPI: https://serpapi.com/

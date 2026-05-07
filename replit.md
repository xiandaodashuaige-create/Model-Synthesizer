# Research Model Builder
A full-stack web application for academic researchers to discover papers, extract variables with AI, and generate novel theoretical research models with citation evidence.

## Run & Operate
```bash
pnpm --filter @workspace/api-spec run codegen # Regenerate client code
pnpm --filter @workspace/db run push # Push DB schema changes
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

## Architecture decisions
### Paper search & extraction
- **Search relevance pool (`routes/papers.ts`)**: always fetches a 50-result pool from OpenAlex sorted by `relevance_score:desc`, caches by `(query, page)` only — NOT by sort/limit. Year/citations sorts re-sort the pool in memory via `resortPool()` (stable sort: ties broken by relevance order; nulls sink). Sort-tab toggles never re-hit OpenAlex, eliminating 429 toasts. Replaces direct API-side year/citation sorting which surfaced unrelated newest/most-cited papers (e.g. "AI broadcast" → "Real Time Collaborative Code Editor"). Inputs are floor/clamped (`page≥1`, `limit∈[1,50]`) before keying the cache.
- **OpenAlex resilience**: 15s timeout, one retry on transient (timeout/5xx/network). Errors mapped to Chinese toasts (`openAlexErrorResponse`).
- **Variable extraction**: parallelized concurrency=4. Prompt rewritten in `routes/variables.ts` to emphasize system-characteristic IVs. UMBRELLA RULE: when a paper studies a named entity (AI broadcast / virtual streamer / chatbot Eva), AI MUST emit a bare-entity umbrella row (`type=independent`, `layer=stimulus`, name = entity verbatim) IN ADDITION to perceived-dimension rows.
- **Custom / manual variables**: POST `/sessions/:id/variables` lets users add constructs the AI didn't extract. Backed by a lazily-created per-session sentinel paper (`externalId='manual:${sessionId}'`) so `variables.paperId` stays NOT NULL. Concurrent first-creates deduped by in-process `Map<sessionId,Promise>` lock. Sentinel filtered out of EVERY "real literature" query (papers list, paper-count queries in `routes/sessions.ts`, model-generation papers load + threshold checks, model-detail meta, chat context + image queries, personalization profile both per-session and cross-session).

### Model generation reliability (`routes/models.ts`)
- **JSON-mode + parallel per-model**: `response_format: { type: "json_object" }` with `{"models":[...]}` envelope (12k token budget). Defensive `extractAndRepairJson()` (prose wrapper / markdown fence / bracket-balance) kept as fallback. Generation fans out N parallel single-model calls (~5k tokens each, 50s abort) instead of one N-model call — stays under 60s autoscale, returns partial successes, seeds each call with a different operator-pair "VARIANT HINT".
- **Prompt structure**: PRIMARY USER DIRECTIVE mirrored at TOP and END of prompt so it survives the 30k-token middle. RECENT CHAT INTENT block (last 6 sanitized user turns from `modelAssistantMessagesTable`) injected after directiveBlock — bridges the hourly personalization profile and live chat. PRIOR-WORK PATTERN SUMMARY aggregates `perPaperModels` into a fingerprint (backbone tally, recurring constructs by role, IV→DV chain length, moderator landing position); when `userPrompt` is empty, header switches to "LEAN INTO THESE PATTERNS" so AI biases toward source papers instead of pre-training defaults (always-SOR, moderator-on-DV).
- **USER-NAMED ROLE BINDING**: when user types "X 作为自变量", 4-step procedure: (A) bilingual-map; (B) scan EXTRACTED VARIABLES POOL for ≥70% match → USE LITERALLY; (C) only if no match, may operationalize via dimensions AND `[USER PROMPT FIT]` MUST disclose with exact pattern "用户指定『<名>』作为<角色>；变量库中无统一的『<名>』构念，故以其感知维度...作为<角色>的操作化"; (D) literal match wins.
- **Server-side validators** (`validate()`):
  - Three-Dimension Intent: ≥ min(focusPicks, 2) focus vars must appear as STRUCTURAL nodes (matched by id / canonicalConstructId / lower-cased name); soft-fail.
  - Hard Rule #12 (Moderator-targets-a-PATH): every `moderates` edge MUST carry `moderatorJustification` + `moderatedEdge:{from,to}` naming a real non-moderator edge in the same model. Auto-repair drops invalid; validate() hard-rejects self-referential.
  - Hard Rule #15 ENRICHMENT: when focus picks exist, ≥1 non-pick structural node from literature pool.
  - Hard Rule #16 BACKBONE ALIGNMENT (soft-fail): chosen `backbone` must be in evidenced backbones tally.
  - Hard Rule #17 + auto-repair NO-FLOATING-NODE: prune nodes with zero incident edges (focus picks PROTECTED so existing focus-orphan check fires); validate() hard-rejects remaining floaters BEFORE node/edge counts.
  - Hard Rule #18: tangential-paper exclusion overrides Rule #4's ≥3-paper minimum.
  - Evidence Grounding: per-paper evidence corpus (full text + abstract + variable citations + hypothesis statements + per-paper graph) verifies each `evidenceCitationText` via verbatim or 6-word window; ungrounded edges dropped, counted as `droppedUngroundedEdges`.
  - Focus Connectivity: every focus-pick node ≥1 incident edge AND ≥ min(picks,2) edges touching focus.

### Live model UX (`pages/sessions/live-model.tsx` + `routes/live-model.ts`)
- **Two-pass moderator import**: pass 1 inserts non-moderator edges, pass 2 builds `(fromVar→toVar)→liveEdgeId` map and inserts moderator edges with `moderatesEdgeId` set. Without this, canvas rendered moderator→DV.
- **Edge list rendering**: moderator rows show "X moderates [A → B]" via violet pill resolving `moderatesEdgeId`.
- **Highlight sync**: `hoveredEdgeId` shared bidirectionally with `EditableModelGraph` via `highlightEdgeId`/`onEdgeHover`.
- **Edge recycle bin**: deleted edges pushed to `localStorage["liveModelTrash:${sessionId}"]` (cap 20 FIFO).
- **PNG export (`lib/export-live-model-image.ts`)**: bypasses html-to-image (which fails on Replit due to cross-origin stylesheet SecurityError + 520'd font/bg fetches). Builds SVG string from nodes/edges with NO external resources, rasterizes via `data:image/svg+xml` → `<img>` → canvas → `toDataURL` at 2x. Layout reuses persisted positionX/Y, falls back to deterministic columnar by type.
- **Variable pool keyword search**: `poolQuery` filters sidebar by name + type + definition (case-insensitive, zh+en).
- **Custom variable form**: collapsible "+ 自定义新变量" in pool sidebar; on success invalidates list and drops new var on canvas.
- **Auto-jump after '选用此模型'**: navigate to `/sessions/:id/live-model` inside `importLiveModel.onSuccess` (NOT `selectModel.onSuccess` — destination would show stale data).

### Cost & visibility (`lib/ai-usage.ts` + `ai-usage-panel.tsx` + `routes/ai-usage.ts`)
- **Per-route tier**: per-model lookup table (`gpt-5.4` $2.5/$10, `gpt-5-mini` $0.25/$2 per 1M, etc.) with date-suffix-stripping resolver and gpt-5.4 fallback so unknown models never under-bill. 5 low-stakes routes downgraded to `gpt-5-mini` (`expand-image-queries`, `image-relevance`, `screen-papers`, `upload-pdf-metadata`, `literature-review`); flagship stays on `models/generate*`, `extract-paper-research-model`, `variables/extract`, `chat`.
- **积分 display**: 1 积分 = $0.01. `fmtCredits()` with one-decimal sub-1 values. DB stores micro-USD; rate applied at display only.
- **Savings**: backend `groupBy(route, model)` recomputes each row at flagship rate, returns `flagshipCostUsd` + `savedCostUsd` per route AND total. Default 3×2 grid shows "已花积分" + "已省积分" (`+N` emerald). Header byline always appends ` · N 积分 (−M)`.
- **Value mode (default)**: papers/variables/models from `useGetSessionSummary` + conservative labor estimate (0.5h/paper + 0.2h/variable + 1.5h/model). Cost-audit table behind `localStorage["ai-usage-dev-mode"]` toggle.

### Cross-cutting
- **Client codegen**: OpenAPI generates Zod validators + React Query hooks. Codegen overwrites `lib/api-zod/src/index.ts`.
- **Global 401 interceptor**: throttled `window` event triggers re-login overlay.
- **Image search pipeline**: AI query expansion → parallel search → relevance filter.
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

## User preferences
_Populate as you build_

## Gotchas
- **OpenAlex**: 15s timeout + 1 retry. Sort tabs serve from cached relevance pool (no extra API calls).
- **AI extraction**: concurrency=4 to stay under proxy rate limits.
- **Codegen**: `lib/api-spec` codegen overwrites `lib/api-zod/src/index.ts`. Post-codegen `typecheck:libs` may fail due to a pre-existing issue in `lib/integrations-openai-ai-server` — orval generation itself still succeeds.
- **Sentinel paper**: never include the manual-additions sentinel in literature counts or AI prompt context — use the `NOT_MANUAL_PAPER` SQL fragment / equivalent filter at every read site.

## Pointers
- OpenAlex API: https://docs.openalex.org/
- Drizzle ORM: https://orm.drizzle.team/
- TanStack Query: https://tanstack.com/query/latest
- Wouter: https://www.npmjs.com/package/wouter
- SerpAPI: https://serpapi.com/

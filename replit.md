# Research Model Builder
A full-stack web application that helps academic researchers discover papers, extract research variables using AI, and generate novel theoretical research model combinations with full citation evidence.

## Run & Operate
```bash
# Regenerate client code after editing lib/api-spec/openapi.yaml
pnpm --filter @workspace/api-spec run codegen

# Push DB schema changes after editing schema files
pnpm --filter @workspace/db run push
```
**Environment Variables:**
- `DATABASE_URL`: PostgreSQL connection string
- `SESSION_SECRET`: Session secret
- `AI_INTEGRATIONS_OPENAI_BASE_URL`: OpenAI proxy base URL
- `AI_INTEGRATIONS_OPENAI_API_KEY`: OpenAI proxy key
- `SERPAPI_API_KEY`: Required for fetching paper model figures
- `REPL_ID`, `ISSUER_URL` (default `https://replit.com/oidc`): Auth via OIDC

## Stack
- **Frontend**: React + Vite (TypeScript), TailwindCSS v4, Wouter, TanStack Query
- **Backend**: Express 5 (TypeScript), Pino, esbuild
- **Database**: PostgreSQL via Drizzle ORM
- **AI**: OpenAI GPT-4o via Replit AI Integrations
- **Paper Search**: OpenAlex API
- **Monorepo**: pnpm workspaces

## Where things live
- `artifacts/api-server`: Express REST API server
- `artifacts/research-model`: React+Vite frontend
- `lib/api-spec/openapi.yaml`: OpenAPI 3.0 specification (source-of-truth for API contracts)
- `lib/db/src/schema`: Drizzle ORM database schema (source-of-truth for DB schema)
- `lib/i18n.tsx`: Internationalization strings (source-of-truth for i18n)

## Architecture decisions
- **AI Model**: Uses `gpt-5.4` via Replit's AI Integrations proxy for variable extraction and model generation.
- **Paper Search**: Relies on OpenAlex API for paper search, chosen for its open access, lack of API key requirements, and absence of rate limiting issues.
- **Client Code Generation**: OpenAPI specification is used to generate Zod validators and React Query hooks, ensuring type safety and consistency between frontend and backend.
- **Monorepo Structure**: Utilizes pnpm workspaces to manage multiple packages, facilitating shared code and streamlined development.
- **Image Search Pipeline**: Employs a multi-stage pipeline for finding research model figures, including AI-powered query expansion, parallel search lanes, and relevance filtering.
- **Generation Guardrails**: Implements multiple layers of checks and UI blocking to prevent model generation on incomplete variable sets, ensuring data integrity.
- **Partial-pass model generation**: Allows model generation even if some papers are un-extracted, recording metadata about skipped papers and providing user warnings.
- **No duplicate live-model edges**: Enforces uniqueness for live model edges in the database and prevents silent duplication in the UI.
- **Generation rescue mode**: When zero generated models pass strict validation, soft-fail models (layer-jumps, chain-too-long, count-out-of-range) are salvaged with a `[质量警告:...]` rationale prefix + `partialPassMeta.qualityWarnings`, instead of returning a blank-screen error.
- **AI call abort timeouts**: `models/generate` aborts at 55s, `model-assistant` at 50s, both returning a 504 with a Chinese error before the Replit Autoscale 60s proxy timeout would otherwise kill the request as a generic 502. Reserved VM deployments have no such limit.
- **Per-session scoping**: `generation_feedback` and `learning-stats` queries are scoped by `sessionId` to prevent cross-session leakage. `evidenceHypothesisId` is strong-bound to `paper_hypotheses` belonging to the cited `paperId`.
- **Variable rename/delete**: PATCH/DELETE `/sessions/:id/variables/:variableId` allow per-paper extraction edits without re-running the whole paper. `canonicalize()` is Unicode-safe (preserves CJK).
- **Image blocklist**: GET/POST/DELETE `/sessions/:id/image-blocklist` with URL normalization (lowercased host, stripped tracking params). Unverified backfill images get `verified: false` and a `未验证` UI badge.
- **Manual edge evidence**: model-detail.tsx addEdge UI lets the user explicitly pick the evidence paper from any node's paper, instead of always defaulting to the source-side paper.
- **Auth (OIDC)**: Replit-hosted OpenID Connect via `openid-client`. `auth_sessions` table stores OIDC session state (renamed from template `sessions` to avoid collision with research `sessions`). `sessionsTable.userId` is nullable; legacy NULL-owner rows are visible to any logged-in user, and the first user to sign in claims them via `upsertUser` backfill. All session routes use `requireAuth` + `visibilityFilter(userId)`. Frontend `App.tsx` mounts a `LoginGate` that calls `/api/login` / `/api/logout`.
- **AI usage logging**: `ai_usage_log` (cost in micro-USD integer, `gpt-5.4` priced at $2.5/$10 per 1M tokens). `logAiUsageFromOpenAI()` is fire-and-forget; instrumented at all 11 OpenAI call sites across models/papers/variables/model-assistant. `GET /sessions/:id/ai-usage` returns per-route + total summary, gated by ownership.
- **Full-text paper search**: `POST /sessions/:id/papers/full-text-search` does ILIKE-based AND across title/abstract/fullText with snippet+rank — bridges the gap until proper `tsvector` is added.
- **Layer-1 personalization (per-user)**: `user_personalization` (JSONB profile + counters, lazily refreshed >1h) drives a soft prompt block injected into both `models/generate` and `model-assistant` prompts. Profile is suppressed for users with `<2 sessions AND <1 accepted model` to avoid cold-start bias. `lib/personalization.ts` has `tokenize` (English words + CJK bigrams), `parseRationaleTags` (reads `[OPERATOR:..][BACKBONE:..]` from rationale), `buildUserPersonalizationContext`, `scheduleProfileRefresh` (fire-and-forget after generation/chat). Routes: `GET/POST/DELETE /api/me/personalization` (the DELETE is the "forget me" hook). UI: `personalization-card.tsx` on home with refresh + forget buttons.
- **Layer-2 prep (deferred)**: `session_signals` table stores per-session topic/variable tokens + accepted backbones/operators as a JSONB fingerprint. Populated opportunistically by `refreshUserPersonalization` so when admin cross-user clustering is built later, the data is already accumulated.
- **Auto initial recommendation**: First time a user lands on `/models` with ≥3 papers extracted, a topic, and zero prior generation attempts (`learningStats.totalFeedback === 0`), the page auto-fires one `numModels:3` generation in the background and shows a banner. Guarded by `sessionStorage["autoGenTried:<sessionId>"]` so transient failures don't loop and refreshes mid-flight don't double-fire. Never re-triggers after the user has manually generated/cleared models.
- **Unified user-intent preamble (models/generate)**: Replaced the three scattered prompt blocks (topicBlock + userBlock + focusBlock) with ONE coherent "UNIFIED USER INTENT" preamble at the top of the prompt. Includes explicit DOMAIN LOCK (no chatbot↔streamer/metaverse swaps) and OUTCOME LOCK (no impulse↔intention, loyalty↔satisfaction swaps), plus an ALIGNMENT CONTRACT that forces every model's `rationale` to begin with `[OPERATOR:..][BASE:..][BACKBONE:..]` followed by three labeled lines `[TOPIC FIT]` / `[FOCUS FIT]` / `[USER PROMPT FIT]`. Focus picks are now listed as `id|TYPE|"name"|paperId` instead of bare ID lists. AI is told to return FEWER topically-tight models rather than emit drifted ones. Fixes the previously observed double-drift (e.g. session topic "AI chatbot + impulse purchase" yielding "AI-streamer → purchase intention").
- **Topic-aware prompts (chat assistant)**: `model-assistant` prompt loads `sessions.topic` + `sessions.name` and injects a top-of-prompt "RESEARCH TOPIC / USER'S STATED DIRECTION" block. Paper references include truncated abstracts (480 chars in models, 360 chars in chat) so the AI can judge topical fit rather than blindly recombining whatever variables exist. Hard Rule #14 in models/generate requires every model's `description` + `rationale` to explicitly name the topic and explain how the model advances it; topically-tight 2-paper combos are allowed to override the ≥3-paper rule when the topic is narrow. Without this fix, generated models drifted toward whatever papers had the most variables, producing outputs that felt disconnected from the user's stated research direction.
- **User focus-variable selection**: Optional UX on `/variables` — each cluster card has a `⭐ 重点选用` pin button. Pinned cluster keys (`type|normalizedName`, stable across re-extraction) are persisted in `localStorage` (`focusVarSelection:v1:<sessionId>`) via `lib/focus-selection.ts`. On `/models` the picks are hydrated once per (sessionId,variables-ready) pair, expanded back to current variable IDs, and pre-filled into `focusVariableIds` (also passed to the auto initial recommendation). Backend `focusBlock` in `models/generate` is now a "spine" rule, not just an "include" hint: every model must structurally use ≥2 of the picks, ≥half the models must use ≥3, description/rationale must name the picks, and the AI is told to omit a model rather than silently swap a pick. Banner on `/models` ("已根据你在变量页选择的 N 个重点变量预设") + clear button keeps the carry-over discoverable and reversible.

## Product
- **Session Management**: Users can create sessions, defining a name and research topic.
- **Paper Discovery & Management**: Search academic papers via OpenAlex, add them to sessions, and manage them.
- **AI Variable Extraction**: AI extracts research variables (independent, mediator, moderator, dependent) with definitions and citations from paper abstracts.
- **Variable Visualization**: View extracted variables and their relationships in an SVG graph.
- **AI Model Generation**: AI proposes novel theoretical research models by combining variables from multiple papers, complete with relationships and citation evidence.
- **Model Selection**: Users can select their preferred research model.
- **Live Model Building**: Users can curate a research model per session with provenance-tracked edges.
- **Model Quality & Review**: Provides a quality report for generated models and can assemble a literature review paragraph with APA-7 citations.
- **Model Figure Search**: Searches for model figures from published papers to provide visual context.
- **Model Comparison**: Allows A/B comparison of candidate models with a diff grid.
- **Model Export**: Supports exporting live models to Markdown and DOCX formats.
- **Persistent AI Chat History**: Stores and retrieves AI assistant messages for ongoing session context.

## User preferences
_Populate as you build_

## Gotchas
- **OpenAlex search resilience**: Implements a 15s timeout with one retry for OpenAlex API calls, providing specific error messages to the user.
- **AI extraction concurrency**: Variable extraction is parallelized with a concurrency limit of 4 to balance speed and avoid OpenAI rate limits.
- **Search result caching**: Search results are cached in-memory for 15 minutes.
- **Codegen script behavior**: The codegen script for `lib/api-zod` overwrites `index.ts` to fix an `export *` issue.

## Pointers
- **OpenAlex API**: [https://docs.openalex.org/](https://docs.openalex.org/)
- **Drizzle ORM**: [https://orm.drizzle.team/](https://orm.drizzle.team/)
- **TanStack Query**: [https://tanstack.com/query/latest](https://tanstack.com/query/latest)
- **Wouter**: [https://www.npmjs.com/package/wouter](https://www.npmjs.com/package/wouter)
- **SerpAPI**: [https://serpapi.com/](https://serpapi.com/)
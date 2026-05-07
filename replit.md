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
- **AI Model**: Uses `gpt-5.4` via Replit's AI Integrations proxy for core AI functions.
- **Paper Search**: Leverages OpenAlex API for its open access, lack of API keys, and rate limit resilience.
- **Client Code Generation**: OpenAPI spec generates Zod validators and React Query hooks for type safety.
- **Monorepo Structure**: pnpm workspaces manage packages for shared code and streamlined development.
- **Image Search Pipeline**: Multi-stage pipeline with AI query expansion, parallel search, and relevance filtering.
- **Generation Guardrails**: Implements checks and UI blocking to prevent model generation on incomplete variable sets.
- **Unified User Intent Preamble**: Consolidated prompt block for `models/generate` to ensure topic and outcome alignment.
- **Chat ↔ Live Model Bridge**: Enables direct modification of live models from chat suggestions, enhancing interactivity.
- **Variable Extraction (System-Characteristic IV Emphasis)**: Rewritten prompt for `routes/variables.ts` to focus on system characteristics as independent variables for specific paper types.
- **Global 401 Interceptor**: Provides a throttled `window` event for 401 errors, triggering a re-login overlay for improved user recovery.
- **JSON-mode model generation (P1 reliability)**: `/sessions/:id/models/generate` uses `response_format: { type: "json_object" }` to force valid JSON at the token-generation layer (eliminates prose wrappers, markdown fences, and brace-mismatch failures from gpt-5.4 reasoning). Output schema is `{"models": [...]}` envelope (json_object spec requires object root). Per-call budget is 12000 tokens (gpt-5.4 reasoning eats 3-4k before visible output starts). Parse loop tolerates three shapes for compatibility: envelope, bare array, bare object with shape check. A defensive `extractAndRepairJson()` (handles prose wrappers, markdown fences, AND truncated `{`/`[` roots via bracket-balancing) is kept as a fallback in case the proxy ever degrades json_object support.
- **Parallel per-model generation**: `/sessions/:id/models/generate` fans out N parallel single-model OpenAI calls (each with ~5k output tokens, 50s abort) instead of one big call producing N models. Stays under the 60s autoscale budget on large sessions, returns partial successes (≥1 fulfilled), and seeds each call with a different operator-pair "VARIANT HINT" for diversity (post-hoc dedup still rejects collisions). When the user types a custom prompt, it is mirrored at the TOP of the prompt as "PRIMARY USER DIRECTIVE" and re-stated at the END as a closing reminder, so it isn't lost in the 30k-token middle.
- **PRIOR-WORK PATTERN SUMMARY block (`routes/models.ts`)**: server aggregates `perPaperModels` (the typed graphs already cached on `papersTable.researchModel`) into a statistical fingerprint — backbone tally (already had this), recurring construct names by role (mediator / moderator / IV / DV with paper count, min 2 papers; moderators allow min 1), IV→DV chain length distribution via DFS, and moderator landing position (onto mediator / DV / IV). Injected into the prompt right after the BACKBONES catalog. When `userPrompt` is empty the block header is upgraded to "LEAN INTO THESE PATTERNS — the user did NOT supply a custom prompt, so default to what the literature here demonstrates" so the AI biases toward source-paper conventions instead of pre-training defaults (always-SOR, moderator-on-DV).
- **RECENT CHAT INTENT block (`routes/models.ts`)**: at the start of `/sessions/:id/models/generate` the server pulls the last 6 user-role chat turns from `modelAssistantMessagesTable` for THIS session, sanitizes them via `safeForPromptText()` (drops prompt-injection attempts, strips brackets/quotes/control chars, 240-char cap per turn, replaces `"` with `'`), and injects them as a dedicated block placed right after `directiveBlock` at the very top of the prompt (before UNIFIED USER INTENT). This bridges the gap between the personalization profile (refreshes only every hour and is cross-session) and the live chat — a turn typed 30s ago in the assistant chat now influences the very next generation. Existing `scheduleProfileRefresh()` call later in the route still pushes the same content into the global profile.
- **Three-Dimension Intent Enforcement (topic + papers + focus picks)**: Server-side `validate()` rejects any generated model that doesn't include ≥ min(focusPicks, 2) of the user's hand-picked focus variables as STRUCTURAL nodes (matched by variableId, canonicalConstructId, or exact lower-cased name); soft-fail so rescue mode can salvage. Frontend re-hydrates `/models` focus state from localStorage on every variables change (not once-per-mount), preserves chat-suggestion overrides via `focusFromVariablesPage`, and surfaces a rose-colored "orphan picks" banner when saved cluster keys can't be expanded to current variable ids (typically after a re-extraction rename).
- **Moderator-targets-a-PATH (Hard Rule #12, `routes/models.ts`)**: every generated edge with `relationship: "moderates"` MUST include both `moderatorJustification` AND a new `moderatedEdge: { fromVariableId, toVariableId }` field that names a real non-moderator edge already present in the same model. Pre-fix the AI would emit `from=moderator, to=DV` and the canvas rendered "moderator → moderates → DV", which is semantically wrong (moderators condition the strength of an A→B relationship, they don't act on the DV directly). Auto-repair drops moderator edges whose `moderatedEdge` is missing or doesn't match an existing path; validate() hard-rejects them otherwise. Self-referential paths (moderator appears in its own moderatedEdge) are also rejected.
- **Live-model UX shipped (P0/P1/P3 + AI value panel)**: (P0) `routes/live-model.ts` import-from-model now does a TWO-PASS edge insert — pass 1 inserts every non-moderator edge, pass 2 re-queries the live edges, builds a `(fromVarId→toVarId) → liveEdgeId` map, and inserts each moderator edge with `moderatesEdgeId` set from the source `moderatedEdge` pointer (resolved via remap). Without this the canvas rendered "moderator → DV" because the FK was lost on import. (P1) Edge list in `pages/sessions/live-model.tsx` renders moderator rows as "X moderates [A → B]" via a violet pill resolving `e.moderatesEdgeId` against the current edge set; falls back to `from → to` when target id is missing. (P3) `hoveredEdgeId` state in live-model.tsx is shared both ways with `EditableModelGraph` via new `highlightEdgeId`/`onEdgeHover` props — RelEdge bumps strokeWidth 1.8→3.2 and opacity to 1, list row gets `bg-primary/5`. (AI value panel) `AiUsagePanel` now defaults to a "what AI built for you" dashboard (papers / variables / models from `useGetSessionSummary` + conservative labor-hour estimate: 0.5h/paper + 0.2h/variable + 1.5h/model). The original cost-audit table is preserved behind a `localStorage["ai-usage-dev-mode"]` toggle so the project owner who actually pays the AI bill can still inspect token/route spend. Numbers are real, never inflated.
- **Cost tier per route (`lib/ai-usage.ts` + 5 routes)**: pricing is now a per-model lookup table (`gpt-5.4` $2.5/$10, `gpt-5-mini` $0.25/$2 per 1M, etc.) with a date-suffix-stripping resolver and a fall-back to the gpt-5.4 tier so unknown models never under-bill. Five low-stakes routes were downgraded from `gpt-5.4` → `gpt-5-mini`: `model-assistant/expand-image-queries`, `model-assistant/image-relevance`, `model-assistant/screen-papers`, `papers/upload-pdf-metadata`, `models/literature-review`. The flagship gpt-5.4 stays on `models/generate`, `models/generate-retry`, `models/extract-paper-research-model`, `variables/extract`, `model-assistant/chat` — all of which need the deeper reasoning. Cost reports now correctly attribute the discount because `computeCostMicroUsd` reads the model name from the OpenAI response.
- **AI usage in 积分 (`ai-usage-panel.tsx`)**: dev-mode display switched from raw USD to "积分", where 1 积分 = $0.01 (USD × 100, rounded). Header byline + per-route table cost column + total row all use `fmtCredits()`; sub-1-credit values render with one decimal (e.g. `0.4`) so cheap calls don't collapse to "0". A footnote under the table states "1 积分 ≈ $0.01（按 OpenAI 公开价折算，1 美元 = 100 积分）" so the conversion is transparent — DB still stores micro-USD, the rate is applied at display time only.
- **Savings visibility (`routes/ai-usage.ts` + `ai-usage-panel.tsx`)**: the per-route cost-tier downgrade was previously invisible unless the user opened dev-mode. Backend now `groupBy(route, model)` and recomputes each row at the flagship `gpt-5.4` rate via `computeCostMicroUsd()`, returning `flagshipCostUsd` and `savedCostUsd` (clamped at 0) per route AND at the top level. Default value-mode grid widened from 2×2 to 3×2 with two new tiles — "已花积分" (actual spend) and "已省积分" (`+N` in emerald, "0" muted when nothing saved). Header byline ALWAYS appends ` · N 积分 (−M)` when cost has loaded, so the project owner sees what the AI cost without toggling anything. Dev-mode per-route table is unchanged; it remains the place to inspect token-level detail.
- **Edge recycle bin (`pages/sessions/live-model.tsx`)**: deleting a live edge pushes a `TrashedEdge` record (cap 20, FIFO) into `localStorage["liveModelTrash:${sessionId}"]` so accidental deletes can be restored. Survives refresh; hidden when empty.
- **PNG export of live model (`lib/export-live-model-image.ts`)**: rewritten to bypass html-to-image entirely after recurring failures on Replit (the library walks `document.styleSheets.cssRules` and SecurityError-throws on cross-origin sheets; it also fetches @font-face URLs and external background-images that the Replit dev proxy occasionally returns 520 for, blanking the PNG). New approach renders an SVG string directly from `detail.nodes` / `detail.edges` (rounded rects coloured by variableType, bezier paths with arrow markers per relationship colour, dashed moderator lines that land on the midpoint of the edge they moderate via `moderatesEdgeId`, H-tags as label bubbles), then rasterizes via `data:image/svg+xml,<encoded>` → `<img>` → `canvas.drawImage` → `toDataURL("image/png")` at 2x. SVG embeds NO external resources so the canvas is never tainted and `toDataURL` always succeeds. Layout reuses persisted positionX/Y when present, falls back to a deterministic columnar layout by type (avoids dragging dagre into the export bundle).
- **Variable pool keyword search (`pages/sessions/live-model.tsx`)**: `poolQuery` state filters the variable pool sidebar by case-insensitive match against name + type + definition (4 i18n keys, zh+en). Helps when a multi-paper extraction balloons the pool past ~100 entries.
- **No-floating-node guarantee (Hard Rule #17 + auto-repair, `routes/models.ts`)**: pre-fix the AI would emit 5–6 nodes but only 2 edges, leaving orphan boxes on the canvas (the user's "片段化" complaint, e.g. perceived responsiveness/anthropomorphism floating in the AI-broadcaster screenshot). Two-layer fix: (1) auto-repair pass, after edge cleanup, prunes any node with zero incident edges — focus picks are PROTECTED from pruning so the existing focus-pick orphan check still fires with a meaningful message; (2) `validate()` adds a hard check (NOT in soft-fail list) for any remaining floating node, ordered BEFORE node-count / edge-count so users see the true reason. Hard Rule #17 in the prompt also forbids title-vs-graph mismatches (constructs named in `name` / `description` must appear as wired nodes). Hard Rule #18 adds a tangential-paper exclusion (override Rule #4's ≥3-paper minimum rather than pull a metaverse-tourism paper into an AI-broadcaster project).
- **Evidence Grounding + Focus Connectivity + Enrichment + Backbone Alignment** (`routes/models.ts`): Four additional server-side gates run after generation: (1) per-paper evidence corpus (full text + abstract + variable citations + hypothesis statements + per-paper graph evidence) verifies each edge's `evidenceCitationText` via verbatim or 6-word-window match; ungrounded edges are dropped in repair (counted as `droppedUngroundedEdges`), so a model with one fabricated edge survives but a model with too many fails the ≥4-edges floor. (2) Focus-pick CONNECTIVITY: every focus-pick node must have ≥1 incident edge AND ≥ min(picks, 2) edges must touch a focus node; orphan-focus is hard-rejected (soft-fail pattern). (3) ENRICHMENT (Hard Rule #15): when focus picks exist, model must include ≥1 non-pick structural node drawn from the literature pool — prevents "just the picks" output. (4) BACKBONE ALIGNMENT (Hard Rule #16, soft-fail): per-paper `backboneGuess` is normalized against `THEORY_BACKBONES` and tallied into an "evidenced backbones" prompt block; when non-empty, the AI's chosen `backbone` must be in that set so the model uses a framework the source papers actually demonstrate (SOR, TAM, etc.) rather than defaulting to whatever pre-training favored.

## Product
- **Session Management**: Create and manage research sessions with defined topics.
- **Paper Discovery & Management**: Search and add academic papers via OpenAlex.
- **AI Variable Extraction**: AI extracts variables with definitions and citations from papers.
- **Variable Visualization**: View extracted variables and their relationships graphically.
- **AI Model Generation**: AI proposes novel theoretical models with relationships and citation evidence.
- **Live Model Building**: Users can curate research models with provenance-tracked edges.
- **Model Quality & Review**: Provides quality reports and can assemble literature review paragraphs.
- **Model Figure Search**: Searches for model figures from published papers.
- **Model Comparison**: Allows A/B comparison of candidate models.
- **Model Export**: Supports exporting live models to Markdown and DOCX.
- **Persistent AI Chat History**: Stores and retrieves AI assistant messages for ongoing context.

## User preferences
_Populate as you build_

## Gotchas
- **OpenAlex search resilience**: 15s timeout with one retry for OpenAlex API calls.
- **AI extraction concurrency**: Parallelized with a concurrency limit of 4 to manage rate limits.
- **Search result caching**: In-memory cache for search results (15 minutes).
- **Codegen script behavior**: The codegen script for `lib/api-zod` overwrites `index.ts`.

## Pointers
- **OpenAlex API**: [https://docs.openalex.org/](https://docs.openalex.org/)
- **Drizzle ORM**: [https://orm.drizzle.team/](https://orm.drizzle.team/)
- **TanStack Query**: [https://tanstack.com/query/latest](https://tanstack.com/query/latest)
- **Wouter**: [https://www.npmjs.com/package/wouter](https://www.npmjs.com/package/wouter)
- **SerpAPI**: [https://serpapi.com/](https://serpapi.com/)
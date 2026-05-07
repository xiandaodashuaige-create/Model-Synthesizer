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
- **JSON-mode + parallel per-model**: `response_format: { type: "json_object" }` with `{"models":[...]}` envelope (12k token budget). Defensive `extractAndRepairJson()` (prose wrapper / markdown fence / bracket-balance) kept as fallback. Generation fans out N parallel single-model calls (~5k tokens each) instead of one N-model call — stays under 60s autoscale, returns partial successes, seeds each call with a different operator-pair "VARIANT HINT".
- **Route-deadline race (the 502 killer)**: `tRouteStart` is anchored at the TOP of the route (not at the fanout, which used to miss 5-10s of pre-call DB+prompt work). `ROUTE_DEADLINE_MS = 52_000` reserves ~8s for post-call validate + N-row DB inserts + serialize before the 60s autoscale wall. Per-call timeout is sized DYNAMICALLY: `callTimeoutMs = max(18_000, min(42_000_parallel|48_000_serial, ROUTE_DEADLINE - elapsedBeforeFanout - 8_000))`. Each call gets its own `AbortController`; the call's signal is `AbortSignal.any([AbortSignal.timeout(callTimeoutMs), ctrl.signal])`. A 500ms `setInterval` poll fires (a) HARD-aborts all pending at exact route deadline, and (b) EARLY-aborts pending once `fulfilledCount ≥ 1 && now ≥ tRouteStart + 0.8 * ROUTE_DEADLINE` (~41.6s) — so the slowest of N calls can no longer monopolise the budget when N-1 already succeeded. Replaces the prior `Promise.allSettled(50s)` which waited for the slowest call deterministically and routinely blew the autoscale wall on 19-paper sessions. The `haveTimeForRetry` check at the permissive-prompt fallback now keys off the same top-of-route anchor, so it correctly self-skips when pre-fanout work was slow.
- **Prompt structure**: PRIMARY USER DIRECTIVE mirrored at TOP and END of prompt so it survives the 30k-token middle. RECENT CHAT INTENT block (last 6 sanitized user turns from `modelAssistantMessagesTable`) injected after directiveBlock — bridges the hourly personalization profile and live chat. PRIOR-WORK PATTERN SUMMARY aggregates `perPaperModels` into a fingerprint (backbone tally, recurring constructs by role, IV→DV chain length, moderator landing position); when `userPrompt` is empty, header switches to "LEAN INTO THESE PATTERNS" so AI biases toward source papers instead of pre-training defaults (always-SOR, moderator-on-DV).
- **Focus-pick orphan rescue + parallel-stimulus prompt (auto-repair extension)**: when the user pins ≥2 stimulus-layer IV focus picks (e.g. "AI broadcast" + "AI-chatbot service quality"), the AI routinely included both as nodes (satisfying the count check) but only wired one into the edge structure — the other became orphan and the focus-connectivity validator hard-rejected the entire model. Two-pronged fix: (a) `parallelStimulusRule` is appended to `focusRules` whenever `stimulusIvFocusPicks.length >= 2`, explicitly telling the AI to build a parallel-path structure where each pinned stimulus IV originates ≥1 outgoing edge that reaches the DV (or omit + disclose); (b) inside the existing auto-repair pass (right after the orphan-node prune), a focus-pick orphan rescue scans for unconnected focus-pick stimulus IVs and clones the strongest non-moderator outgoing edge from another connected stimulus IV in the model, swapping the source to the orphan. The cloned edge inherits the donor's verbatim `evidenceCitationText` (still passes `isEvidenceGrounded()` because grounding checks text vs paper corpus, NOT vs variable names) and clears `evidenceHypothesisId` (since the cited hypothesis named the donor IV, not the orphan). Limited to stimulus-IV orphans because mediator/moderator/DV orphans need bidirectional fixes that are riskier without a strong donor signal — those still hard-reject. Tracked via `repairStats.rescuedFocusOrphans`.
- **TOPIC-DERIVED ROLE BINDINGS + UMBRELLA-ENTITY DETECTION (`detectUmbrellaVariableIds()` + `extractTopicRoleBindings()`)**: pre-fix `extractRequiredRoleBindings()` only parsed the regenerate-form `userPrompt`, so sessions where the user just set a topic ("AI 主播对消费者冲动购买的影响") and clicked generate had ZERO server-side IV/DV enforcement — the AI would routinely pick `perceived anthropomorphism` (a dimension) as IV instead of the bare-entity `AI broadcast`. Fix is two-pronged. (a) `detectUmbrellaVariableIds(variables)` flags stimulus-IV rows whose lower-cased name is contained inside another row's name (e.g. "AI broadcast" appears in "perceived anthropomorphism of AI broadcast"), excluding rows that themselves start with `perceived/perception of/感知/感受`. The variable-pool listing prepends an explanatory header and tags each umbrella row with `[UMBRELLA-ENTITY]`, so the AI sees which rows are entity bodies vs perceived dimensions. (b) `extractTopicRoleBindings(topic, variables, umbrellaIds)` parses Chinese patterns ("X 对 Y 的影响|作用|效应|关系", "X 如何影响|作用于|促进|塑造|驱动 Y") + English patterns ("the effect/impact/influence of X on Y", "how X affects Y") and emits `{X→IV, Y→DV}` bindings. Matching uses the same exact-then-substring two-pass fuzzy match as the userPrompt parser, but with a **PREFER-UMBRELLA tiebreaker** — when both "AI broadcast" and "perceived anthropomorphism of AI broadcast" match the parsed term, the umbrella wins. Topic-derived bindings are merged into `requiredRoleBindings` with a conflict guard (userPrompt wins on the same variable+role; topic-binding skipped when userPrompt already assigned a different role to the same variable, otherwise validate() would reject every model). Both binding sources flow through the same prompt + server backstop machinery.
- **USER-NAMED ROLE BINDING (prompt + SERVER ENFORCEMENT)**: when user types "X 作为自变量", 4-step procedure: (A) bilingual-map; (B) scan EXTRACTED VARIABLES POOL for ≥70% match → USE LITERALLY; (C) only if no match, may operationalize via dimensions AND `[USER PROMPT FIT]` MUST disclose with exact pattern "用户指定『<名>』作为<角色>；变量库中无统一的『<名>』构念，故以其感知维度...作为<角色>的操作化"; (D) literal match wins. **Server backstop (`extractRequiredRoleBindings()`)**: regex-parses the directive for "X 作为中介/调节/自变量/因变量" + "X 的中介作用" + English "mediating/moderating role of X" + "X as (a/the) mediator/moderator", maps Chinese→English via a small seed dictionary (consumer engagement / social overload / trust / impulse buying / etc.), normalized fuzzy-matches each name against the variable pool (exact > 4-char substring), and emits `RequiredRoleBinding[]`. The bindings are (a) injected into the prompt as a "SERVER-PARSED ROLE BINDINGS" block telling the AI "no rescue path for these violations" so the model knows the contract, and (b) HARD-checked inside `validate()` AFTER the floating-node check — model MUST contain the variable AS A NODE with `type === role`, with canonical-construct-id fallback so a sibling variable in the same construct family also satisfies the binding. Failure produces a Chinese rejection reason `用户明确指定的角色未兑现: 『X』(应作为mediator) 完全缺席；『Y』被错放为 independent(应为 moderator)` that is NOT in `SOFT_FAIL_PATTERNS` — rescue path cannot ship a model that drops user-named constructs.
- **Tightened SOFT_FAIL_PATTERNS**: removed `node count out of range`, `edge count out of range`, and `focus pick … not connected by any edge` from soft-fails. Pre-fix the rescue path would salvage thin 3-edge models AND models with floating focus picks (the user-reported "service agent type 孤立 + only 3 hypotheses" failure). Now these trigger regeneration via the "all calls failed" branch instead of being passed through with a quality-warning prefix. Trade-off: occasionally users get a hard regeneration error toast instead of a usable but flawed model — but the model UI is the source of truth for theoretical quality, so blank > misleading.
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

### Reference-figure UX (chat opening nudge + per-edge dialog)
- **Opening nudge in `model-assistant-chat.tsx`**: when session has a topic AND `paperCount ≥ 3` AND user hasn't dismissed AND image panel never opened, surface a sky-tinted card after the message list with 2-3 AI-distilled query buttons. Click runs `runImageSearch(q.query)` and dismisses. Dismissal persisted in `localStorage["model-assistant-image-nudge-dismissed-{sessionId}"]`; "ever opened" flag in `localStorage["model-assistant-image-panel-seen-{sessionId}"]`.
- **Distill endpoint (`POST /sessions/{id}/model-assistant/distill-nudge-queries`)**: AI-powered (`gpt-5-mini`) — takes the session's topic + top-12 variable names + 4 sample paper titles, returns `{queries: [{label, query}]}` (Chinese button label ≤14 chars + 4-8 word lowercase English search query). REPLACES the original client-side `${topic} conceptual model` template that produced 30+ word queries when users named their session with the full thesis title — those long queries matched too loosely on Google Images and returned irrelevant noise.
  - **Hard server contract enforcement**: `compactDistilledQuery()` lowercases, strips quotes/punctuation, drops banned padding (`research`/`figure`/`diagram`/`study`/`paper`), caps to first 8 words. Guarantees the long-query bug cannot reappear even if the model ignores the prompt.
  - **Anti-abuse**: in-process `Map` cache keyed by `(sessionId, topic, top-12 var names)`, 30 min TTL, 500-entry cap with FIFO eviction. Empty-result responses also cached to avoid re-hammering on a topic the model can't usefully distill.
  - **Client race guard**: per-request token (`nudgeReqIdRef`) + session snapshot in onSuccess/onError so a late-arriving response from a previous session can't overwrite the current session's queries when user switches sessions in-flight. One automatic retry on transient failure before suppressing the nudge (per-session retry budget reset on session change).
- **Per-edge "找参考图" button (`live-model.tsx` + new `reference-figure-dialog.tsx`)**: every unsupported edge (`!hasProvenance`) gets a sky-pill button next to the existing emerald "搜索出处". Opens `ReferenceFigureDialog` which auto-runs `useSearchModelImages` with query `{from} {REL_WORD[rel]} {to} conceptual model` (REL_WORD: positive/negative/moderating/mediating effect). Same AI query expansion + raw-mode toggle + category-labeled grid + lightbox as the chat panel, but as a focused modal — fast escape hatch when an edge has no quotable evidence but the user still wants visual proof that this construct relationship has been published. Hint copy explicitly notes these are visual references, NOT auto-cited evidence.

### Evidence search (`lib/evidence-matching.ts` + `evidence-match-dialog.tsx`)
- **Per-edge focus mode**: live-model relationship list "搜索出处" button passes `focusEdgeKey: ${fromVar}-${toVar}-${rel}` matching `makeEdgeKey()`. Backend filters edges array BEFORE OpenAlex/Scholar fetch + AI scoring, so focused mode = 1 fan-out instead of N. Auto-enables `wantImages`, forces per-edge granularity, suppresses overall. Per-edge pool is doubled (`max(WEB_PER_EDGE*2, 10)`) for richer single-edge results.
- **Google Scholar source**: `fetchGoogleScholar()` via SerpAPI `engine=google_scholar`. New scope checkbox "Google 学术". Hits use `source: "scholar"` + `S:<externalId>` ref, flow through same idempotent `importWebPaper` path as OpenAlex on apply (server upserts by `(sessionId, externalId)`).
- **Per-edge figures**: `fetchEdgeFigures()` via SerpAPI `engine=google_images` (3 hits, stock-domain filter). Returned as `imageHits` on each `EvidenceEdgeMatch`. Only fetched when `wantImages` AND ≤3 edges (avoids fanning out 10+ image calls). Rendered as 3-col thumbnail grid below per-edge hits, click opens source page.
- **Library proxy**: per-hit "学校代理" link wraps any URL through user's institutional EZproxy template (single text input persisted in `localStorage["evidence.libraryProxyTemplate"]`, `{URL}` placeholder; falls back to suffix concat). Lets users access purchased databases (Wiley, Springer, Elsevier) from any web/scholar hit.
- **Per-hit Google Scholar link**: every non-scholar hit gets a small graduation-cap icon that searches the title in scholar.google.com — one-click escape hatch to find the canonical paper.

### Paper card abstract clamp (`pages/sessions/papers.tsx`)
- Both abstract render sites (search-results card + saved-papers card) had `line-clamp-2` in className but rendered full-height (~25 lines per card) — Tailwind v4's `line-clamp` utility was being neutralized by the `@tailwindcss/typography` plugin's prose styles resetting `display`. Fix: enforce the clamp via INLINE STYLE (`display: -webkit-box`, `WebkitLineClamp: 2`, `WebkitBoxOrient: vertical`, `overflow: hidden`) — no parent CSS can override. Saved-papers card also gets a per-paper "展开/收起" toggle (`expandedAbstracts: Set<number>`) so users can read the full abstract on demand; search-results card stays clamp-only.

### Cross-cutting
- **Client codegen**: OpenAPI generates Zod validators + React Query hooks. Codegen overwrites `lib/api-zod/src/index.ts`.
- **Global 401 interceptor**: throttled `window` event triggers re-login overlay.
- **Image search pipeline**: AI query expansion → parallel search → relevance filter. Literal-fallback compaction: when `rawQuery` word count > 10 (typical when user pastes a full thesis title into the search box), the literal fallback is replaced by `compactDistilledQuery(rawQuery)` (or first 8 words if compaction returns null) instead of the original `"…"`-wrapped 25+ word phrase that matched nothing on Google Images. Same rules as the chat opening nudge — guarantees the long-query bug cannot resurface in EITHER entry point even if AI expansion returns empty.
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

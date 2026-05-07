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
- **Three-Dimension Intent Enforcement (topic + papers + focus picks)**: Server-side `validate()` rejects any generated model that doesn't include ≥ min(focusPicks, 2) of the user's hand-picked focus variables as STRUCTURAL nodes (matched by variableId, canonicalConstructId, or exact lower-cased name); soft-fail so rescue mode can salvage. Frontend re-hydrates `/models` focus state from localStorage on every variables change (not once-per-mount), preserves chat-suggestion overrides via `focusFromVariablesPage`, and surfaces a rose-colored "orphan picks" banner when saved cluster keys can't be expanded to current variable ids (typically after a re-extraction rename).
- **Moderator-targets-a-PATH (Hard Rule #12, `routes/models.ts`)**: every generated edge with `relationship: "moderates"` MUST include both `moderatorJustification` AND a new `moderatedEdge: { fromVariableId, toVariableId }` field that names a real non-moderator edge already present in the same model. Pre-fix the AI would emit `from=moderator, to=DV` and the canvas rendered "moderator → moderates → DV", which is semantically wrong (moderators condition the strength of an A→B relationship, they don't act on the DV directly). Auto-repair drops moderator edges whose `moderatedEdge` is missing or doesn't match an existing path; validate() hard-rejects them otherwise. Self-referential paths (moderator appears in its own moderatedEdge) are also rejected.
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
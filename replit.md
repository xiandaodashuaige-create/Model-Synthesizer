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
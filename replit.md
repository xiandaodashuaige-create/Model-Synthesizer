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
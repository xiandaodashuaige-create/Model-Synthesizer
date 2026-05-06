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
- **Image Search Pipeline**: Employs a multi-stage pipeline for finding research model figures, including AI-powered query expansion, parallel search lanes, and relevance filtering, to ensure high-quality, relevant results.
- **Editable Canvas**: Both the candidate model detail page (in editing mode) and the LiveModel "我的模型" page render the model graph via `components/editable-model-graph.tsx` (built on `@xyflow/react`). Supports node drag-to-reposition, drag-to-create edges, hover-delete on nodes/edges, and an "+ Add variable" pool. LiveModel persists positions via debounced (400ms) PATCH `/sessions/{id}/live-model/nodes/{nodeId}`. Candidate-model edits stay in-memory on draft state until "Save". Layout falls back to dagre when no positions are set.

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

## User preferences
_Populate as you build_

## Gotchas
- Variable extraction via AI can take ~10 seconds per paper.
- Model generation via AI can take ~20 seconds.
- Search results are cached in-memory for 15 minutes to reduce redundant API calls.
- The codegen script for `lib/api-zod` overwrites `index.ts` after Orval generation to fix an `export *` issue.
- `SERPAPI_API_KEY` is required for fetching paper model figures; if missing, the API returns a 503 error.

## Pointers
- **OpenAlex API**: [https://docs.openalex.org/](https://docs.openalex.org/)
- **Drizzle ORM**: [https://orm.drizzle.team/](https://orm.drizzle.team/)
- **TanStack Query**: [https://tanstack.com/query/latest](https://tanstack.com/query/latest)
- **Wouter**: [https://www.npmjs.com/package/wouter](https://www.npmjs.com/package/wouter)
- **SerpAPI**: [https://serpapi.com/](https://serpapi.com/)
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
- **Variable-relationship graph**: `GET /sessions/:id/variable-graph` emits edges only from rows in `paper_hypotheses` (no cartesian-product synthesis). Each edge carries `relationship` (positive/negative/moderates/mediates) and the verbatim `statement`. The frontend SVG (`pages/sessions/variables.tsx`) aggregates duplicate (source,target,relationship) edges across papers and color/style-codes them; mediation chains are expanded into two "mediates" edges. The extraction prompt in `routes/variables.ts` accepts ALL stated directional relationships (not only formally labeled hypotheses), so abstract-only papers also produce edges.
- **Editable Canvas**: Both the candidate model detail page (in editing mode) and the LiveModel "我的模型" page render the model graph via `components/editable-model-graph.tsx` (built on `@xyflow/react`). Supports node drag-to-reposition, drag-to-create edges, hover-delete on nodes/edges, and an "+ Add variable" pool. LiveModel persists positions via debounced (400ms) PATCH `/sessions/{id}/live-model/nodes/{nodeId}`. Candidate-model edits stay in-memory on draft state until "Save". Layout falls back to dagre when no positions are set.
- **Custom-prompt-aware generation validator**: `POST /sessions/:id/models/generate` enforces structural rules (`minDistinctPapers`, `minNodes`, etc.) post-generation. When `userPrompt` is non-empty, `minDistinctPapers` drops from `min(3, papers.length)` to **1** and `minNodes` drops from 5 to 4 — otherwise focused single-IV/S-O-R prompts (e.g. "rebuild paper P3's chain with one IV") get all candidates rejected and return a misleading "AI did not produce any structurally valid models" error. The prompt-side rule #4 is also softened conditionally so the AI doesn't over-promise multi-paper synthesis the user didn't ask for. Frontend `models.tsx` `onError` now extracts `err.data.error` + `err.data.rejected[]` from the response body and shows them in the toast (previous behavior: generic "请确认已经提取过变量" regardless of real cause).
- **Generation guardrails on `/sessions/:id/models`**: When the session has 0 extracted variables, the "生成模型" button is disabled and a `NextStepHint` directs the user back to `/papers`. When the user clicks "选用" on a candidate model and `liveModel.edges.some(e => e.userAdded)` is true, a themed `AlertDialog` (not `window.confirm`) warns that selecting will replace the manually added edges (the underlying `import-from-model` uses `replace:true`); confirmed action calls a separate `doSelect` to keep the cancel path side-effect-free.
- **Variable graph focus mode**: `pages/sessions/variables.tsx` `VariableGraph` supports click-to-focus on a node — non-incident edges/nodes dim to 0.08/0.25, focused node gets a thicker border, and a colored chip + clear-button shows in the card header. Clicking the same node again or the SVG background clears focus.
- **Onboarding stepper variables-step link** points to `/variables` when `varsDone`, otherwise `/papers` (so the step is meaningful both before and after extraction).
- **Per-paper extraction error visibility**: The "一键重新提取" loop in `variables.tsx` `ReExtractAllButton` catches each paper's failure and emits a destructive toast with the paper title + parsed reason, capped at 3 toasts to avoid flooding on outages; a summary toast at the end still reports the total ok/fail count.
- **No duplicate live-model edges**: `live_model_edges` has a unique index on `(live_model_id, from_variable_id, to_variable_id, relationship)`. All insert paths are idempotent: `import-from-model` dedups against ALL existing edges (regardless of `sourceModelId`) and uses `onConflictDoNothing`; manual `POST /sessions/:id/live-model/edges` pre-checks and returns **409** with `existingEdgeId` on duplicate (frontend `live-model.tsx` shows a friendly "已存在" toast). The previous dedup that filtered by `sourceModelId` allowed silent duplicate accumulation when "作为我的研究模型基础" (`replace:false`) was clicked repeatedly or mixed with manual edits.

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
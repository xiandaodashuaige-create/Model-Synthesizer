# Research Model Builder

A full-stack web application that helps academic researchers discover papers, extract research variables using AI, and generate novel theoretical research model combinations with full citation evidence.

## Architecture

- **Frontend**: React + Vite (TypeScript), TailwindCSS v4, Wouter routing, TanStack Query
- **Backend**: Express 5 (TypeScript), Pino logging, esbuild bundler
- **Database**: PostgreSQL via Drizzle ORM
- **AI**: OpenAI GPT-4o via Replit AI Integrations (`@workspace/integrations-openai-ai-server`)
- **Paper Search**: OpenAlex API (free, open, no API key required)
- **Monorepo**: pnpm workspaces

## Workspace Packages

| Package | Path | Purpose |
|---------|------|---------|
| `@workspace/api-server` | `artifacts/api-server` | Express REST API server |
| `@workspace/research-model` | `artifacts/research-model` | React+Vite frontend |
| `@workspace/api-spec` | `lib/api-spec` | OpenAPI 3.0 spec + Orval codegen config |
| `@workspace/api-zod` | `lib/api-zod` | Zod validators generated from OpenAPI spec |
| `@workspace/api-client-react` | `lib/api-client-react` | React Query hooks generated from OpenAPI spec |
| `@workspace/db` | `lib/db` | Drizzle ORM schema + DB client |
| `@workspace/integrations-openai-ai-server` | `lib/integrations-openai-ai-server` | OpenAI client via Replit AI Integrations |

## Application Workflow

1. **Create a session** — User enters a session name and research topic
2. **Search papers** — Uses OpenAlex API to search academic papers by topic
3. **Add papers** — Papers are saved to the session in the database
4. **Extract variables** — AI (GPT-4o) analyzes each paper's abstract and extracts research variables (independent, mediator, moderator, dependent) with definitions and citation text
5. **View variable graph** — SVG visualization showing relationships between variables across papers
6. **Generate models** — AI combines variables from multiple papers into 3 novel research model proposals with edge relationships and citation evidence per relationship
7. **Select model** — User marks their preferred model

## Key Routes

### Frontend (React, wouter)
- `/` — Session dashboard (list all sessions)
- `/sessions/new` — Create new session
- `/sessions/:id/papers` — Search & manage papers
- `/sessions/:id/variables` — View extracted variables + graph
- `/sessions/:id/models` — Generate & compare model proposals
- `/sessions/:id/models/:modelId` — Full model detail with citations

### API Endpoints
- `POST /api/sessions` — Create session
- `GET /api/sessions` — List sessions
- `GET /api/sessions/:id` — Get session with counts
- `GET /api/sessions/:id/summary` — Get detailed summary stats
- `POST /api/papers/search` — Search papers (OpenAlex, cached 15 min)
- `GET /api/sessions/:id/papers` — List session papers
- `POST /api/sessions/:id/papers` — Add paper to session
- `DELETE /api/sessions/:sessionId/papers/:paperId` — Remove paper
- `POST /api/sessions/:id/papers/:paperId/extract` — AI extract variables
- `GET /api/sessions/:id/variables` — List session variables
- `GET /api/sessions/:id/variable-graph` — Variable relationship graph data
- `POST /api/sessions/:id/models/generate` — AI generate model proposals
- `GET /api/sessions/:id/models` — List session models
- `GET /api/models/:id` — Get model detail
- `POST /api/models/:id/select` — Mark model as selected

## Database Schema

- `sessions` — Research sessions (name, topic, status)
- `papers` — Papers added to sessions (metadata + extracted flag)
- `research_variables` — Extracted variables (type, definition, citation text)
- `research_models` — Generated models (nodes + edges as JSONB, rationale)

## Codegen

After editing `lib/api-spec/openapi.yaml`, regenerate client code:
```bash
pnpm --filter @workspace/api-spec run codegen
```

After editing DB schema, push changes:
```bash
pnpm --filter @workspace/db run push
```

## Environment Variables

- `DATABASE_URL` — PostgreSQL connection string (auto-provided)
- `SESSION_SECRET` — Session secret
- `AI_INTEGRATIONS_OPENAI_BASE_URL` — OpenAI proxy base URL (Replit AI Integrations)
- `AI_INTEGRATIONS_OPENAI_API_KEY` — OpenAI proxy key (Replit AI Integrations)

## Notes

- Paper search uses **OpenAlex** (not Semantic Scholar) — no API key needed, no rate limiting issues
- AI extraction uses model `gpt-5.4` via Replit's AI Integrations proxy
- Variable extraction may take ~10 seconds per paper
- Model generation may take ~20 seconds
- Search results are cached in-memory for 15 minutes to avoid redundant API calls

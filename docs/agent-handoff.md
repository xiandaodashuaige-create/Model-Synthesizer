# Agent Handoff — Research Model Builder

> 每次接任务前先读本文件，不要全仓库探索。只读任务列出的具体文件。

## 当前阶段

**Phase 3 已完成**（贡献陈述生成 + 规则评审 + AI 深度评审）。
**成本闸门已完成**（AI 结果内存缓存 30 分钟 + 按钮积分预估标签）。

**下一步**：Phase 4（Gap 报告自动化 + context 创新类型 + gapFit 真实分数）。

---

## 已知旧错误（不要修）

| 错误 | 位置 | 状态 |
|------|------|------|
| TS6305 Output file not built | `lib/integrations-openai-ai-server` | 预存，跳过 |
| zhTW 语言类型 | `App.tsx:112` | 预存，跳过 |
| ExportEdge | `live-model.tsx:192` | 预存，跳过 |

---

## 关键文件速查

| 文件 | 用途 |
|------|------|
| `artifacts/api-server/src/routes/models.ts` | 所有模型相关路由（~3790行） |
| `artifacts/api-server/src/lib/innovation-scoring.ts` | 创新评分逻辑 + 类型定义 |
| `artifacts/api-server/src/lib/ai-usage.ts` | AI 成本计算 + 日志记录 |
| `artifacts/research-model/src/components/innovation-meta-panel.tsx` | Phase 3 创新面板 UI |
| `artifacts/research-model/src/pages/sessions/models.tsx` | 候选模型列表页 |
| `artifacts/research-model/src/pages/sessions/model-detail.tsx` | 模型详情页 |
| `artifacts/research-model/src/pages/sessions/landscape.tsx` | 文献全景页 |
| `artifacts/research-model/src/lib/i18n.tsx` | 所有 zh-CN 字符串 |
| `lib/api-spec/openapi.yaml` | OpenAPI 合约（source-of-truth） |
| `lib/api-client-react/src/generated/api.ts` | 生成的 React Query hooks |
| `lib/db/src/schema` | Drizzle ORM schema |
| `scripts/src/` | 自测脚本 |

---

## Codegen 规则

- 改 `openapi.yaml` 后必须运行：`pnpm --filter @workspace/api-spec run codegen`
- codegen 覆写 `lib/api-zod/src/index.ts` 和 `lib/api-client-react/src/generated/api.ts`
- codegen 后 `typecheck:libs` 可能报 TS6305（旧问题），不影响结果
- **每次任务只运行一次 codegen，不要重复**

---

## Typecheck 规则

- 只检查目标包：`pnpm --filter @workspace/api-server run typecheck 2>&1 | grep "error TS" | grep -v "integrations-openai"`
- 前端检查：`pnpm --filter @workspace/research-model run typecheck 2>&1 | grep "error TS" | grep -v "App.tsx\|live-model"`
- 不要运行全仓库 `pnpm run typecheck`（会撞旧错误）

---

## 路由约定

- 所有新模型路由前缀：`/sessions/:id/models/:modelId/`
- Auth：通过 `loadAuthorizedSession(sessionId, req)` 完成（已在 models.ts 顶部定义）
- 成本：必须调用 `logAiUsageFromOpenAI(completion, { route, sessionId, userId })`
- 返回模型时用 `formatModel(model, landscapeVersion)` 装饰

---

## AI 模型分级

| 等级 | 模型 | 适用场景 |
|------|------|---------|
| 旗舰 | `gpt-5.4` | 仅用户主动触发"高质量重写" |
| 默认 | `gpt-5-mini` | 初稿生成、AI 评审、低风险路由 |
| 免费 | 无 AI | 规则计算（review GET） |

**禁止**：页面加载时自动调用 AI 路由。

---

## 缓存约定（Phase 3 成本闸门已实现）

服务端用 `Map<string, {data, expiresAt}>` 内存缓存，TTL 30 分钟。
Cache key：`${modelId}:${landscapeVersion ?? 0}`

已缓存的路由（`models.ts` ~2873行附近）：
- `generate-contribution` → `contributionCache`
- `ai-review` → `aiReviewCache`

调用 `invalidateModelCaches(modelId)` 在 `recompute-innovation` 执行后清除两个 Map 中该模型的所有 key。

---

## 积分显示规则

`1 积分 = $0.01`。`fmtCredits(microUsd)` 在 `ai-usage-panel.tsx` 中已定义。
- gpt-5-mini 典型调用 ≈ 1 积分（按钮标签固定显示）
- gpt-5.4 典型调用 ≈ 2 积分（按钮标签固定显示）
- 按钮标签样式：`text-xs text-muted-foreground ml-1`

---

## Phase 状态

| Phase | 状态 | 关键产出 |
|-------|------|---------|
| Phase 1 (Landscape) | 已完成 | `GET /landscape`，`landscapeMeta` |
| Phase 2 (Slice 1+2) | 已完成 | `innovationMeta jsonb`，`recompute-innovation` |
| Phase 3 (Slice 3) | 已完成 | `InnovationMetaPanel`，`generate-contribution`，`review`，`ai-review` |
| 成本闸门 | 已完成 | 内存缓存 + 按钮积分预估 |
| Phase 4 (Gap 报告) | 待开始 | `gapReport`，context 类型，gapFit 真实分数 |

---

## 禁止事项

- 不要全仓库重构
- 不要改动 `auth` 中间件
- 不要默认使用 `gpt-5.4`
- 不要修改 `normalizeName()` / `canonicalize()` 的 6 步规则（需双端同步）
- 不要让 selftest 调用真实 OpenAI（用 mock 或跳过 AI 步骤）
- 不要重跑全量变量提取
- 不要修改 Sentinel paper 逻辑（`externalId='manual:${sessionId}'`）

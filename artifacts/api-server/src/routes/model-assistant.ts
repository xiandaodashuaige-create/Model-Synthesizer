import { Router, type IRouter } from "express";
import { eq, and, desc, or, inArray, sql } from "drizzle-orm";
import { db, papersTable, variablesTable, researchModelsTable, imageBlocklistTable, modelAssistantMessagesTable, sessionsTable, liveModelsTable, liveModelNodesTable, liveModelEdgesTable } from "@workspace/db";
import { asc } from "drizzle-orm";
import { ChatModelAssistantParams, ChatModelAssistantBody } from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logAiUsageFromOpenAI } from "../lib/ai-usage";
import { backbonesAsPromptBlock, operatorsAsPromptBlock } from "../lib/theoryTemplates.js";
import { buildUserPersonalizationContext, scheduleProfileRefresh } from "../lib/personalization";

// Allowed relationship values mirror live-model.ts. Kept inline here so this
// route doesn't need to import from another route module.
const ALLOWED_REL = new Set(["positive", "negative", "mediates", "moderates"]);

// Apply a batch of chat-driven liveModelOps to the session's live model.
// Returns per-op outcome so the chat UI can show "applied / rejected" pills.
// All ops are validated against session-scoped variables — the AI cannot
// invent ids that don't belong here. If any op references a variable from
// another session, it's rejected, never silently swapped.
type LiveOp =
  | { type: "addNode"; variableId: number }
  | { type: "removeNode"; variableId: number }
  | { type: "addEdge"; fromVariableId: number; toVariableId: number; relationship: string; provenancePaperId?: number | null; provenanceCitationText?: string | null }
  | { type: "removeEdge"; fromVariableId: number; toVariableId: number; relationship: string };

type AppliedOp = {
  type: LiveOp["type"];
  label: string;
  variableId?: number;
  fromVariableId?: number;
  toVariableId?: number;
  relationship?: string;
};
type RejectedOp = { type: LiveOp["type"]; label: string; reason: string };

async function applyLiveModelOps(
  sessionId: number,
  ops: LiveOp[],
  ctx: { sessionVarIds: Set<number>; varNameById: Map<number, string>; sessionPaperIds: Set<number> },
): Promise<{ applied: AppliedOp[]; rejected: RejectedOp[]; liveModelVersion: number }> {
  const applied: AppliedOp[] = [];
  const rejected: RejectedOp[] = [];

  const nameOf = (id: number) => ctx.varNameById.get(id) ?? `#${id}`;
  const labelEdge = (op: { fromVariableId: number; toVariableId: number; relationship: string }) =>
    `${nameOf(op.fromVariableId)} —[${op.relationship}]→ ${nameOf(op.toVariableId)}`;
  const labelNode = (vid: number) => nameOf(vid);

  await db.insert(liveModelsTable).values({ sessionId }).onConflictDoNothing({ target: liveModelsTable.sessionId });
  const [liveModel] = await db.select().from(liveModelsTable).where(eq(liveModelsTable.sessionId, sessionId)).limit(1);
  if (!liveModel) {
    return { applied, rejected: ops.map((o) => ({ type: o.type, label: "(live model)", reason: "无法创建活跃模型" })), liveModelVersion: 0 };
  }

  await db.transaction(async (tx) => {
    for (const op of ops) {
      try {
        if (op.type === "addNode") {
          if (!ctx.sessionVarIds.has(op.variableId)) {
            rejected.push({ type: op.type, label: labelNode(op.variableId), reason: "变量不属于当前项目" });
            continue;
          }
          await tx.insert(liveModelNodesTable).values({
            liveModelId: liveModel.id,
            variableId: op.variableId,
            userAdded: true,
          }).onConflictDoNothing();
          applied.push({ type: op.type, label: labelNode(op.variableId), variableId: op.variableId });
        } else if (op.type === "removeNode") {
          if (!ctx.sessionVarIds.has(op.variableId)) {
            rejected.push({ type: op.type, label: labelNode(op.variableId), reason: "变量不属于当前项目" });
            continue;
          }
          await tx.delete(liveModelEdgesTable).where(and(
            eq(liveModelEdgesTable.liveModelId, liveModel.id),
            or(
              eq(liveModelEdgesTable.fromVariableId, op.variableId),
              eq(liveModelEdgesTable.toVariableId, op.variableId),
            ),
          ));
          await tx.delete(liveModelNodesTable).where(and(
            eq(liveModelNodesTable.liveModelId, liveModel.id),
            eq(liveModelNodesTable.variableId, op.variableId),
          ));
          applied.push({ type: op.type, label: labelNode(op.variableId), variableId: op.variableId });
        } else if (op.type === "addEdge") {
          if (!ALLOWED_REL.has(op.relationship)) {
            rejected.push({ type: op.type, label: labelEdge(op), reason: "未知关系类型" });
            continue;
          }
          if (op.fromVariableId === op.toVariableId) {
            rejected.push({ type: op.type, label: labelEdge(op), reason: "不允许自环" });
            continue;
          }
          if (!ctx.sessionVarIds.has(op.fromVariableId) || !ctx.sessionVarIds.has(op.toVariableId)) {
            rejected.push({ type: op.type, label: labelEdge(op), reason: "变量不属于当前项目" });
            continue;
          }
          const provPaperId = op.provenancePaperId != null && ctx.sessionPaperIds.has(op.provenancePaperId)
            ? op.provenancePaperId : null;
          const provCit = provPaperId != null && typeof op.provenanceCitationText === "string"
            ? op.provenanceCitationText.slice(0, 600) : null;
          // Auto-add endpoint nodes
          for (const vid of [op.fromVariableId, op.toVariableId]) {
            await tx.insert(liveModelNodesTable).values({
              liveModelId: liveModel.id, variableId: vid, userAdded: true,
            }).onConflictDoNothing();
          }
          await tx.insert(liveModelEdgesTable).values({
            liveModelId: liveModel.id,
            fromVariableId: op.fromVariableId,
            toVariableId: op.toVariableId,
            relationship: op.relationship,
            provenancePaperId: provPaperId,
            provenanceCitationText: provCit,
            confidence: "medium",
            userAdded: true,
          }).onConflictDoNothing({
            target: [liveModelEdgesTable.liveModelId, liveModelEdgesTable.fromVariableId, liveModelEdgesTable.toVariableId, liveModelEdgesTable.relationship],
          });
          applied.push({ type: op.type, label: labelEdge(op), fromVariableId: op.fromVariableId, toVariableId: op.toVariableId, relationship: op.relationship });
        } else if (op.type === "removeEdge") {
          if (!ALLOWED_REL.has(op.relationship)) {
            rejected.push({ type: op.type, label: labelEdge(op), reason: "未知关系类型" });
            continue;
          }
          await tx.delete(liveModelEdgesTable).where(and(
            eq(liveModelEdgesTable.liveModelId, liveModel.id),
            eq(liveModelEdgesTable.fromVariableId, op.fromVariableId),
            eq(liveModelEdgesTable.toVariableId, op.toVariableId),
            eq(liveModelEdgesTable.relationship, op.relationship),
          ));
          applied.push({ type: op.type, label: labelEdge(op), fromVariableId: op.fromVariableId, toVariableId: op.toVariableId, relationship: op.relationship });
        }
      } catch (err) {
        rejected.push({ type: op.type, label: "(op)", reason: (err as Error).message?.slice(0, 200) ?? "未知错误" });
      }
    }
    if (applied.length > 0) {
      await tx.update(liveModelsTable)
        .set({ version: sql`${liveModelsTable.version} + 1`, updatedAt: new Date() })
        .where(eq(liveModelsTable.id, liveModel.id));
    }
  });

  const [refreshed] = await db.select({ version: liveModelsTable.version }).from(liveModelsTable).where(eq(liveModelsTable.id, liveModel.id)).limit(1);
  return { applied, rejected, liveModelVersion: refreshed?.version ?? liveModel.version };
}

const router: IRouter = Router();

type ChatMsg = {
  role: "user" | "assistant";
  content: string;
  attachments?: Array<{ name: string; kind: "image" | "text"; data: string }>;
};

router.post("/sessions/:id/model-assistant", async (req, res) => {
  const params = ChatModelAssistantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const body = ChatModelAssistantBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid body", details: body.error.issues });
    return;
  }
  const sessionId = params.data.id;
  const messages = body.data.messages as ChatMsg[];

  // Build session context: papers, variables, existing models, and the
  // user's stated research topic from session creation. The topic block is
  // the single most important alignment signal for the assistant — without
  // it the chat would suggest variable combinations that ignore what the
  // user actually wants to study.
  const [papers, variables, models, sessionRows, liveModelRows] = await Promise.all([
    // Skip the per-session "manual:" sentinel paper (see routes/variables.ts) —
    // it carries no abstract / fullText and would only inflate paper counts and
    // assistant prompt context with placeholder rows.
    db.select().from(papersTable).where(and(eq(papersTable.sessionId, sessionId), sql`${papersTable.externalId} NOT LIKE 'manual:%'`)),
    db.select().from(variablesTable).where(eq(variablesTable.sessionId, sessionId)),
    db.select().from(researchModelsTable).where(eq(researchModelsTable.sessionId, sessionId)),
    db.select({ topic: sessionsTable.topic, name: sessionsTable.name }).from(sessionsTable).where(eq(sessionsTable.id, sessionId)).limit(1),
    db.select().from(liveModelsTable).where(eq(liveModelsTable.sessionId, sessionId)).limit(1),
  ]);
  // Load CURRENT live-model content (nodes + edges) so the assistant can
  // suggest precise add/remove ops referencing existing variables, instead
  // of guessing what's already on the canvas.
  let liveNodes: Array<{ variableId: number; userAdded: boolean }> = [];
  let liveEdges: Array<{ fromVariableId: number; toVariableId: number; relationship: string; userAdded: boolean }> = [];
  if (liveModelRows[0]) {
    const lmId = liveModelRows[0].id;
    const [nRows, eRows] = await Promise.all([
      db.select({ variableId: liveModelNodesTable.variableId, userAdded: liveModelNodesTable.userAdded })
        .from(liveModelNodesTable).where(eq(liveModelNodesTable.liveModelId, lmId)),
      db.select({
        fromVariableId: liveModelEdgesTable.fromVariableId,
        toVariableId: liveModelEdgesTable.toVariableId,
        relationship: liveModelEdgesTable.relationship,
        userAdded: liveModelEdgesTable.userAdded,
      }).from(liveModelEdgesTable).where(eq(liveModelEdgesTable.liveModelId, lmId)),
    ]);
    liveNodes = nRows;
    liveEdges = eRows;
  }
  const sessionTopic = (sessionRows[0]?.topic ?? "").trim();
  const sessionName = (sessionRows[0]?.name ?? "").trim();

  if (variables.length === 0) {
    res.json({
      reply: "目前这个项目里还没有提取出任何变量。请先回到『提取变量』那一步，让 AI 把论文里的研究变量识别出来，我才能帮你设计模型组合方案。",
    });
    return;
  }

  // Same token-budget guard as models/generate: cap total abstract bytes so
  // a 40-paper session doesn't blow up the chat context. Small sessions
  // still get the full 360 chars per paper.
  const chatAbstractCap = papers.length <= 12
    ? 360
    : Math.max(140, Math.floor(4500 / papers.length));
  const paperLines = papers.map((p, i) => {
    const tag = `P${i + 1}`;
    const authors = (p.authors ?? []).slice(0, 2).join(", ");
    // Include a truncated abstract so the assistant can judge each paper's
    // topical fit to the user's stated research direction, instead of
    // treating every paper as equally relevant just because it's been added.
    const absSnippet = (p.abstract ?? "").trim().replace(/\s+/g, " ").slice(0, chatAbstractCap);
    const absLine = absSnippet ? `\n      Abstract: ${absSnippet}${(p.abstract ?? "").length > chatAbstractCap ? "…" : ""}` : "";
    return `  - id=${p.id} ${tag}: ${p.title} (${authors}${p.year ? `, ${p.year}` : ""})${absLine}`;
  }).join("\n");

  const varLines = variables.map((v) => {
    const paperIdx = papers.findIndex((p) => p.id === v.paperId);
    const paperTag = paperIdx >= 0 ? `P${paperIdx + 1}` : "?";
    return `  - id=${v.id} [${v.type}] "${v.name}" (from ${paperTag})`;
  }).join("\n");

  const existingModelLines = models.length > 0
    ? models.slice(0, 5).map((m, i) => `  - "${m.name}" — ${(m.description ?? "").slice(0, 120)}`).join("\n")
    : "  (none yet)";

  const systemPrompt = `You are an interactive research-model design assistant inside the "学术模型构建器" app. The user is a researcher who has already collected papers and extracted variables in this session, and now wants to refine the next round of model generation.

Reply in the SAME language the user writes in (mostly Chinese). Be conversational, warm, and concrete — never generic.

================ BILINGUAL MATCHING POLICY (CRITICAL) ================
The user writes in CHINESE. The papers, variable names, definitions, abstracts, citations, and theory backbones in the SESSION CONTEXT below are almost all in ENGLISH. NEVER do literal Chinese-string matching — you will find nothing and tell the user "your papers don't cover this", which is wrong.

Instead, for every Chinese term the user types, run this mental pipeline BEFORE you search the session context:
1. Normalize the Chinese term to its standard ACADEMIC ENGLISH equivalent(s). Use the field-standard construct name, not a dictionary translation. Examples:
   - "感知有用性" → "perceived usefulness" (TAM construct), NOT "felt useful"
   - "购买意愿" → "purchase intention" / "intention to purchase" / "buying intention"
   - "信任" → "trust" — but disambiguate: "对系统的信任" → "system trust / trust in technology / automation trust"; "人际信任" → "interpersonal trust"; "对品牌的信任" → "brand trust"
   - "感知风险" → "perceived risk"; further split into "perceived privacy risk", "perceived financial risk", "perceived performance risk" if the user's context suggests a sub-type
   - "电商" / "电子商务" → "e-commerce / online shopping / online retail"
   - "短视频" → "short-form video / short video platform / TikTok / Douyin"
   - "直播带货" → "livestream commerce / live streaming e-commerce / live shopping"
   - "AI 主播" / "数字人" → "AI broadcaster / virtual influencer / digital human / AI anchor / virtual streamer"
   - "聊天机器人" → "chatbot / conversational agent / dialogue agent"
   - "推荐系统" → "recommender system / recommendation system / personalized recommendation"
   - "用户体验" → "user experience (UX)"; "心流" → "flow experience"; "沉浸感" → "immersion / immersive experience"
   - "中介" / "中介变量" → "mediator / mediating variable / mediating role"
   - "调节" / "调节变量" → "moderator / moderating variable / boundary condition"
   - "结构方程模型" / "SEM" → "structural equation model"
   - "理论模型" / "概念模型" → "conceptual model / theoretical framework"
2. Generate 2-4 ENGLISH SYNONYMS per Chinese term so a paper using a slightly different label still matches (e.g. "elaboration likelihood" vs "ELM"; "trust in AI" vs "AI trust" vs "automation trust").
3. Match the English candidates (case-insensitive, substring-aware) against the VARIABLES list and PAPERS list below. A variable's name OR definition counts. A paper's title OR abstract counts.
4. ONLY after this English-mapped search comes up empty should you tell the user "this construct isn't in the current papers" and emit a needs_more_papers block (with the English query, not the Chinese one).

When you reply to the user (in Chinese), refer to the matched variables and papers by the names they actually have in the session (English is fine — the user is fine seeing the English variable name even if they don't read English well, because they recognize their own data). When you cite a Chinese term they used, append the English mapping in parens once: "你说的『感知有用性』(perceived usefulness) 已经在第 3 篇论文里出现…". This keeps your reasoning auditable for the user.

When you fill the 'userPrompt' field inside a \`\`\`suggestion\`\`\` block, write it in CHINESE for the user's readability BUT also include the ENGLISH construct names in parens for the downstream model-generation AI to anchor on (e.g. "聚焦『感知信任』(perceived trust) 对『购买意愿』(purchase intention) 的影响…"). Same rule for the 'searchQuery' field inside needs_more_papers — that one stays pure English (it goes straight to the academic search API).
======================================================================

YOUR JOB:
1. Read what the user says (and any attached files: text or image).
2. Connect their idea/breakthrough to the SPECIFIC variables and papers already in this session.
3. Ask short clarifying questions when needed (1 question at a time, only if truly necessary).
4. When the user's intent is clear enough to act on, end your reply with a JSON suggestion block in fences exactly like:
\`\`\`suggestion
{
  "userPrompt": "<a sharp, well-written instruction the model-generation AI should follow — Chinese is fine>",
  "focusVariableIds": [<int>, ...],
  "requiredOperators": ["EXTEND" | "INSERT_MODERATOR" | "PARALLEL_MEDIATORS" | "SWAP_MEDIATOR" | "THEORY_GRAFT", ...]
}
\`\`\`
Only emit the suggestion block when you are recommending the user click "套用并生成". If the user is still exploring, OMIT the block entirely.

The suggestion will pre-fill the generation form and select variables — keep userPrompt under 600 chars, focusVariableIds 2-6 items, requiredOperators 1-2 items.

5. **DIRECT EDITS to the live model (the "我的研究模型" diagram)**: When the user explicitly asks you to add / remove / modify the active research-model diagram (e.g. "把 X 节点去掉"、"加上感知信任 → 购买意愿 正向"、"把 A→B 改成中介"), DO NOT just suggest a regeneration — emit a direct-edit block that the server will apply to the live model immediately:
\`\`\`liveModelOps
{
  "summary": "<one-sentence Chinese summary of what you changed>",
  "ops": [
    {"type": "addNode", "variableId": <int>},
    {"type": "removeNode", "variableId": <int>},
    {"type": "addEdge", "fromVariableId": <int>, "toVariableId": <int>, "relationship": "positive|negative|mediates|moderates", "provenancePaperId": <int|null>, "provenanceCitationText": "<short excerpt or null>"},
    {"type": "removeEdge", "fromVariableId": <int>, "toVariableId": <int>, "relationship": "positive|negative|mediates|moderates"}
  ]
}
\`\`\`
RULES for liveModelOps:
- Only emit when the user EXPLICITLY asks for a direct edit. For exploratory questions ("能不能这样设计?") OMIT this block — use \`suggestion\` instead.
- Every \`variableId\` MUST be a real id from the VARIABLES list below. Never invent ids.
- Modifying an edge = removeEdge + addEdge in the same block.
- For addEdge, prefer to set \`provenancePaperId\` + a short \`provenanceCitationText\` (≤ 200 chars) drawn from the paper's abstract; if the user is making an exploratory link without paper backing, set both to null and the system will mark the edge as user-added.
- Keep ops ≤ 6 per turn so the user can review them. If a request needs more, do the most important ones and tell the user what was deferred.
- You can emit liveModelOps AND a chat reply explaining what you did. You may ALSO emit a follow-up suggestion block if a regeneration would further refine things.

6. **CRITICAL — material-sufficiency check**: BEFORE you emit a suggestion block, judge whether the existing papers and variables actually cover the user's research question. If a key construct is missing (e.g. user wants a moderator type that no current paper measures, or wants a context/population not represented), DO NOT pretend — instead emit a needs-more-papers block in fences exactly like:
\`\`\`needs_more_papers
{
  "reason": "<one short Chinese sentence explaining what is missing and why current materials can't cover it>",
  "searchQuery": "<2-6 word English search query the user can paste into OpenAlex>",
  "missingConstructs": ["<construct 1>", "<construct 2>"]
}
\`\`\`
You may emit BOTH a suggestion block AND a needs_more_papers block in the same reply if you can give a partial model now but recommend strengthening it with more literature. If materials are clearly sufficient, OMIT the needs_more_papers block entirely.

================ SESSION CONTEXT ================
${sessionTopic ? `RESEARCH TOPIC / USER'S STATED DIRECTION (TOP PRIORITY — every suggestion must advance this exact topic):
Project: "${sessionName || "(unnamed)"}"
Topic: """
${sessionTopic}
"""
When suggesting model combinations, prefer papers and variables that directly serve this topic. If a paper in the pool below is tangential, say so plainly instead of treating it as a peer — and if the user's request would drift away from the stated topic, ask one short clarifying question before suggesting.

` : ""}PAPERS (${papers.length}):
${paperLines || "  (none)"}

VARIABLES (${variables.length}):
${varLines}

EXISTING GENERATED MODELS:
${existingModelLines}

CURRENT LIVE MODEL (the user's "我的研究模型" diagram — this is the canvas your liveModelOps will edit):
${(() => {
  if (liveNodes.length === 0 && liveEdges.length === 0) return "  (empty — no nodes or edges yet)";
  const nodeLines = liveNodes.length === 0 ? "  (no nodes)" : liveNodes.map((n) => {
    const v = variables.find((vv) => vv.id === n.variableId);
    return `    - variableId=${n.variableId} [${v?.type ?? "?"}] "${v?.name ?? `#${n.variableId}`}"${n.userAdded ? " (user-added)" : ""}`;
  }).join("\n");
  const edgeLines = liveEdges.length === 0 ? "  (no edges)" : liveEdges.map((e) => {
    const fv = variables.find((v) => v.id === e.fromVariableId);
    const tv = variables.find((v) => v.id === e.toVariableId);
    return `    - ${e.fromVariableId} "${fv?.name ?? "?"}" —[${e.relationship}]→ ${e.toVariableId} "${tv?.name ?? "?"}"${e.userAdded ? " (user-added)" : ""}`;
  }).join("\n");
  return `  Nodes (${liveNodes.length}):\n${nodeLines}\n  Edges (${liveEdges.length}):\n${edgeLines}`;
})()}

AVAILABLE STRUCTURAL OPERATORS:
${operatorsAsPromptBlock()}

AVAILABLE THEORY BACKBONES:
${backbonesAsPromptBlock()}
${await buildUserPersonalizationContext(req.user?.id)}
================================================

Be specific. Reference variables and papers BY NAME. Never invent variables that aren't in the list above.`;

  // Convert chat messages to OpenAI format. Attachments expand into multi-modal content arrays.
  const oaMessages: Array<{ role: "system" | "user" | "assistant"; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }> = [
    { role: "system", content: systemPrompt },
  ];

  for (const m of messages) {
    const atts = m.attachments ?? [];
    if (atts.length === 0) {
      oaMessages.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      // attachments only meaningful on user messages; flatten just in case
      oaMessages.push({ role: "assistant", content: m.content });
      continue;
    }
    const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
    if (m.content?.trim()) parts.push({ type: "text", text: m.content });
    for (const a of atts) {
      if (a.kind === "image") {
        // Expect a data URL or http(s) URL.
        const url = a.data.startsWith("data:") || a.data.startsWith("http") ? a.data : `data:image/png;base64,${a.data}`;
        parts.push({ type: "image_url", image_url: { url } });
      } else {
        // text attachment — limit each to 8000 chars to control token usage.
        const truncated = a.data.slice(0, 8000);
        parts.push({ type: "text", text: `[Attached file: ${a.name}]\n${truncated}${a.data.length > 8000 ? "\n…(truncated)" : ""}` });
      }
    }
    oaMessages.push({ role: "user", content: parts });
  }

  try {
    // Abort before the 60s Autoscale Deployment proxy timeout so we can return
    // a clean JSON error instead of a generic 502.
    const completion = await openai.chat.completions.create(
      {
        model: "gpt-5.4",
        max_completion_tokens: 2400,
        messages: oaMessages as any,
      },
      { signal: AbortSignal.timeout(50_000) },
    );
    logAiUsageFromOpenAI(completion, { route: "model-assistant/chat", sessionId: Number(req.params["id"]) || null, userId: req.user?.id ?? null });
    scheduleProfileRefresh(req.user?.id, Number(req.params["id"]) || undefined);

    const raw = completion.choices[0]?.message?.content ?? "";

    // Extract optional ```suggestion {...}``` block.
    let reply = raw;
    let suggestion: { userPrompt?: string; focusVariableIds?: number[]; requiredOperators?: string[] } | undefined;
    const m = raw.match(/```suggestion\s*([\s\S]*?)```/i);
    if (m) {
      try {
        const parsed = JSON.parse(m[1].trim());
        const validVarIds = new Set(variables.map((v) => v.id));
        const cleanedFocus = Array.isArray(parsed.focusVariableIds)
          ? parsed.focusVariableIds.filter((x: unknown) => typeof x === "number" && validVarIds.has(x))
          : [];
        const allowedOps = new Set(["EXTEND", "INSERT_MODERATOR", "PARALLEL_MEDIATORS", "SWAP_MEDIATOR", "THEORY_GRAFT"]);
        const cleanedOps = Array.isArray(parsed.requiredOperators)
          ? parsed.requiredOperators.filter((x: unknown) => typeof x === "string" && allowedOps.has(x))
          : [];
        suggestion = {
          userPrompt: typeof parsed.userPrompt === "string" ? parsed.userPrompt.slice(0, 800) : undefined,
          focusVariableIds: cleanedFocus,
          requiredOperators: cleanedOps,
        };
        reply = reply.replace(m[0], "").trim();
      } catch (err) {
        req.log.warn({ err, block: m[1] }, "Failed to parse suggestion block");
      }
    }

    // Extract optional ```liveModelOps {...}``` block and apply directly to
    // the session's live model. This is the "chat ↔ diagram" bridge: when the
    // user asks "去掉 X" or "加上 A→B 正向", the AI emits ops, the server
    // applies them in this same request, and the frontend invalidates its
    // live-model query so the diagram updates immediately.
    let liveModelApplied: { summary: string; applied: AppliedOp[]; rejected: RejectedOp[]; liveModelVersion: number } | undefined;
    const lm = raw.match(/```liveModelOps\s*([\s\S]*?)```/i);
    if (lm) {
      try {
        const parsed = JSON.parse(lm[1].trim());
        const opsRaw = Array.isArray(parsed.ops) ? parsed.ops : [];
        const summary = typeof parsed.summary === "string" ? parsed.summary.slice(0, 240) : "";
        const ops: LiveOp[] = [];
        for (const o of opsRaw.slice(0, 12)) {
          if (typeof o !== "object" || o === null) continue;
          const t = (o as { type?: unknown }).type;
          if (t === "addNode" || t === "removeNode") {
            const vid = Number((o as { variableId?: unknown }).variableId);
            if (Number.isFinite(vid)) ops.push({ type: t, variableId: vid });
          } else if (t === "addEdge" || t === "removeEdge") {
            const fr = Number((o as { fromVariableId?: unknown }).fromVariableId);
            const to = Number((o as { toVariableId?: unknown }).toVariableId);
            const rel = String((o as { relationship?: unknown }).relationship ?? "");
            if (!Number.isFinite(fr) || !Number.isFinite(to) || !rel) continue;
            if (t === "addEdge") {
              const pid = (o as { provenancePaperId?: unknown }).provenancePaperId;
              const ct = (o as { provenanceCitationText?: unknown }).provenanceCitationText;
              ops.push({
                type: "addEdge",
                fromVariableId: fr,
                toVariableId: to,
                relationship: rel,
                provenancePaperId: typeof pid === "number" && Number.isFinite(pid) ? pid : null,
                provenanceCitationText: typeof ct === "string" ? ct : null,
              });
            } else {
              ops.push({ type: "removeEdge", fromVariableId: fr, toVariableId: to, relationship: rel });
            }
          }
        }
        if (ops.length > 0) {
          const sessionVarIds = new Set(variables.map((v) => v.id));
          const varNameById = new Map(variables.map((v) => [v.id, v.name] as const));
          const sessionPaperIds = new Set(papers.map((p) => p.id));
          const result = await applyLiveModelOps(sessionId, ops, { sessionVarIds, varNameById, sessionPaperIds });
          liveModelApplied = { summary: summary || `已应用 ${result.applied.length} 项改动`, ...result };
        }
        reply = reply.replace(lm[0], "").trim();
      } catch (err) {
        req.log.warn({ err, block: lm[1] }, "Failed to parse liveModelOps block");
      }
    }

    // Extract optional ```needs_more_papers {...}``` block.
    let needsMorePapers: { reason: string; searchQuery?: string; missingConstructs?: string[] } | undefined;
    const nm = raw.match(/```needs_more_papers\s*([\s\S]*?)```/i);
    if (nm) {
      try {
        const parsed = JSON.parse(nm[1].trim());
        if (typeof parsed.reason === "string" && parsed.reason.trim().length > 0) {
          needsMorePapers = {
            reason: parsed.reason.slice(0, 400),
            searchQuery: typeof parsed.searchQuery === "string" ? parsed.searchQuery.slice(0, 120) : undefined,
            missingConstructs: Array.isArray(parsed.missingConstructs)
              ? parsed.missingConstructs.filter((x: unknown) => typeof x === "string").slice(0, 6)
              : undefined,
          };
        }
        reply = reply.replace(nm[0], "").trim();
      } catch (err) {
        req.log.warn({ err, block: nm[1] }, "Failed to parse needs_more_papers block");
      }
    }

    // Persist the latest user turn + the assistant reply so the conversation
    // survives page reload. We strip attachment binary data — only `name` +
    // `kind` are kept so the user still sees "I attached file X" in history.
    try {
      const lastUser = [...messages].reverse().find((mm) => mm.role === "user");
      const rows: Array<{ sessionId: number; role: string; content: string; attachments: unknown }> = [];
      if (lastUser) {
        const slimAtts = (lastUser.attachments ?? []).map((a) => ({ name: a.name, kind: a.kind }));
        rows.push({
          sessionId,
          role: "user",
          content: lastUser.content ?? "",
          attachments: slimAtts.length ? slimAtts : null,
        });
      }
      rows.push({ sessionId, role: "assistant", content: reply, attachments: null });
      if (rows.length) await db.insert(modelAssistantMessagesTable).values(rows);
    } catch (err) {
      req.log.warn({ err }, "Failed to persist model-assistant messages (non-fatal)");
    }

    res.json({ reply, suggestion, needsMorePapers, liveModelApplied });
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    const aborted = e?.name === "AbortError" || e?.name === "TimeoutError" || /aborted|timeout/i.test(e?.message ?? "");
    if (aborted) {
      req.log.warn({ err, sessionId }, "Model assistant timed out (>50s)");
      res.status(504).json({ error: "AI 回复时间超过 50 秒。请把问题写得更短一些再试，或把部署切到 Reserved VM 以解除超时限制。" });
      return;
    }
    req.log.error({ err }, "Model assistant chat failed");
    res.status(500).json({ error: "Assistant failed to respond" });
  }
});

router.get("/sessions/:id/model-assistant/messages", async (req, res) => {
  const params = ChatModelAssistantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const sessionId = params.data.id;
  const rows = await db
    .select()
    .from(modelAssistantMessagesTable)
    .where(eq(modelAssistantMessagesTable.sessionId, sessionId))
    .orderBy(asc(modelAssistantMessagesTable.id));
  res.json({
    messages: rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      attachments: r.attachments ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

router.delete("/sessions/:id/model-assistant/messages", async (req, res) => {
  const params = ChatModelAssistantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const sessionId = params.data.id;
  await db.delete(modelAssistantMessagesTable).where(eq(modelAssistantMessagesTable.sessionId, sessionId));
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Image search: find research-model / conceptual-framework figures on the web.
//
// Strategy:
//  1. Use OpenAI to expand the user's (often-rough, often-Chinese) topic into
//     2-3 precise English academic search queries.
//  2. For each expanded query, run Brave image search restricted to a curated
//     list of academic domains (ScienceDirect, Springer, ResearchGate, PMC,
//     etc.) using the `site:` operator so we only pull figures from real
//     papers — not stock art.
//  3. Merge results, dedupe by source URL, score by topic relevance + figure
//     hints + academic-domain bonus, and return the top N.
//  4. If `raw=true`, skip OpenAI expansion and use the user's text verbatim.
// ---------------------------------------------------------------------------
type ImageCategory = "conceptual_model" | "sem_path" | "framework" | "other";

type ImageSearchHit = {
  title: string;
  thumbnailUrl: string;
  imageUrl: string;
  sourceUrl: string;
  sourceDomain: string;
  width?: number;
  height?: number;
  category?: ImageCategory; // assigned by AI gate; absent when AI was skipped
  _score: number;
  _matched: number;
  _query: string;
};

// Hard-block obvious noise BEFORE the AI gate so the model spends its budget
// on actually-ambiguous candidates. Patterns are anchored on common stock /
// off-topic phrasing seen in real result sets.
const HARD_NEGATIVE_TITLE_RE = /(stock photo|shutterstock|gettyimages|getty images|istockphoto|alamy|clipart|powerpoint template|ppt template|wallpaper hd|coloring page|cartoon vector|cad drawing|circuit diagram|wiring diagram|p&id|piping diagram|er diagram example|class diagram example|gene expression heatmap|protein structure|molecular structure|crystal structure|swimlane|gantt chart|mind map template)/i;
const HARD_NEGATIVE_DOMAIN_RE = /(shutterstock\.com|gettyimages\.com|istockphoto\.com|alamy\.com|dreamstime\.com|123rf\.com|pinterest\.|wallpaper|clipart-library|vecteezy\.com|freepik\.com|canva\.com\/templates|slidesgo\.com|slidemodel\.com|smartdraw\.com)/i;

// Pre-built `site:a OR site:b OR …` clause for the publisher-restricted lane.
// We pick the publishers most likely to host conceptual-model figure pages
// with stable URLs.
const PUBLISHER_SITE_FILTER = [
  "researchgate.net",
  "sciencedirect.com",
  "link.springer.com",
  "onlinelibrary.wiley.com",
  "tandfonline.com",
  "emerald.com",
  "journals.sagepub.com",
  "frontiersin.org",
  "mdpi.com",
  "pmc.ncbi.nlm.nih.gov",
].map((d) => `site:${d}`).join(" OR ");

const ACADEMIC_SITES = [
  "sciencedirect.com",
  "link.springer.com",
  "springer.com",
  "springeropen.com",
  "pmc.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov",
  "pubmed.ncbi.nlm.nih.gov",
  "researchgate.net",
  "semanticscholar.org",
  "academia.edu",
  "tandfonline.com",
  "onlinelibrary.wiley.com",
  "wiley.com",
  "emerald.com",
  "emeraldinsight.com",
  "frontiersin.org",
  "mdpi.com",
  "arxiv.org",
  "ieeexplore.ieee.org",
  "dl.acm.org",
  "journals.sagepub.com",
  "journals.plos.org",
  "nature.com",
  "cambridge.org",
  "oup.com",
  "academic.oup.com",
  "ssrn.com",
  "papers.ssrn.com",
  "jstor.org",
  "scholasticahq.com",
  "biomedcentral.com",
  "bmj.com",
  "tandfonline.com",
  "informaworld.com",
  "elsevier.com",
  "doi.org",
  "core.ac.uk",
  "openreview.net",
];

const FIGURE_HINT_RE = /\b(framework|model|figure|fig\.|diagram|hypothes|conceptual|theoretical|construct|sem |moderat|mediat|antecedent|outcome)/i;

// Hostname-anchored academic check: accepts only when the URL's actual hostname
// equals or is a subdomain of one of ACADEMIC_SITES. Avoids false positives
// from substrings appearing in paths/queries or deceptive hostnames.
function isAcademicSource(sourceUrl: string): boolean {
  let host: string;
  try {
    host = new URL(sourceUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ACADEMIC_SITES.some((d) => host === d || host.endsWith(`.${d}`));
}

// Second-pass AI relevance gate: given the user's topic + session context and a
// list of candidate figure titles + source URLs, return the subset of indices
// to KEEP, each tagged with a CATEGORY so the UI can show the user WHY each
// image was kept ("✓ SEM 路径图", "✓ 概念模型图"). Figures that are off-topic
// (neural-network diagrams, journal logos, generic flowcharts, etc.) get
// dropped. Returns null if the AI call fails — caller falls back to ungated.
async function aiRelevanceFilter(
  rawQuery: string,
  expandedQueries: string[],
  candidates: Array<{ title: string; sourceDomain: string }>,
  sessionCtx: SessionImageCtx | null,
  usageMeta: { sessionId: number | null; userId: string | null } = { sessionId: null, userId: null },
): Promise<Array<{ i: number; category: ImageCategory; why?: string }> | null> {
  if (candidates.length === 0) return [];
  try {
    const list = candidates
      .map((c, i) => `${i}. [${c.sourceDomain}] ${c.title.slice(0, 180)}`)
      .join("\n");
    const ctxBlock = sessionCtx
      ? `\nSESSION CONTEXT (the user's actual research):
- Topic: ${sessionCtx.topic ?? "(not specified)"}
- Key variables: ${sessionCtx.variableNames.slice(0, 12).join(", ") || "(none)"}
- Sample paper titles: ${sessionCtx.paperTitles.slice(0, 5).join(" | ") || "(none)"}\n`
      : "";
    const completion: any = await openai.chat.completions.create({
      // Cost optimisation: this is a bounded classification task (pick one of 4
      // categories per candidate, write a ≤30-char "why" string). gpt-5-mini
      // handles it with effectively the same accuracy as gpt-5.4 at ~10×
      // cheaper input and ~5× cheaper completion. Per OpenAI's published list
      // pricing, this single change is the largest sustained spend cut on the
      // route — image search runs on every "find figures" click.
      model: "gpt-5-mini",
      max_completion_tokens: 1000,
      messages: [
        {
          role: "system",
          content: `You are pre-cleaning image search results for an academic researcher. They want CONCEPTUAL MODEL / THEORETICAL FRAMEWORK / SEM PATH figures from research papers — the boxes-and-arrows diagrams that researchers draw to summarize hypothesized relationships among constructs.

For each candidate, choose ONE category:
- "conceptual_model" → boxes-and-arrows diagram of constructs and hypothesized relationships (the gold standard)
- "sem_path" → structural equation model / PLS-SEM path diagram with coefficients
- "framework" → broader theoretical framework / antecedents-mediators-outcomes diagram
- "other" → DROP. Includes: neural network architecture, system architecture, data flow, gene/molecular figures, journal logos, generic flowcharts with no topic words, stock photos, presentation templates, screenshots of UIs, photo of a person, methodology flowchart, PRISMA diagram

Be GENEROUS for the first 3 categories when the source is a reputable academic publisher AND the topic words plausibly match — paper-figure thumbnails often have terse titles like "Fig. 1" or "Conceptual model".
Be STRICT for "other" — when in doubt and topic words are missing, drop it.

For EACH kept entry, also write a SHORT "why" string (≤30 Chinese characters or ≤60 English characters) explaining concretely why this figure matches the user's research — reference the specific session topic / variables / construct chains when possible. Examples: "覆盖你研究中的感知信任→购买意愿路径", "Frames AI streamer trust as antecedent of purchase intention".

Output ONLY a JSON object: {"keep":[{"i":0,"category":"conceptual_model","why":"..."}, {"i":3,"category":"sem_path","why":"..."}]} — only entries you are keeping. Do not echo the rest.`,
        },
        {
          role: "user",
          content: `User's topic (Chinese or rough English): ${rawQuery}
Expanded English queries: ${expandedQueries.join(" | ")}${ctxBlock}

Candidates:
${list}`,
        },
      ],
    });
    const txt = completion.choices[0]?.message?.content ?? "";
    const match = txt.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { keep?: unknown };
    if (!Array.isArray(parsed.keep)) return null;
    const allowed = new Set<ImageCategory>(["conceptual_model", "sem_path", "framework"]);
    const out: Array<{ i: number; category: ImageCategory; why?: string }> = [];
    for (const e of parsed.keep) {
      if (typeof e !== "object" || e === null) continue;
      const i = (e as { i?: unknown }).i;
      const c = (e as { category?: unknown }).category;
      const w = (e as { why?: unknown }).why;
      if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= candidates.length) continue;
      if (typeof c !== "string" || !allowed.has(c as ImageCategory)) continue;
      const why = typeof w === "string" && w.trim().length > 0 ? w.trim().slice(0, 120) : undefined;
      out.push({ i, category: c as ImageCategory, why });
    }
    // Defend against the AI returning an empty list when it shouldn't — if it
    // dropped EVERYTHING, fall back rather than show nothing.
    logAiUsageFromOpenAI(completion, { route: "model-assistant/image-relevance", sessionId: usageMeta.sessionId, userId: usageMeta.userId });
    if (out.length === 0 && candidates.length >= 4) return null;
    return out;
  } catch {
    return null;
  }
}

type SessionImageCtx = {
  topic: string | null;
  variableNames: string[];
  paperTitles: string[];
};

async function expandQueriesWithAI(
  rawQuery: string,
  sessionCtx: SessionImageCtx | null,
  usageMeta: { sessionId: number | null; userId: string | null } = { sessionId: null, userId: null },
): Promise<string[]> {
  // Ask GPT to translate the user's rough/Chinese phrasing into 3-5 precise
  // English academic queries — GROUNDED in the session's actual variables and
  // paper titles when available, so we don't drift to a generic interpretation.
  try {
    const ctxBlock = sessionCtx
      ? `\nSESSION CONTEXT (use this to ground the queries — they should target THIS user's specific research, not a generic interpretation):
- Topic: ${sessionCtx.topic ?? "(unspecified)"}
- Variables already extracted: ${sessionCtx.variableNames.slice(0, 16).join(", ") || "(none)"}
- Sample paper titles in this project: ${sessionCtx.paperTitles.slice(0, 6).join(" | ") || "(none)"}`
      : "";
    const completion: any = await openai.chat.completions.create({
      // Cost optimisation: query expansion is a small, well-scoped translation
      // task with a fixed output schema (3-5 short English strings). gpt-5-mini
      // matches gpt-5.4 quality here at a fraction of the cost.
      model: "gpt-5-mini",
      max_completion_tokens: 500,
      messages: [
        {
          role: "system",
          content: `You convert a user's rough research topic into 3-5 PRECISE English academic search queries that will find conceptual model / theoretical framework / SEM-path FIGURES inside published research papers.

Rules:
- Output ONLY a JSON object: {"queries": ["query 1", "query 2", "query 3", ...]}
- Each query: 4-9 words, all lowercase English, NO quotes, NO site: filters
- Use canonical academic terminology (e.g. "parasocial interaction", "purchase intention", "perceived anthropomorphism", "live streaming commerce", "technology acceptance", "perceived usefulness", "psychological safety")
- If the input mentions Chinese constructs (e.g. 直播/主播/冲动消费/信任/心流/远程办公), translate to standard academic English equivalents
- When SESSION CONTEXT is provided, AT LEAST 2 of the queries must combine the user's topic with SPECIFIC constructs from their session variables (e.g. if user says "AI 主播" and session has variables "perceived trust" + "purchase intention", produce "AI streamer perceived trust purchase intention")
- Each query should target a DIFFERENT variant of the topic — vary the construct combinations, do not paraphrase
- Do NOT include words like "research", "model", "framework", "figure", "diagram" — they're added separately`,
        },
        { role: "user", content: `User's input: ${rawQuery}${ctxBlock}` },
      ],
    });
    logAiUsageFromOpenAI(completion, { route: "model-assistant/expand-image-queries", sessionId: usageMeta.sessionId, userId: usageMeta.userId });
    const txt = completion.choices[0]?.message?.content ?? "";
    // Extract first JSON object
    const match = txt.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as { queries?: unknown };
    if (!Array.isArray(parsed.queries)) return [];
    return parsed.queries
      .filter((q): q is string => typeof q === "string")
      .map((q) => q.trim())
      .filter((q) => q.length >= 3)
      .slice(0, 5);
  } catch (err) {
    return [];
  }
}

// Load session context (topic + variable names + paper titles) for grounding
// the image-search queries and the AI relevance gate. Never throws — returns
// null on any DB issue so image search still works.
async function loadSessionImageCtx(sessionId: number): Promise<SessionImageCtx | null> {
  try {
    const [sessionRow, vars, papers] = await Promise.all([
      db.select({ topic: sessionsTable.topic }).from(sessionsTable).where(eq(sessionsTable.id, sessionId)).limit(1),
      db.select({ name: variablesTable.name }).from(variablesTable).where(eq(variablesTable.sessionId, sessionId)),
      db.select({ title: papersTable.title }).from(papersTable).where(and(eq(papersTable.sessionId, sessionId), sql`${papersTable.externalId} NOT LIKE 'manual:%'`)),
    ]);
    const topic = sessionRow[0]?.topic?.trim() || null;
    return {
      topic,
      variableNames: vars.map((v) => v.name).filter((n) => !!n),
      paperTitles: papers.map((p) => p.title).filter((t) => !!t),
    };
  } catch {
    return null;
  }
}

// SerpApi → Google Images. Higher-quality results than Brave (Google's index is
// ~10x larger). Returns the same normalized shape as braveImageSearch.
async function serpApiImageSearch(
  query: string,
  apiKey: string,
  count: number,
  log: { warn: (o: object, m: string) => void },
  page: number = 1,
): Promise<Array<{ raw: any; title: string; sourceUrl: string; thumbnailUrl: string; fullImage: string; sourceDomain: string; width?: number; height?: number }>> {
  const isHttp = (u: string) => /^https?:\/\//i.test(u);
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_images");
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(Math.min(count, 100)));
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("safe", "active");
  // tbs=isz:m biases toward medium+ images (filters tiny icons/logos)
  url.searchParams.set("tbs", "isz:m");
  // SerpApi google_images uses ijn for page (0-indexed; each page = up to 100 imgs)
  if (page > 1) url.searchParams.set("ijn", String(page - 1));

  const r = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  if (!r.ok) {
    log.warn({ status: r.status, query }, "SerpApi image search failed for one query");
    return [];
  }
  const data = (await r.json()) as {
    error?: string;
    images_results?: Array<{
      position?: number;
      title?: string;
      link?: string; // page URL
      source?: string;
      original?: string; // full image URL
      original_width?: number;
      original_height?: number;
      thumbnail?: string;
      thumbnail_width?: number;
      thumbnail_height?: number;
    }>;
  };
  if (data.error) {
    log.warn({ error: data.error, query }, "SerpApi returned an error");
    return [];
  }
  return (data.images_results ?? [])
    .map((item) => {
      const sourceUrl = item.link ?? "";
      const thumbnailUrl = item.thumbnail ?? "";
      const fullImage = item.original && isHttp(item.original) ? item.original : thumbnailUrl;
      if (!sourceUrl || !thumbnailUrl || !isHttp(sourceUrl) || !isHttp(thumbnailUrl)) return null;
      let domain = item.source ?? "";
      if (!domain) {
        try { domain = new URL(sourceUrl).hostname; } catch { /* ignore */ }
      }
      return {
        raw: item,
        title: (item.title ?? "").slice(0, 200),
        sourceUrl,
        thumbnailUrl,
        fullImage,
        sourceDomain: domain,
        width: item.original_width,
        height: item.original_height,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

async function braveImageSearch(
  query: string,
  apiKey: string,
  count: number,
  log: { warn: (o: object, m: string) => void },
  page: number = 1,
): Promise<Array<{ raw: any; title: string; sourceUrl: string; thumbnailUrl: string; fullImage: string; sourceDomain: string; width?: number; height?: number }>> {
  const isHttp = (u: string) => /^https?:\/\//i.test(u);
  const url = new URL("https://api.search.brave.com/res/v1/images/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  url.searchParams.set("safesearch", "strict");
  // Brave images: offset is 0-indexed page number (each page = `count` results)
  if (page > 1) url.searchParams.set("offset", String(Math.min(page - 1, 9)));

  const r = await fetch(url.toString(), {
    headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
  });
  if (!r.ok) {
    log.warn({ status: r.status, query }, "Brave image search failed for one query");
    return [];
  }
  const data = (await r.json()) as {
    results?: Array<{
      title?: string;
      url?: string;
      source?: string;
      thumbnail?: { src?: string };
      properties?: { url?: string; width?: number; height?: number };
      meta_url?: { hostname?: string; netloc?: string };
    }>;
  };
  return (data.results ?? [])
    .map((item) => {
      const sourceUrl = item.url ?? "";
      const thumbnailUrl = item.thumbnail?.src ?? item.properties?.url ?? "";
      if (!sourceUrl || !thumbnailUrl || !isHttp(sourceUrl) || !isHttp(thumbnailUrl)) return null;
      const fullImage = item.properties?.url && isHttp(item.properties.url) ? item.properties.url : thumbnailUrl;
      return {
        raw: item,
        title: (item.title ?? "").slice(0, 200),
        sourceUrl,
        thumbnailUrl,
        fullImage,
        sourceDomain: item.meta_url?.hostname ?? item.source ?? "",
        width: item.properties?.width,
        height: item.properties?.height,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

router.post("/sessions/:id/model-assistant/search-model-images", async (req, res) => {
  const params = ChatModelAssistantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const rawQuery = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!rawQuery) {
    res.status(400).json({ error: "Missing query" });
    return;
  }
  const count = Math.min(20, Math.max(1, Number(req.body?.count) || 12));
  const page = Math.min(10, Math.max(1, Number(req.body?.page) || 1));
  const rawMode = req.body?.raw === true;

  const serpKey = process.env.SERPAPI_API_KEY;
  const braveKey = process.env.BRAVE_API_KEY;
  if (!serpKey && !braveKey) {
    res.status(503).json({ error: "Image search is not configured (missing SERPAPI_API_KEY or BRAVE_API_KEY)" });
    return;
  }

  try {
    // ---- Stage 0: load session context for grounded queries -------------
    const sessionCtx = rawMode ? null : await loadSessionImageCtx(params.data.id);

    // ---- Stage 1: build the list of expanded query strings ---------------
    let expandedQueries: string[] = [];
    if (rawMode) {
      expandedQueries = [rawQuery];
    } else {
      const aiQueries = await expandQueriesWithAI(rawQuery, sessionCtx, { sessionId: params.data.id, userId: req.user?.id ?? null });
      // Always include the user's literal phrase too, in case the AI dropped a
      // critical token. BUT: if the user pasted a long thesis title (>10
      // words), quoting it produces a 25+ word phrase search that matches
      // nothing useful on Google Images. In that case we compact to first 8
      // lowercase content words (same `compactDistilledQuery` rules used by
      // the chat opening nudge) so the literal fallback is still searchable.
      const wordCount = rawQuery.split(/\s+/).filter(Boolean).length;
      let literalFallback: string;
      if (wordCount > 10) {
        const compacted = compactDistilledQuery(rawQuery);
        literalFallback = compacted ?? rawQuery.split(/\s+/).slice(0, 8).join(" ");
      } else {
        literalFallback = /\s/.test(rawQuery) && !/^".*"$/.test(rawQuery) ? `"${rawQuery}"` : rawQuery;
      }
      expandedQueries = [...aiQueries, literalFallback];
      // Dedupe (case-insensitive) while preserving order.
      const seen = new Set<string>();
      expandedQueries = expandedQueries.filter((q) => {
        const k = q.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (expandedQueries.length === 0) expandedQueries = [quoted];
    }

    // ---- Stage 2: run image search across PARALLEL LANES ----------------
    //   Lane A (general):   "<query> conceptual model figure"
    //   Lane B (publisher): "<query> conceptual model figure (site:rg OR site:sd OR …)"
    // Lane B widens coverage with academic publisher pages broad search misses.
    // Provider priority: SerpApi (Google Images) → Brave. Brave doesn't honor
    // OR site: filters reliably so Lane B is SerpApi-only.
    const perQueryFetch = 25;
    let provider: "serpapi" | "brave" = "brave";
    type LaneItem = { raw: any; title: string; sourceUrl: string; thumbnailUrl: string; fullImage: string; sourceDomain: string; width?: number; height?: number; _query: string; _lane: "general" | "publisher" };
    let allItems: LaneItem[] = [];
    let anyOk = false;

    if (serpKey) {
      const laneA = expandedQueries.map((q) =>
        serpApiImageSearch(`${q} conceptual model figure`, serpKey, perQueryFetch, req.log, page).then((items) =>
          items.map((it) => ({ ...it, _query: q, _lane: "general" as const })),
        ),
      );
      const laneB = expandedQueries.slice(0, 3).map((q) =>
        // Parenthesize the OR-clause so Google parses it as one disjunction —
        // without parens, "topic site:a OR site:b" is read as "(topic site:a) OR site:b"
        // which leaks unrestricted hits from site:b through.
        serpApiImageSearch(`${q} conceptual model figure (${PUBLISHER_SITE_FILTER})`, serpKey, perQueryFetch, req.log, page).then((items) =>
          items.map((it) => ({ ...it, _query: q, _lane: "publisher" as const })),
        ),
      );
      const settled = await Promise.allSettled<LaneItem[]>([...laneA, ...laneB]);
      const items: LaneItem[] = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
      const ok = settled.some((s) => s.status === "fulfilled" && s.value.length > 0);
      if (ok) {
        provider = "serpapi";
        allItems = items;
        anyOk = true;
      } else {
        req.log.warn({}, "SerpApi returned no results for any query — falling back to Brave");
      }
    }

    if (!anyOk && braveKey) {
      const calls = expandedQueries.map((q) =>
        braveImageSearch(`${q} conceptual model figure`, braveKey, perQueryFetch, req.log, page).then((items) =>
          items.map((it) => ({ ...it, _query: q, _lane: "general" as const })),
        ),
      );
      const settled = await Promise.allSettled(calls);
      allItems = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
      anyOk = settled.some((s) => s.status === "fulfilled");
      if (anyOk) provider = "brave";
    }

    if (!anyOk) {
      res.status(502).json({ error: "All image search queries failed" });
      return;
    }

    // ---- Stage 2.5: HARD negative filter (cheap pre-clean) --------------
    // Drop obvious garbage BEFORE we spend AI tokens on it. Stock photo
    // domains, presentation templates, gene heatmaps, etc.
    // Also: pull this session's per-user image blocklist and drop any URL the
    // user previously dismissed via the ✕ button.
    const blocklistRows = await db
      .select({ sourceUrl: imageBlocklistTable.sourceUrl, sourceDomain: imageBlocklistTable.sourceDomain })
      .from(imageBlocklistTable)
      .where(eq(imageBlocklistTable.sessionId, params.data.id));
    const blockedUrls = new Set(blocklistRows.map((r) => r.sourceUrl));
    // Per-URL only — never block by domain. Blocking one figure must NOT remove the
    // entire publisher (e.g. all of mdpi.com) from the session's future searches.
    const droppedHard = { byDomain: 0, byTitle: 0, byUserBlock: 0 };
    const preFiltered = allItems.filter((it) => {
      if (blockedUrls.has(it.sourceUrl)) {
        droppedHard.byUserBlock++;
        return false;
      }
      if (HARD_NEGATIVE_DOMAIN_RE.test(it.sourceDomain) || HARD_NEGATIVE_DOMAIN_RE.test(it.sourceUrl)) {
        droppedHard.byDomain++;
        return false;
      }
      if (HARD_NEGATIVE_TITLE_RE.test(it.title)) {
        droppedHard.byTitle++;
        return false;
      }
      return true;
    });

    // ---- Stage 3: dedupe by sourceUrl, then by thumbnailUrl --------------
    const bySource = new Map<string, (typeof preFiltered)[number]>();
    for (const it of preFiltered) {
      // Prefer the first occurrence (academic queries run first in flatMap order).
      if (!bySource.has(it.sourceUrl)) bySource.set(it.sourceUrl, it);
    }
    const seenThumb = new Set<string>();
    let deduped = Array.from(bySource.values()).filter((it) => {
      if (seenThumb.has(it.thumbnailUrl)) return false;
      seenThumb.add(it.thumbnailUrl);
      return true;
    });

    // ---- Stage 3.5: per-paper cap (avoid 5 thumbnails of the same paper) -
    // Key by ARTICLE identifier — DOI, ScienceDirect PII, Springer chapter id,
    // PMC id, ResearchGate publication id, arXiv id — falling back to the
    // FULL pathname (minus figure anchor / query). The naive "first 4 path
    // segments" approach collapses entire publishers (e.g. all ScienceDirect
    // articles share /science/article/pii) and over-suppresses good results.
    const perPaperCount = new Map<string, number>();
    function articleKey(rawUrl: string, domain: string): string {
      try {
        const u = new URL(rawUrl);
        const path = u.pathname;
        // DOI (any host) — strongest identifier.
        const doi = path.match(/\b(10\.\d{4,9}\/[^\s/?#]+)/i);
        if (doi) return `doi:${doi[1].toLowerCase()}`;
        // ScienceDirect / Elsevier PII.
        const pii = path.match(/\/pii\/([A-Z0-9]+)/i);
        if (pii) return `pii:${pii[1]}`;
        // PubMed Central.
        const pmc = path.match(/\/pmc\/articles\/(PMC\d+)/i);
        if (pmc) return `pmc:${pmc[1]}`;
        // arXiv.
        const arx = path.match(/\/abs\/(\d{4}\.\d{4,5})/);
        if (arx) return `arxiv:${arx[1]}`;
        // ResearchGate publication.
        const rg = path.match(/\/publication\/(\d+)/i);
        if (rg) return `rg:${rg[1]}`;
        // Default: full normalized pathname (lowercased, no trailing slash,
        // no fragment). Two figure URLs from the SAME article will normally
        // share this; two different articles won't.
        return `${domain}:${path.toLowerCase().replace(/\/+$/, "")}`;
      } catch {
        return rawUrl.slice(0, 80);
      }
    }
    deduped = deduped.filter((it) => {
      const key = articleKey(it.sourceUrl, it.sourceDomain);
      const n = perPaperCount.get(key) ?? 0;
      if (n >= 2) return false;
      perPaperCount.set(key, n + 1);
      return true;
    });

    // ---- Stage 4: relevance scoring --------------------------------------
    // Tokenize ALL queries (user + expanded) for matching, so an expanded
    // English query token also counts as relevance.
    const allTokens = new Set<string>();
    for (const q of [rawQuery, ...expandedQueries]) {
      for (const t of q.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/i)) {
        const tt = t.trim();
        if (tt.length >= 3 && !/^(the|and|for|with|from|that|this|are|was|were|model|research|framework|figure|diagram|conceptual|site)$/.test(tt)) {
          allTokens.add(tt);
        }
      }
    }

    const scored: (ImageSearchHit & { _academic: boolean })[] = deduped.map((it) => {
      const haystack = `${it.title} ${it.sourceUrl}`.toLowerCase();
      let score = 0;
      let matched = 0;
      for (const tok of allTokens) {
        if (haystack.includes(tok)) {
          score += 2;
          matched += 1;
        }
      }
      if (FIGURE_HINT_RE.test(it.title)) score += 2;
      const academic = isAcademicSource(it.sourceUrl);
      if (academic) score += 4;
      if (matched === 0 && /\b(example|template|stock|clipart|powerpoint|slide \d|getty|shutterstock)/i.test(it.title)) {
        score -= 4;
      }
      return {
        title: it.title || "(untitled)",
        thumbnailUrl: it.thumbnailUrl,
        imageUrl: it.fullImage,
        sourceUrl: it.sourceUrl,
        sourceDomain: it.sourceDomain,
        width: it.width,
        height: it.height,
        _score: score,
        _matched: matched,
        _query: (it as any)._query,
        _academic: academic,
      };
    });

    // ---- Stage 5: rank (broader mode — no strict academic filter) -------
    // Academic hosts get a scoring boost (Stage 4) but non-academic hosts
    // are NOT dropped here. This keeps high-quality model figures from
    // SlideShare, conference posters, ResearchGate blog mirrors, lecture
    // PDFs, etc. that Google routinely surfaces above raw journal hits.
    scored.sort((a, b) => b._score - a._score);
    const ranked = scored;

    // ---- Stage 6: multi-class AI relevance gate --------------------------
    // Send top ~40 candidates' titles to GPT, which CLASSIFIES each as
    // conceptual_model | sem_path | framework | other (drop). Returns a
    // category per kept image so the UI can display a "✓ SEM 路径图" badge.
    // Falls back to the un-gated list if the AI call fails entirely.
    let finalList: typeof ranked = ranked;
    if (!rawMode && ranked.length > 0) {
      const candidates = ranked.slice(0, 40);
      const keep = await aiRelevanceFilter(
        rawQuery,
        expandedQueries,
        candidates.map((c) => ({ title: c.title, sourceDomain: c.sourceDomain })),
        sessionCtx,
        { sessionId: params.data.id, userId: req.user?.id ?? null },
      );
      if (keep && keep.length > 0) {
        const keepMap = new Map(keep.map((k) => [k.i, { category: k.category, why: k.why }]));
        // Tag every kept candidate with verified=true. Items the AI didn't
        // approve get verified=false so the UI can render an unobtrusive
        // "未验证" badge — the user instantly knows whether GPT actually
        // looked at this image and decided it was on-topic, vs. it being a
        // backfill we showed only because the grid would otherwise be empty.
        const approved = candidates
          .map((c, i) => {
            const hit = keepMap.get(i);
            return hit
              ? { ...c, category: hit.category, why: hit.why, verified: true as boolean }
              : { ...c, category: undefined as ImageCategory | undefined, why: undefined as string | undefined, verified: false as boolean };
          })
          .filter((c) => c.category !== undefined);
        if (approved.length < count) {
          const need = count - approved.length;
          const fallbacks = candidates
            .filter((_, i) => !keepMap.has(i))
            .slice(0, need)
            .map((c) => ({ ...c, category: undefined as ImageCategory | undefined, why: undefined as string | undefined, verified: false as boolean }));
          finalList = [...approved, ...fallbacks];
        } else {
          finalList = approved;
        }
      }
    }

    const results = finalList.slice(0, count).map(({ _score, _matched, _query, _academic, ...rest }) => rest);

    // hasMore heuristic: if upstream returned at least the requested count
    // worth of distinct items, more pages probably exist.
    const hasMore = page < 10 && deduped.length >= count;

    req.log.info({
      rawQuery, expanded: expandedQueries.length, raw: allItems.length,
      droppedHard, deduped: deduped.length, kept: results.length,
      categories: results.map((r) => (r as any).category).filter(Boolean),
    }, "image search complete");

    res.json({
      query: expandedQueries.join(" | "),
      rawQuery,
      expandedQueries,
      provider,
      page,
      hasMore,
      results,
    });
  } catch (err) {
    req.log.error({ err }, "Image search threw");
    res.status(502).json({ error: "Image search failed" });
  }
});

// ---------------------------------------------------------------------------
// Paper search with model-figure detection.
//
// Strategy:
//  1. AI-expand the user's (often Chinese / rough) topic into 2-3 precise
//     English academic queries (reuses expandQueriesWithAI).
//  2. Run OpenAlex `title_and_abstract.search` for each query in parallel,
//     merge & dedupe by externalId, sort by citation count.
//  3. AI-classify each paper's abstract: how likely is it to contain a
//     conceptual / SEM / hypothesized-relationships FIGURE? Returns
//     "high" | "medium" | "low" + a one-sentence reason.
// ---------------------------------------------------------------------------
type OpenAlexLite = {
  id: string;
  title: string;
  authorships?: Array<{ author?: { display_name?: string } }>;
  publication_year?: number | null;
  cited_by_count?: number | null;
  primary_location?: {
    landing_page_url?: string;
    pdf_url?: string | null;
    source?: { display_name?: string };
  } | null;
  abstract_inverted_index?: Record<string, number[]> | null;
};

function reconstructAbstractLite(inv: Record<string, number[]> | null | undefined): string | null {
  if (!inv || Object.keys(inv).length === 0) return null;
  const positions: [number, string][] = [];
  for (const [w, idxs] of Object.entries(inv)) for (const i of idxs) positions.push([i, w]);
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map(([, w]) => w).join(" ");
}

async function fetchPapersFromOpenAlex(query: string, perPage: number, page: number = 1): Promise<OpenAlexLite[]> {
  const safe = query.replace(/["',:|]+/g, " ").replace(/\s+/g, " ").trim();
  if (!safe) return [];
  const url = new URL("https://api.openalex.org/works");
  // Only real research papers — exclude books, book-chapters (which include
  // index/contents/front-matter "papers"), datasets, editorials, errata,
  // letters, paratext, peer-reviews, reference-entries, etc. that are
  // pollution for "find a paper that contains a model figure".
  url.searchParams.set(
    "filter",
    `title_and_abstract.search:${safe},is_paratext:false,has_abstract:true,type:article|review|preprint`,
  );
  url.searchParams.set("per-page", String(Math.min(perPage, 50)));
  url.searchParams.set("sort", "relevance_score:desc");
  if (page > 1) url.searchParams.set("page", String(page));
  url.searchParams.set(
    "select",
    "id,title,authorships,publication_year,cited_by_count,primary_location,abstract_inverted_index",
  );
  url.searchParams.set("mailto", "research@researchmodelbuilder.app");
  const r = await fetch(url.toString(), {
    headers: { "User-Agent": "ResearchModelBuilder/1.0 (mailto:research@researchmodelbuilder.app)" },
  });
  if (!r.ok) return [];
  const data = (await r.json()) as { results?: OpenAlexLite[] };
  return data.results ?? [];
}

// Cheap title-based junk filter — drops things that slipped past the
// type filter: book index pages, tables of contents, front/back matter,
// editorials, acknowledgments, etc. Case-insensitive exact match on a
// short whitelist of well-known non-paper titles, plus a "too short to be
// a real paper title" guard.
const JUNK_TITLE_RX = /^(index|contents|table of contents|references|bibliography|front matter|back matter|cover|cover page|about the authors?|editorial|acknowledg(e)?ments?|preface|foreword|copyright page|title page|errata|erratum|notes? on contributors)\.?$/i;
function isJunkPaper(w: OpenAlexLite): boolean {
  const title = (w.title ?? "").trim();
  if (title.length < 8) return true; // "Index", "Notes" — way too short
  if (JUNK_TITLE_RX.test(title)) return true;
  return false;
}

type ModelFigureRating = { likelihood: "high" | "medium" | "low"; reason: string };

async function aiRateModelFigureLikelihood(
  rawQuery: string,
  papers: Array<{ title: string; abstract: string | null }>,
  usageMeta: { sessionId: number | null; userId: string | null } = { sessionId: null, userId: null },
): Promise<Array<ModelFigureRating | null>> {
  if (papers.length === 0) return [];
  try {
    const list = papers
      .map((p, i) => {
        const abs = (p.abstract ?? "").slice(0, 700).replace(/\s+/g, " ");
        return `${i}. TITLE: ${p.title.slice(0, 200)}\n   ABSTRACT: ${abs || "(no abstract)"}`;
      })
      .join("\n\n");
    const completion: any = await openai.chat.completions.create({
      // Cost optimisation: paper screening is a 3-class likelihood ranking
      // (high/medium/low) over titles+abstracts. gpt-5-mini is plenty for the
      // signal-vs-negative-signal heuristics already enumerated in the prompt;
      // gpt-5.4's deeper reasoning yields no measurable accuracy gain here.
      model: "gpt-5-mini",
      max_completion_tokens: 1200,
      messages: [
        {
          role: "system",
          content: `You are screening academic papers to predict which ones likely contain a CONCEPTUAL MODEL / THEORETICAL FRAMEWORK / SEM / hypothesized-relationships FIGURE inside (the kind of "boxes-and-arrows" diagram researchers want to look at).

Strong signals (→ "high"):
- abstract proposes / tests / develops a "model", "framework", "theoretical model", "conceptual model"
- abstract uses SEM / PLS-SEM / structural equation modeling / path analysis / hypothesis H1...Hn
- abstract uses "mediating role", "moderating role", "antecedents", "we propose", "we develop"

Weak signals (→ "medium"):
- empirical study testing relationships between specific constructs but no explicit "model" wording
- meta-analysis / review that may or may not have a summary framework figure

Negative signals (→ "low"):
- pure qualitative / case study with no quantitative model
- methodology / scale validation paper
- experimental study with no theoretical framework figure
- literature review with no synthesis diagram
- non-research content: book index, table of contents, editorial, front/back matter, acknowledgments, references list, cover page
- the "abstract" looks like a list of index entries, page numbers, or chapter summaries instead of a research abstract
- the title is just "Index", "Contents", "References" or similar book paratext

Return ONLY JSON: {"ratings":[{"i":0,"likelihood":"high|medium|low","reason":"≤20-word Chinese explanation"}, ...]} — one entry per input paper, indices 0..N-1.`,
        },
        {
          role: "user",
          content: `User's research topic: ${rawQuery}\n\nPapers:\n${list}`,
        },
      ],
    });
    const txt = completion.choices[0]?.message?.content ?? "";
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return papers.map(() => null);
    const parsed = JSON.parse(m[0]) as { ratings?: Array<{ i?: number; likelihood?: string; reason?: string }> };
    if (!Array.isArray(parsed.ratings)) return papers.map(() => null);
    const out: Array<ModelFigureRating | null> = papers.map(() => null);
    for (const r of parsed.ratings) {
      if (typeof r.i !== "number" || r.i < 0 || r.i >= papers.length) continue;
      const lk = r.likelihood;
      if (lk !== "high" && lk !== "medium" && lk !== "low") continue;
      out[r.i] = { likelihood: lk, reason: typeof r.reason === "string" ? r.reason.slice(0, 200) : "" };
    }
    logAiUsageFromOpenAI(completion, { route: "model-assistant/screen-papers", sessionId: usageMeta.sessionId, userId: usageMeta.userId });
    return out;
  } catch {
    return papers.map(() => null);
  }
}

router.post("/sessions/:id/model-assistant/search-model-papers", async (req, res) => {
  const params = ChatModelAssistantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const rawQuery = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!rawQuery) {
    res.status(400).json({ error: "Missing query" });
    return;
  }
  const count = Math.min(20, Math.max(1, Number(req.body?.count) || 10));
  const page = Math.min(10, Math.max(1, Number(req.body?.page) || 1));
  const rawMode = req.body?.raw === true;

  try {
    // ---- Stage 1: expanded queries (reuse image-search expansion) -------
    let expandedQueries: string[] = [];
    if (rawMode) {
      expandedQueries = [rawQuery];
    } else {
      const aiQueries = await expandQueriesWithAI(rawQuery, await loadSessionImageCtx(params.data.id), { sessionId: params.data.id, userId: req.user?.id ?? null });
      expandedQueries = [...aiQueries, rawQuery];
      const seen = new Set<string>();
      expandedQueries = expandedQueries.filter((q) => {
        const k = q.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (expandedQueries.length === 0) expandedQueries = [rawQuery];
    }

    // ---- Stage 2: parallel OpenAlex queries ------------------------------
    const perQuery = 25;
    const settled = await Promise.allSettled(
      expandedQueries.map((q) => fetchPapersFromOpenAlex(q, perQuery, page)),
    );
    const all = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
    if (all.length === 0) {
      // For page 1, treat as a real failure so the user sees "search failed".
      // For page > 1, this just means we've run off the end of OpenAlex's
      // result set — return an empty page gracefully so the frontend can
      // show its "no more results" state instead of an error toast.
      if (page > 1) {
        res.json({
          query: expandedQueries.join(" | "),
          rawQuery,
          expandedQueries,
          page,
          hasMore: false,
          papers: [],
        });
        return;
      }
      res.status(502).json({ error: "OpenAlex returned no results" });
      return;
    }

    // Dedupe by externalId; prefer first occurrence (earlier queries weighted higher)
    const byId = new Map<string, OpenAlexLite>();
    for (const w of all) {
      if (!w.id) continue;
      if (isJunkPaper(w)) continue; // drop book index pages, ToC, front matter, etc.
      if (!byId.has(w.id)) byId.set(w.id, w);
    }
    const deduped = Array.from(byId.values());

    // If after junk-filtering everything is gone, treat the same way as
    // "OpenAlex returned no results" — graceful end-of-pagination on page>1,
    // soft error on page 1.
    if (deduped.length === 0) {
      if (page > 1) {
        res.json({
          query: expandedQueries.join(" | "),
          rawQuery,
          expandedQueries,
          page,
          hasMore: false,
          papers: [],
        });
        return;
      }
      res.status(502).json({ error: "OpenAlex returned no usable results" });
      return;
    }

    // Sort by citation count desc as a quality prior, then trim to a working
    // set we'll send to the AI rater. Keep up to 2x the requested count so
    // we can still hit `count` after low-likelihood papers are filtered out.
    deduped.sort((a, b) => (b.cited_by_count ?? 0) - (a.cited_by_count ?? 0));
    const workingSet = deduped.slice(0, Math.min(20, count * 2));

    // ---- Stage 3: AI rate model-figure likelihood -----------------------
    const ratingInput = workingSet.map((w) => ({
      title: w.title ?? "",
      abstract: reconstructAbstractLite(w.abstract_inverted_index),
    }));
    const ratings = await aiRateModelFigureLikelihood(rawQuery, ratingInput, { sessionId: params.data.id, userId: req.user?.id ?? null });

    // Build response. Sort by likelihood (high → medium → low → unrated),
    // breaking ties by citation count.
    const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const enriched = workingSet.map((w, i) => {
      const externalId = w.id.replace("https://openalex.org/", "");
      const authors = (w.authorships ?? [])
        .map((a) => a.author?.display_name)
        .filter((s): s is string => !!s);
      const venue = w.primary_location?.source?.display_name ?? null;
      const openAccessUrl = w.primary_location?.pdf_url ?? null;
      const url = w.primary_location?.landing_page_url ?? `https://openalex.org/${externalId}`;
      const abstract = reconstructAbstractLite(w.abstract_inverted_index);
      const r = ratings[i];
      return {
        externalId,
        title: w.title ?? "",
        abstract,
        authors,
        year: w.publication_year ?? null,
        venue,
        citationCount: w.cited_by_count ?? null,
        openAccessUrl,
        url,
        modelFigureLikelihood: (r?.likelihood ?? "medium") as "high" | "medium" | "low",
        modelFigureReason: r?.reason ?? "",
      };
    });

    enriched.sort((a, b) => {
      const ra = rank[a.modelFigureLikelihood] ?? 99;
      const rb = rank[b.modelFigureLikelihood] ?? 99;
      if (ra !== rb) return ra - rb;
      return (b.citationCount ?? 0) - (a.citationCount ?? 0);
    });

    // Hide "low likelihood" results — the user explicitly asked for papers
    // that likely contain a research-model figure, so showing irrelevant
    // ones (textbook chapters, scale-validation papers, etc.) is noise.
    // Only fall back to "low" results if everything we have is "low",
    // so the user always sees *something* and can broaden the query.
    const nonLow = enriched.filter((p) => p.modelFigureLikelihood !== "low");
    const finalList = nonLow.length > 0 ? nonLow : enriched;
    const hasMore = page < 10 && deduped.length >= count;

    res.json({
      query: expandedQueries.join(" | "),
      rawQuery,
      expandedQueries,
      page,
      hasMore,
      papers: finalList.slice(0, count),
    });
  } catch (err) {
    req.log.error({ err }, "Paper search threw");
    res.status(502).json({ error: "Paper search failed" });
  }
});

// =====================================================================
// Image blocklist (per-session). Powers the ✕ button on image cards so
// the user can dismiss noisy hits and never see them again in this session.
// =====================================================================

// Normalize a URL for blocklist lookup so two cosmetically-different URLs
// pointing at the SAME image are treated as one block. Without this the user
// could see the same hit re-appear with a tracking parameter or a trailing
// slash variant and have to dismiss it again.
function normalizeBlocklistUrl(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return s;
  try {
    const u = new URL(s);
    u.hash = "";
    // Drop common tracking / cache-buster params.
    const dropPrefixes = ["utm_", "fbclid", "gclid", "mc_eid", "mc_cid", "_ga", "_hsenc", "_hsmi", "ref"];
    const drop: string[] = [];
    u.searchParams.forEach((_v, k) => {
      const lk = k.toLowerCase();
      if (dropPrefixes.some((p) => lk === p || lk.startsWith(p))) drop.push(k);
    });
    drop.forEach((k) => u.searchParams.delete(k));
    // Sort remaining params for determinism.
    const sorted = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    const sp = new URLSearchParams();
    for (const [k, v] of sorted) sp.append(k, v);
    u.search = sp.toString();
    // Trim a single trailing slash off the path so "/foo/" === "/foo".
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return s;
  }
}

router.get("/sessions/:id/image-blocklist", async (req, res): Promise<void> => {
  const params = ChatModelAssistantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const rows = await db
    .select()
    .from(imageBlocklistTable)
    .where(eq(imageBlocklistTable.sessionId, params.data.id))
    .orderBy(desc(imageBlocklistTable.createdAt));
  res.json(rows.map((r) => ({
    id: r.id, sessionId: r.sessionId, sourceUrl: r.sourceUrl,
    sourceDomain: r.sourceDomain, title: r.title, reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  })));
});

router.delete("/sessions/:id/image-blocklist/:entryId", async (req, res): Promise<void> => {
  const params = ChatModelAssistantParams.safeParse({ id: req.params.id });
  if (!params.success) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const entryId = parseInt(req.params.entryId, 10);
  if (!Number.isFinite(entryId)) {
    res.status(400).json({ error: "Invalid entryId" });
    return;
  }
  const result = await db
    .delete(imageBlocklistTable)
    .where(and(
      eq(imageBlocklistTable.sessionId, params.data.id),
      eq(imageBlocklistTable.id, entryId),
    ))
    .returning({ id: imageBlocklistTable.id });
  if (result.length === 0) {
    res.status(404).json({ error: "Blocklist entry not found" });
    return;
  }
  res.json({ ok: true });
});

router.post("/sessions/:id/image-blocklist", async (req, res) => {
  const params = ChatModelAssistantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const rawUrl = typeof req.body?.sourceUrl === "string" ? req.body.sourceUrl.trim() : "";
  const sourceUrl = normalizeBlocklistUrl(rawUrl);
  const sourceDomain = typeof req.body?.sourceDomain === "string" ? req.body.sourceDomain.trim() : "";
  if (!sourceUrl || !sourceDomain) {
    res.status(400).json({ error: "Missing sourceUrl or sourceDomain" });
    return;
  }
  const title = typeof req.body?.title === "string" ? req.body.title.slice(0, 500) : null;
  const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 200) : null;
  const insertResult = await db
    .insert(imageBlocklistTable)
    .values({ sessionId: params.data.id, sourceUrl, sourceDomain, title, reason })
    .onConflictDoNothing({ target: [imageBlocklistTable.sessionId, imageBlocklistTable.sourceUrl] })
    .returning();
  let row = insertResult[0];
  let created = true;
  if (!row) {
    created = false;
    const [existing] = await db
      .select()
      .from(imageBlocklistTable)
      .where(and(eq(imageBlocklistTable.sessionId, params.data.id), eq(imageBlocklistTable.sourceUrl, sourceUrl)))
      .limit(1);
    if (!existing) {
      res.status(500).json({ error: "Failed to persist blocklist entry" });
      return;
    }
    row = existing;
  }
  res.status(created ? 201 : 200).json({
    id: row.id, sessionId: row.sessionId, sourceUrl: row.sourceUrl,
    sourceDomain: row.sourceDomain, title: row.title, reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  });
});

// ----------------------------------------------------------------------------
// Distill nudge queries
// ----------------------------------------------------------------------------
// Powers the chat opening nudge: takes the session's topic + variable names
// and asks gpt-5-mini to return 2-3 SHORT English search queries (4-8 words)
// with friendly Chinese button labels. Replaces the old client-side
// `${topic} conceptual model` template that produced 30+ word queries when
// users named their session with the full thesis title.
//
// Anti-abuse + determinism: results cached in-process for 30 minutes keyed by
// (sessionId, topic, top-12 var names). Server enforces word-count contract
// AFTER the AI returns — ungrounded model output gets truncated to the first
// 8 lowercase words, guaranteeing the long-query bug cannot reappear even if
// the AI ignores its instructions.
type NudgeCacheEntry = { ts: number; queries: Array<{ label: string; query: string }> };
const nudgeCache = new Map<string, NudgeCacheEntry>();
const NUDGE_CACHE_TTL_MS = 30 * 60 * 1000;
const NUDGE_CACHE_MAX = 500;
function nudgeCacheKey(sessionId: number, ctx: { topic: string | null; variableNames: string[] }) {
  return `${sessionId}|${ctx.topic ?? ""}|${ctx.variableNames.slice(0, 12).join(",")}`;
}
// Hard contract enforcement: lowercase, strip quotes/punctuation noise, cap
// to 8 words, drop banned padding terms. Returns null if compaction fails.
function compactDistilledQuery(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const banned = new Set(["research", "figure", "diagram", "study", "paper"]);
  const words = raw
    .toLowerCase()
    .replace(/["'`]/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && !banned.has(w));
  if (words.length < 2) return null;
  return words.slice(0, 8).join(" ");
}
router.post("/sessions/:id/model-assistant/distill-nudge-queries", async (req, res) => {
  const params = ChatModelAssistantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const ctx = await loadSessionImageCtx(params.data.id);
  if (!ctx || !ctx.topic) {
    res.json({ queries: [] });
    return;
  }
  // Cache lookup BEFORE any AI spend.
  const cacheKey = nudgeCacheKey(params.data.id, ctx);
  const now = Date.now();
  const cached = nudgeCache.get(cacheKey);
  if (cached && now - cached.ts < NUDGE_CACHE_TTL_MS) {
    res.json({ queries: cached.queries, cached: true });
    return;
  }
  try {
    const completion: any = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 400,
      messages: [
        {
          role: "system",
          content: `You distill a research session into 2-3 SHORT search angles for finding conceptual model / theoretical framework figures on Google Images.
Output ONLY: {"queries":[{"label":"...","query":"..."}, ...]}
Rules:
- 2 to 3 items, each a DIFFERENT angle (e.g. one core construct relationship, one broader theory family, one method-specific figure type).
- "query": 4-8 words, lowercase English, canonical academic terminology, NO quotes, NO site: filters, NO words like "research"/"figure"/"diagram".
- "label": Chinese (zh-CN) button label ≤14 characters, plain text, NO emojis, NO punctuation; should hint at what the user will see (e.g. "概念模型图" / "SOR 框架图" / "中介模型示例").
- Translate Chinese constructs (直播/主播/冲动消费/信任) to standard English (live streaming, streamer, impulse buying, trust).
- At least one query MUST combine the topic with the user's actual variables when variables are listed.`,
        },
        {
          role: "user",
          content: `Topic: ${ctx.topic}
Variables: ${ctx.variableNames.slice(0, 12).join(", ") || "(none)"}
Sample paper titles: ${ctx.paperTitles.slice(0, 4).join(" | ") || "(none)"}`,
        },
      ],
    });
    logAiUsageFromOpenAI(completion, { route: "model-assistant/distill-nudge-queries", sessionId: params.data.id, userId: req.user?.id ?? null });
    const txt = completion.choices[0]?.message?.content ?? "";
    const match = txt.match(/\{[\s\S]*\}/);
    if (!match) { res.json({ queries: [] }); return; }
    let parsed: { queries?: unknown };
    try { parsed = JSON.parse(match[0]); } catch { res.json({ queries: [] }); return; }
    if (!Array.isArray(parsed.queries)) { res.json({ queries: [] }); return; }
    const out: Array<{ label: string; query: string }> = [];
    const seenQueries = new Set<string>();
    for (const item of parsed.queries) {
      if (!item || typeof item !== "object") continue;
      const label = typeof (item as any).label === "string" ? (item as any).label.trim().slice(0, 14) : "";
      const rawQuery = typeof (item as any).query === "string" ? (item as any).query : "";
      const query = compactDistilledQuery(rawQuery);
      if (label.length === 0 || !query) continue;
      if (seenQueries.has(query)) continue;
      seenQueries.add(query);
      out.push({ label, query });
      if (out.length >= 3) break;
    }
    // Persist to cache (even empty arrays — avoids hammering the model with
    // retries on a topic it can't usefully distill).
    if (nudgeCache.size >= NUDGE_CACHE_MAX) {
      // Cheap eviction: drop oldest entry.
      const first = nudgeCache.keys().next().value;
      if (first !== undefined) nudgeCache.delete(first);
    }
    nudgeCache.set(cacheKey, { ts: now, queries: out });
    res.json({ queries: out, cached: false });
  } catch (err) {
    req.log.warn({ err }, "distill-nudge-queries failed");
    res.json({ queries: [] });
  }
});

export default router;

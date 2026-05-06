import { Router, type IRouter } from "express";
import { eq, desc, isNotNull, sql } from "drizzle-orm";
import {
  db,
  researchModelsTable,
  variablesTable,
  papersTable,
  generationFeedbackTable,
  paperHypothesesTable,
  modelVersionsTable,
} from "@workspace/db";
import { findEvidenceForModel, importWebPaper, makeEdgeKey, type EdgeInput } from "../lib/evidence-matching.js";
import {
  GenerateModelsParams,
  GenerateModelsBody,
  ListSessionModelsParams,
  GetModelParams,
  SelectModelParams,
  UpdateModelParams,
  UpdateModelBody,
  GetSessionLearningStatsParams,
  GenerateModelLiteratureReviewBody,
} from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import {
  THEORY_BACKBONES,
  backbonesAsPromptBlock,
  operatorsAsPromptBlock,
  recommendBackbones,
  layerIndex,
} from "../lib/theoryTemplates.js";

const router: IRouter = Router();

interface ModelNode {
  variableId: number;
  variableName: string;
  type: string;
  paperId: number;
  paperTitle: string;
  paperAuthors: string[];
  paperYear: number | null;
}

interface ModelEdge {
  fromVariableId: number;
  toVariableId: number;
  fromVariableName: string;
  toVariableName: string;
  relationship: string;
  evidencePaperId: number;
  evidencePaperTitle: string;
  evidencePaperAuthors: string[];
  evidencePaperYear: number | null;
  evidenceCitationText: string;
  // Optional provenance fields (P2 — populated by the new generation prompt)
  evidenceHypothesisId?: string | null;     // e.g. "H2a" — links back to paper_hypotheses row
  effectSize?: string | null;               // e.g. "β=.34, p<.001"
  evidenceLocation?: string | null;         // e.g. "p. 412" or "Section 3.2"
  moderatorJustification?: string | null;   // REQUIRED for relationship = "moderates"
}

// New typed-graph form of a paper's own research model (cached on papers.researchModel).
interface PaperGraphNode {
  name: string;                             // canonical variable name as it appears in the paper
  role: "independent" | "mediator" | "moderator" | "dependent" | "outcome" | "antecedent";
}
interface PaperGraphEdge {
  from: string;                             // node name
  to: string;                               // node name
  sign: "positive" | "negative" | "moderates" | "mediates" | "unspecified";
  hypothesisId?: string;                    // e.g., "H1", "H2a"
  evidence: string;                         // verbatim sentence from the paper
}
interface PaperResearchModel {
  summary: string;
  backboneGuess?: string;                   // matched theory backbone id (e.g., "SOR", "TAM")
  graph: { nodes: PaperGraphNode[]; edges: PaperGraphEdge[] };
  // Legacy fields kept for backwards-compat with previously cached extractions.
  coreVariables?: string[];
  hypotheses?: string[];
}

interface PartialPassMeta {
  allowPartial: boolean;
  basedOnPaperIds: number[];
  missingPaperIds: number[];
  missingPapers: Array<{ id: number; title: string }>;
  // Set on rescued models (zero hard-pass case): structural warnings that
  // were downgraded from rejection so the user still gets something to look at.
  qualityWarnings?: string[];
}

function formatModel(model: typeof researchModelsTable.$inferSelect) {
  return {
    id: model.id,
    sessionId: model.sessionId,
    name: model.name,
    description: model.description,
    rationale: model.rationale,
    selected: model.selected === "true",
    nodes: model.nodes as ModelNode[],
    edges: model.edges as ModelEdge[],
    partialPassMeta: (model.partialPassMeta as PartialPassMeta | null) ?? null,
    createdAt: model.createdAt.toISOString(),
  };
}

// Lazily extract each paper's OWN research model as a TYPED CAUSAL GRAPH.
// Cache on papers.researchModel and reuse on every subsequent generation.
// Re-extracts if the cached value is in the legacy shape (no "graph" field).
async function extractPaperResearchModel(
  paper: typeof papersTable.$inferSelect,
  reqLog: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<PaperResearchModel | null> {
  const cached = paper.researchModel as PaperResearchModel | null;
  if (
    cached &&
    typeof cached.summary === "string" &&
    cached.graph &&
    Array.isArray(cached.graph.nodes) &&
    Array.isArray(cached.graph.edges) &&
    cached.graph.nodes.every((n) => n && typeof n.name === "string" && typeof n.role === "string") &&
    cached.graph.edges.every((e) => e && typeof e.from === "string" && typeof e.to === "string" && typeof e.evidence === "string")
  ) {
    return cached;
  }

  const text = paper.fullText && paper.fullText.length > 200 ? paper.fullText : paper.abstract;
  if (!text || text.length < 80) return null;

  const truncated = text.slice(0, 9000).replace(/\s+/g, " ");
  const backboneNames = THEORY_BACKBONES.map((b) => b.id).join(", ");

  const prompt = `You are a research-methods analyst. Read this academic paper and extract its OWN research model AS A TYPED CAUSAL GRAPH in strict JSON.

Paper title: ${paper.title}
Authors: ${(paper.authors ?? []).slice(0, 3).join(", ")}
Year: ${paper.year ?? "n.d."}

Text:
${truncated}

Return ONLY this JSON (no markdown, no commentary):
{
  "summary": "1-3 sentences explaining what predicts what, through what.",
  "backboneGuess": "<one of: ${backboneNames}, or empty string if none fits>",
  "graph": {
    "nodes": [
      { "name": "<variable name as written in the paper>", "role": "independent|mediator|moderator|dependent" }
    ],
    "edges": [
      { "from": "<node name>", "to": "<node name>", "sign": "positive|negative|moderates|mediates", "hypothesisId": "H1", "evidence": "<verbatim sentence from the paper stating this hypothesis or finding>" }
    ]
  },
  "coreVariables": ["..."],
  "hypotheses": ["H1: ...", "H2: ..."]
}

Strict rules:
- "graph.nodes" lists ONLY variables that participate in the model (not every concept mentioned).
- "graph.edges" must each correspond to a stated hypothesis (H1/H2/...) or an explicit causal claim.
- "from" and "to" must EXACTLY match a "name" in "graph.nodes".
- Direction matters: "from" is the cause/antecedent, "to" is the consequence.
- For moderator edges: "from" is the moderator variable, "to" is the variable being moderated; sign = "moderates".
- "evidence" MUST be a verbatim sentence copied from the paper text. If no such sentence exists, omit that edge.
- If the paper has no clearly stated research model, return summary="No explicit research model.", backboneGuess="", and empty arrays.
- Do not invent variables.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 3000,
      messages: [{ role: "user", content: prompt }],
    });
    const content = completion.choices[0]?.message?.content ?? "{}";
    const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned) as PaperResearchModel;
    if (typeof parsed.summary !== "string") return null;
    if (!parsed.graph || !Array.isArray(parsed.graph.nodes) || !Array.isArray(parsed.graph.edges)) {
      parsed.graph = { nodes: [], edges: [] };
    }
    parsed.graph.nodes = parsed.graph.nodes.slice(0, 14);
    parsed.graph.edges = parsed.graph.edges.slice(0, 16);
    parsed.coreVariables = Array.isArray(parsed.coreVariables) ? parsed.coreVariables.slice(0, 12) : parsed.graph.nodes.map((n) => n.name);
    parsed.hypotheses = Array.isArray(parsed.hypotheses) ? parsed.hypotheses.slice(0, 10) : [];
    await db
      .update(papersTable)
      .set({ researchModel: parsed })
      .where(eq(papersTable.id, paper.id));
    return parsed;
  } catch (err) {
    reqLog.warn({ err, paperId: paper.id }, "Failed to extract per-paper research model");
    return null;
  }
}

function renderPaperGraph(tag: string, paperTitle: string, model: PaperResearchModel): string {
  const nodeLines = model.graph.nodes
    .filter((n) => n && typeof n.name === "string")
    .map((n) => `      • [${n.role ?? "?"}] ${n.name}`)
    .join("\n");
  const edgeLines = model.graph.edges
    .filter((e) => e && typeof e.from === "string" && typeof e.to === "string")
    .map((e) => {
      const sign = e.sign === "positive" ? "(+)" : e.sign === "negative" ? "(-)" : e.sign === "moderates" ? "(mod)" : e.sign === "mediates" ? "(med)" : "(?)";
      const hyp = e.hypothesisId ? ` [${e.hypothesisId}]` : "";
      const evidence = typeof e.evidence === "string" ? e.evidence.slice(0, 160) : "";
      return `      • ${e.from}  --${sign}-->  ${e.to}${hyp}    «${evidence}»`;
    })
    .join("\n");
  const backbone = model.backboneGuess ? `\n    Backbone match: ${model.backboneGuess}` : "";
  return `${tag} ORIGINAL MODEL — ${paperTitle}
    Summary: ${model.summary}${backbone}
    Nodes:
${nodeLines || "      (none)"}
    Edges (with sign and verbatim evidence):
${edgeLines || "      (none)"}`;
}

router.post("/sessions/:id/models/generate", async (req, res): Promise<void> => {
  const params = GenerateModelsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const bodyParse = GenerateModelsBody.safeParse(req.body ?? {});
  const userPrompt = bodyParse.success ? (bodyParse.data.userPrompt ?? "").trim() : "";
  const numModels = bodyParse.success && bodyParse.data.numModels ? bodyParse.data.numModels : 3;
  const focusVariableIds = bodyParse.success && bodyParse.data.focusVariableIds ? bodyParse.data.focusVariableIds : [];
  const allowPartial = bodyParse.success && bodyParse.data.allowPartial === true;

  const sessionId = params.data.id;

  const variables = await db
    .select()
    .from(variablesTable)
    .where(eq(variablesTable.sessionId, sessionId));

  if (variables.length < 2) {
    res.status(400).json({ error: "Need at least 2 extracted variables to generate models. Please extract variables from papers first." });
    return;
  }

  const papers = await db.select().from(papersTable).where(eq(papersTable.sessionId, sessionId));
  const paperMap = new Map(papers.map((p) => [p.id, p]));
  const papersWithVars = papers.filter((p) => variables.some((v) => v.paperId === p.id));

  // Server-side defense-in-depth for the pending-papers guard. The client
  // already disables the Generate button when papers are unextracted, but a
  // direct API call (or stale UI) could bypass it. When `allowPartial` is
  // true the user has explicitly acknowledged the limitation in a confirm
  // dialog, so we proceed and persist the missing-paper list onto each
  // generated model row.
  const missingPapers = papers.filter((p) => !p.extracted);
  if (missingPapers.length > 0 && !allowPartial) {
    res.status(422).json({
      error: `还有 ${missingPapers.length} 篇论文未提取变量，生成模型会遗漏它们的证据。请先把所有论文都提取完再生成，或者在前端确认"基于部分论文生成"。`,
      missingPaperIds: missingPapers.map((p) => p.id),
    });
    return;
  }
  const partialPassMeta: PartialPassMeta | null = allowPartial && missingPapers.length > 0
    ? {
        allowPartial: true,
        basedOnPaperIds: papersWithVars.map((p) => p.id),
        missingPaperIds: missingPapers.map((p) => p.id),
        missingPapers: missingPapers.map((p) => ({ id: p.id, title: p.title })),
      }
    : null;

  // Stage 1: extract each paper's OWN research model as a typed causal graph (cached).
  const perPaperModels = await Promise.all(
    papersWithVars.map(async (p) => ({ paper: p, model: await extractPaperResearchModel(p, req.log) })),
  );

  // Build paper tags for grounding.
  const paperRefs = papersWithVars.map((p, idx) => {
    const tag = `P${idx + 1}`;
    const author = (p.authors ?? [])[0] ?? "Unknown";
    return { id: p.id, tag, short: `${tag} = ${author}${p.year ? ` (${p.year})` : ""} — ${p.title}` };
  });
  const paperTagById = new Map(paperRefs.map((r) => [r.id, r.tag]));

  const variableList = variables.map((v) => {
    const paper = paperMap.get(v.paperId);
    const tag = paperTagById.get(v.paperId) ?? "?";
    const focus = focusVariableIds.includes(v.id) ? " [USER-PRIORITY]" : "";
    const canonical = v.canonicalConstructId ? ` | Canonical: "${v.canonicalConstructId}"` : "";
    const layer = v.constructLayer ? ` | Layer: ${v.constructLayer}` : "";
    return `- ID:${v.id}${focus} | Name: "${v.name}" | Type: ${v.type}${canonical}${layer} | Source: ${tag} ${paper?.title} (${(paper?.authors ?? []).slice(0, 2).join(", ")}, ${paper?.year ?? "n.d."}) | Definition: ${v.definition} | Citation: "${v.citationText}"`;
  }).join("\n");

  // Pull formal hypotheses from the database (extracted by /papers/:paperId/extract).
  const allHyps = await db.select().from(paperHypothesesTable).where(eq(paperHypothesesTable.sessionId, sessionId));
  const hypothesesBlock = allHyps.length > 0
    ? "\n\n================================================================\nFORMAL HYPOTHESES POOL (each edge in your output models SHOULD reference one of these by hypothesisId when applicable; copy `statement` verbatim into evidenceCitationText, `effectSize` into effectSize, `pageOrSection` into evidenceLocation):\n" +
      allHyps.map((h) => {
        const tag = paperTagById.get(h.paperId) ?? "?";
        const via = h.viaVariable ? ` via ${h.viaVariable}` : "";
        const fx = h.effectSize ? ` [${h.effectSize}]` : "";
        const loc = h.pageOrSection ? ` (${h.pageOrSection})` : "";
        return `  - [${tag}] ${h.hypothesisId}: ${h.fromVariable} -(${h.relationship})-> ${h.toVariable}${via}${fx}${loc}\n      "${h.statement.slice(0, 220)}"`;
      }).join("\n")
    : "";

  // Pick the top backbones based on the DV keywords in the variable pool — prevents
  // the AI from defaulting to the same TAM/SOR pair on every session.
  const dvKeywords = variables
    .filter((v) => v.type === "dependent")
    .map((v) => `${v.canonicalConstructId ?? v.name}`);
  const recommendedBackbones = recommendBackbones(dvKeywords, 8);
  const recommendedBackbonesBlock = recommendedBackbones.map(
    (b) => `  - ${b.id} | ${b.name} (${b.domain})\n    Shape: ${b.shape}\n    When to use: ${b.description}`,
  ).join("\n");

  // Build per-paper variable lists (fallback signal when typed-graph extraction is empty).
  const varsByPaper = new Map<number, typeof variables>();
  for (const v of variables) {
    if (!varsByPaper.has(v.paperId)) varsByPaper.set(v.paperId, []);
    varsByPaper.get(v.paperId)!.push(v);
  }

  // Stage 2 input: render each paper as either a typed causal graph, or a variable-set fallback.
  const usablePapers = papersWithVars.filter((p) => {
    const m = perPaperModels.find((x) => x.paper.id === p.id)?.model;
    const hasGraph = m && m.graph.nodes.length >= 2;
    const hasVars = (varsByPaper.get(p.id)?.length ?? 0) >= 1;
    return hasGraph || hasVars;
  });

  const originalGraphsBlock = usablePapers.map((p) => {
    const tag = paperTagById.get(p.id) ?? "?";
    const m = perPaperModels.find((x) => x.paper.id === p.id)?.model;
    if (m && m.graph.nodes.length >= 2) {
      return renderPaperGraph(tag, p.title, m);
    }
    // Fallback: list the variables we extracted for this paper.
    const vars = varsByPaper.get(p.id) ?? [];
    const summary = m?.summary ?? "(no explicit causal model extracted; using extracted variables only)";
    const lines = vars.map((v) => `      • [${v.type}] ${v.name} — ${v.definition.slice(0, 120)}`).join("\n");
    return `${tag} ORIGINAL MODEL — ${p.title}\n    Summary: ${summary}\n    Variables (no formal graph available — AI may infer relationships from definitions):\n${lines}`;
  }).join("\n\n");

  // Fail-fast: operator-based recombination needs ≥ 2 papers with usable signal.
  if (usablePapers.length < 2) {
    res.status(422).json({
      error: `Operator-based recombination needs at least 2 papers with extractable variables or research models, but only ${usablePapers.length} found. Add more papers, or extract variables first.`,
    });
    return;
  }

  // Cross-paper shared-variable map (helps AI find candidates for EXTEND / INSERT_MODERATOR).
  // Uses BOTH typed-graph nodes AND extracted variables, so it works for papers with no formal graph.
  const nameToPaperTags = new Map<string, Set<string>>();
  for (const { paper, model } of perPaperModels) {
    const tag = paperTagById.get(paper.id) ?? "?";
    if (model) {
      for (const n of model.graph.nodes) {
        const key = n.name.toLowerCase().trim();
        if (!nameToPaperTags.has(key)) nameToPaperTags.set(key, new Set());
        nameToPaperTags.get(key)!.add(tag);
      }
    }
    for (const v of varsByPaper.get(paper.id) ?? []) {
      const key = v.name.toLowerCase().trim();
      if (!nameToPaperTags.has(key)) nameToPaperTags.set(key, new Set());
      nameToPaperTags.get(key)!.add(tag);
    }
  }
  const sharedVariables = Array.from(nameToPaperTags.entries())
    .filter(([, tags]) => tags.size >= 2)
    .map(([name, tags]) => `  - "${name}" appears in ${Array.from(tags).join(", ")}`)
    .join("\n");
  const sharedBlock = sharedVariables
    ? `\n\nSHARED VARIABLES (good join points for EXTEND / SWAP_MEDIATOR / PARALLEL_MEDIATORS):\n${sharedVariables}`
    : "";

  // Learning loop.
  const pastFeedback = await db
    .select()
    .from(generationFeedbackTable)
    .where(isNotNull(generationFeedbackTable.selectedModelSnapshot))
    .orderBy(desc(generationFeedbackTable.updatedAt))
    .limit(8);

  const learnedBlock = pastFeedback.length > 0
    ? "\n\nLEARNED PREFERENCES FROM PAST USERS (use as guidance — NOT variables to copy):\n" +
      pastFeedback.map((f, i) => {
        const sel = f.selectedModelSnapshot as { name?: string; rationale?: string } | null;
        const editedNote = f.userEditedSnapshot ? " (user later edited this model)" : "";
        const promptPart = f.userPrompt ? `Prompt: "${f.userPrompt.slice(0, 200)}"` : "Prompt: (none)";
        return `  ${i + 1}. ${promptPart}\n     Chosen model${editedNote}: "${sel?.name ?? "?"}" — ${(sel?.rationale ?? "").slice(0, 240)}`;
      }).join("\n")
    : "";

  const userBlock = userPrompt
    ? `\n\nUSER REQUIREMENTS (must be followed strictly — these override default behavior):\n"""\n${userPrompt}\n"""`
    : "";
  const focusBlock = focusVariableIds.length > 0
    ? `\n\nUSER-PRIORITY variable IDs: ${focusVariableIds.join(", ")}. At least ${Math.ceil(numModels / 2)} of the ${numModels} models MUST include these.`
    : "";

  // Synthesis prompt: explicit STRUCTURAL OPERATORS + theory backbones.
  const prompt = `You are a senior researcher in academic methodology and structural equation modeling.

Your task: produce ${numModels} *novel* and theoretically coherent research model proposals by RECOMBINING the source papers' own research models below using EXPLICIT STRUCTURAL OPERATORS. Each output model MUST be the result of applying TWO chained operators (a primary then a different secondary) to AT LEAST ${userPrompt ? "TWO" : "THREE"} of the original models.

================================================================
PAPER REFERENCES (use exact tags when citing):
${paperRefs.map((r) => r.short).join("\n")}

================================================================
EACH PAPER'S OWN RESEARCH MODEL (typed causal graph extracted from the paper text — your new models MUST extend, combine, or refine these, not contradict them):

${originalGraphsBlock || "(no extractable original models)"}
${sharedBlock}

================================================================
EXTRACTED VARIABLES POOL (each variable is tagged with its source paper):
${variableList}

================================================================
CLASSICAL THEORY BACKBONES you may graft onto (operator THEORY_GRAFT) — RECOMMENDED for this session's dependent variables (try these FIRST, but you may use any of the 17 backbones):
${recommendedBackbonesBlock}

(Full backbone catalog if none of the above fit:
${backbonesAsPromptBlock()}
)
${hypothesesBlock}

================================================================
STRUCTURAL OPERATORS (each output model must use TWO of these — a primary and a different secondary — applied in sequence):
${operatorsAsPromptBlock()}
${userBlock}${focusBlock}${learnedBlock}

================================================================
HARD RULES (violations = invalid output):
1. **Operator-driven**: each model MUST start its rationale with "[OPERATOR: <PRIMARY>+<SECONDARY>] [BASE: <Pn>+<Pm>(+<Pk>...)] [BACKBONE: <id or NONE>]" so the recombination logic is auditable.
2. **Chained operators (CRITICAL)**: each model MUST apply TWO operators in sequence — a PRIMARY operator that defines the spine of the model, then a SECONDARY operator (must be different from the primary) that enriches it (e.g. INSERT_MODERATOR after EXTEND, PARALLEL_MEDIATORS after THEORY_GRAFT). Single-operator models are too weak and will be rejected.
3. **Distinct operator pairs**: across the ${numModels} models, no two models may use the same (primary, secondary) operator pair OR the same base paper set.
4. **Cross-paper synthesis**: ${userPrompt ? "The user has provided a custom prompt — honor its scope strictly. Multi-paper synthesis is still preferred when compatible with the user's intent, but a focused single-paper model that faithfully matches the user's request is acceptable." : "each model MUST include nodes from ≥ 3 DIFFERENT source papers (not 2). The whole point is multi-paper recombination — a model that only fuses 2 papers is a weak combination and will be rejected."}
5. **Respect original directions**: when an edge connects two variables that already appeared together in a paper's hypothesis, use the SAME direction and sign that paper proposed. Do not flip causality unless explicitly justified in the rationale.
6. **Citation grounding**: every "evidenceCitationText" MUST be a verbatim sentence either from the variable's "Citation" field or from the paper graph's "evidence" field above. If you cannot find such a sentence, omit that edge.
7. **Layout discipline**: order nodes Independent → Mediator → Moderator → Dependent. Never put a dependent left of an independent.
8. **Size**: 5–8 nodes and 4–8 edges per model. Smaller is too thin to count as a real recombination.
9. **Variety**: each model must have a clearly different theoretical focus (different DV, different mediator chain, or different moderator).
10. **Construct-layer ordering (CRITICAL — anti "logic jump")**: every directed edge MUST go FORWARD in the standard psychology pipeline (stimulus → cognitive → affective → intention → behavior). Backward edges (e.g. behavior → cognition) and 2-step jumps (e.g. stimulus → behavior with no cognitive/affective mediator) are PROHIBITED unless your rationale explicitly invokes a feedback-loop theory. Mediator chains MUST NOT exceed 3 hops between the IV and the DV — chains longer than 3 are diluted and will be rejected.
11. **One role per canonical construct**: a single canonicalConstruct may NOT appear with two different roles in the same model (e.g. you cannot use "trust" as both a mediator AND a moderator in the same model). This prevents nonsensical self-moderation.
12. **Moderator justification (REQUIRED when relationship = "moderates")**: every moderator edge MUST include a non-empty \`moderatorJustification\` field (≥ 1 sentence) explaining (a) WHY this variable can theoretically condition the moderated path (e.g. it's a contextual factor, individual difference, or boundary condition) and (b) WHICH paper grounds this moderating role. Without justification, the moderator edge is rejected.
13. **Hypothesis-grounded evidence (preferred)**: when an edge corresponds to a row in the FORMAL HYPOTHESES POOL above, set \`evidenceHypothesisId\` to that row's id (e.g. "H2a"), copy \`statement\` verbatim into \`evidenceCitationText\`, copy \`effectSize\` and \`pageOrSection\` if available. Edges grounded in formal hypotheses are stronger than those grounded only in narrative citations.

OUTPUT FORMAT — return ONLY a JSON array, no markdown:
[
  {
    "operator": "EXTEND|INSERT_MODERATOR|PARALLEL_MEDIATORS|SWAP_MEDIATOR|THEORY_GRAFT",
    "secondaryOperator": "EXTEND|INSERT_MODERATOR|PARALLEL_MEDIATORS|SWAP_MEDIATOR|THEORY_GRAFT (must differ from operator)",
    "basePaperTags": ["P1", "P2", "P3"],
    "backbone": "SOR|TAM|UTAUT|ELM|TPB|TRUST_TRANSFER|PARASOCIAL|FLOW|NONE",
    "name": "concise model name",
    "description": "1-2 sentences",
    "rationale": "[OPERATOR: ...] [BASE: ...] [BACKBONE: ...] then 3-5 sentences explaining HOW the operator was applied (which edge from which paper was extended/grafted/swapped/etc.) and why this is theoretically coherent",
    "nodes": [
      { "variableId": <int>, "variableName": "<name>", "type": "independent|mediator|moderator|dependent", "paperId": <int>, "paperTitle": "<title>", "paperAuthors": ["<author>"], "paperYear": <year or null> }
    ],
    "edges": [
      { "fromVariableId": <int>, "toVariableId": <int>, "fromVariableName": "<name>", "toVariableName": "<name>", "relationship": "positive|negative|moderates|mediates", "evidencePaperId": <int>, "evidencePaperTitle": "<title>", "evidencePaperAuthors": ["<author>"], "evidencePaperYear": <year or null>, "evidenceCitationText": "<verbatim sentence from the paper>", "evidenceHypothesisId": "<H1|H2a|null>", "effectSize": "<β=.34, p<.001 | null>", "evidenceLocation": "<p.412 | Section 3.2 | null>", "moderatorJustification": "<REQUIRED when relationship=moderates; null otherwise>" }
    ]
  }
]`;

  // Replit Autoscale Deployments terminate any HTTP request that takes longer
  // than 60 seconds with a 502, regardless of what the server is doing. The
  // model-generation OpenAI call can occasionally exceed this on cold starts
  // or large prompts, which surfaces to the user as a generic "generation
  // failed" with no actionable info. Abort at 55s so we still have time to
  // return a clean JSON error explaining what happened (and suggesting the
  // user retry with fewer papers or move the deployment to Reserved VM).
  let completion;
  try {
    completion = await openai.chat.completions.create(
      {
        model: "gpt-5.4",
        max_completion_tokens: 12000,
        messages: [{ role: "user", content: prompt }],
      },
      { signal: AbortSignal.timeout(55_000) },
    );
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    const aborted = e?.name === "AbortError" || e?.name === "TimeoutError" || /aborted|timeout/i.test(e?.message ?? "");
    if (aborted) {
      req.log.warn({ err, sessionId, papers: papers.length, vars: variables.length }, "AI model generation timed out (>55s)");
      res.status(504).json({
        error: "AI 生成模型时间超过 55 秒。线上部署对单次请求最长允许 60 秒。请尝试：(1) 减少本会话中的论文数量；(2) 在『自定义提示词』里写得更聚焦；(3) 把部署类型切到 Reserved VM 以解除超时限制。",
      });
      return;
    }
    throw err;
  }

  try {

    const content = completion.choices[0]?.message?.content ?? "[]";
    let generated: Array<{ operator?: string; secondaryOperator?: string; basePaperTags?: string[]; backbone?: string; name: string; description: string; rationale: string; nodes: ModelNode[]; edges: ModelEdge[] }> = [];

    try {
      const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      generated = JSON.parse(cleaned);
    } catch {
      req.log.warn({ content }, "Failed to parse AI model generation response");
      res.status(500).json({ error: "Failed to parse AI model generation result" });
      return;
    }

    // Normalize: AI sometimes confuses display tags ("P4") with DB paperIds. Re-derive the real
    // paperId of each node from its variableId (variables know their source paper authoritatively).
    const varById = new Map(variables.map((v) => [v.id, v]));
    for (const m of generated) {
      if (!Array.isArray(m?.nodes)) continue;
      for (const n of m.nodes) {
        const v = varById.get(n.variableId);
        if (v) {
          const p = paperMap.get(v.paperId);
          n.paperId = v.paperId;
          if (p) {
            n.paperTitle = p.title;
            n.paperAuthors = p.authors ?? [];
            n.paperYear = p.year ?? null;
          }
        }
      }
      if (!Array.isArray(m?.edges)) continue;
      // Build a name→variableId index from this model's own nodes (preferred) and the global pool.
      const nodeNameToVarId = new Map<string, number>();
      for (const n of m.nodes) {
        if (typeof n.variableName === "string") nodeNameToVarId.set(n.variableName.toLowerCase().trim(), n.variableId);
      }
      const globalNameToVarId = new Map<string, number>();
      for (const v of variables) globalNameToVarId.set(v.name.toLowerCase().trim(), v.id);

      for (const e of m.edges) {
        const fromKey = (e.fromVariableName ?? "").toLowerCase().trim();
        const toKey = (e.toVariableName ?? "").toLowerCase().trim();
        // If the AI's edge variableId doesn't appear in the model's own nodes, repair via name lookup.
        const nodeIdSet = new Set(m.nodes.map((n) => n.variableId));
        if (!nodeIdSet.has(e.fromVariableId)) {
          const fixed = nodeNameToVarId.get(fromKey) ?? globalNameToVarId.get(fromKey);
          if (typeof fixed === "number") e.fromVariableId = fixed;
        }
        if (!nodeIdSet.has(e.toVariableId)) {
          const fixed = nodeNameToVarId.get(toKey) ?? globalNameToVarId.get(toKey);
          if (typeof fixed === "number") e.toVariableId = fixed;
        }
        // Resolve evidencePaperId via the from-node's variableId.
        const fromVar = varById.get(e.fromVariableId);
        if (fromVar && !papers.some((p) => p.id === e.evidencePaperId)) {
          const p = paperMap.get(fromVar.paperId);
          e.evidencePaperId = fromVar.paperId;
          if (p) {
            e.evidencePaperTitle = p.title;
            e.evidencePaperAuthors = p.authors ?? [];
            e.evidencePaperYear = p.year ?? null;
          }
        }
      }
    }

    // Post-generation validation: reject models that don't actually meet the structural rules.
    const ALLOWED_OPERATORS = new Set(["EXTEND", "INSERT_MODERATOR", "PARALLEL_MEDIATORS", "SWAP_MEDIATOR", "THEORY_GRAFT"]);
    const ALLOWED_BACKBONES = new Set([...THEORY_BACKBONES.map((b) => b.id), "NONE"]);
    const validVarIds = new Set(variables.map((v) => v.id));
    const validPaperIds = new Set(papers.map((p) => p.id));

    // When the user provides a custom prompt, they may explicitly want a focused/narrow model
    // (e.g. a clean S-O-R chain on one IV). Forcing ≥3 source papers in that case rejects every
    // candidate and shows the user a generic "generation failed" with no recoverable signal.
    // Soften the cross-paper requirement (and the node-count floor) when a custom prompt is set.
    const hasCustomPrompt = userPrompt.length > 0;
    // With a custom prompt the user may legitimately want a single-paper focused replication
    // (e.g. "rebuild paper P3's S-O-R chain with one IV"). Drop the cross-paper requirement to 1
    // in that case so the user's explicit intent isn't silently overridden.
    const minDistinctPapers = hasCustomPrompt ? 1 : Math.min(3, papers.length);
    const minNodes = hasCustomPrompt ? 4 : (papers.length >= 3 ? 5 : 4);

    function validate(m: typeof generated[number] & { secondaryOperator?: string }): { ok: true } | { ok: false; reason: string } {
      if (!m || typeof m.name !== "string" || !Array.isArray(m.nodes) || !Array.isArray(m.edges)) return { ok: false, reason: "missing required fields" };
      if (!m.operator || !ALLOWED_OPERATORS.has(m.operator)) return { ok: false, reason: `invalid operator: ${m.operator}` };
      if (!m.secondaryOperator || !ALLOWED_OPERATORS.has(m.secondaryOperator)) return { ok: false, reason: `missing/invalid secondaryOperator: ${m.secondaryOperator}` };
      if (m.secondaryOperator === m.operator) return { ok: false, reason: "secondaryOperator must differ from primary operator" };
      if (m.backbone && !ALLOWED_BACKBONES.has(m.backbone)) return { ok: false, reason: `invalid backbone: ${m.backbone}` };
      if (m.nodes.length < minNodes || m.nodes.length > 8) return { ok: false, reason: `node count out of range (${m.nodes.length}, need ≥${minNodes})` };
      if (m.edges.length < 4 || m.edges.length > 8) return { ok: false, reason: `edge count out of range (${m.edges.length}, need ≥4)` };
      // every node references a real variable from this session
      for (const n of m.nodes) {
        if (!validVarIds.has(n.variableId)) return { ok: false, reason: `unknown variableId ${n.variableId}` };
        if (!validPaperIds.has(n.paperId)) return { ok: false, reason: `unknown paperId ${n.paperId}` };
      }
      // cross-paper synthesis: ≥ N distinct source papers in nodes
      const distinctPapers = new Set(m.nodes.map((n) => n.paperId));
      if (distinctPapers.size < minDistinctPapers) return { ok: false, reason: `requires nodes from ≥ ${minDistinctPapers} different papers (got ${distinctPapers.size})` };
      const nodeIds = new Set(m.nodes.map((n) => n.variableId));
      // Lookup canonical+layer for each node by variableId.
      const varMeta = new Map(variables.map((v) => [v.id, v]));

      // RULE 11: one role per canonical construct.
      const canonicalRoleMap = new Map<string, Set<string>>();
      for (const n of m.nodes) {
        const v = varMeta.get(n.variableId);
        const canon = v?.canonicalConstructId;
        if (!canon) continue;
        if (!canonicalRoleMap.has(canon)) canonicalRoleMap.set(canon, new Set());
        canonicalRoleMap.get(canon)!.add(n.type);
      }
      for (const [canon, roles] of canonicalRoleMap) {
        if (roles.size > 1) return { ok: false, reason: `canonical construct "${canon}" plays multiple roles (${[...roles].join(",")}) in the same model` };
      }

      // every edge references a node that exists, and has non-empty evidence
      for (const e of m.edges) {
        if (!nodeIds.has(e.fromVariableId) || !nodeIds.has(e.toVariableId)) return { ok: false, reason: "edge references unknown node" };
        if (!e.evidenceCitationText || e.evidenceCitationText.trim().length < 12) return { ok: false, reason: "missing/too-short evidence text" };
        if (!validPaperIds.has(e.evidencePaperId)) return { ok: false, reason: `unknown evidencePaperId ${e.evidencePaperId}` };
        // RULE 12: moderator edges MUST have justification.
        if (e.relationship === "moderates") {
          const just = (e as { moderatorJustification?: string | null }).moderatorJustification;
          if (!just || String(just).trim().length < 12) return { ok: false, reason: `moderator edge ${e.fromVariableName} → ${e.toVariableName} missing moderatorJustification` };
        }
        // RULE 10a: construct-layer ordering — non-moderator edges must go FORWARD.
        if (e.relationship !== "moderates") {
          const fromV = varMeta.get(e.fromVariableId);
          const toV = varMeta.get(e.toVariableId);
          const fi = layerIndex(fromV?.constructLayer);
          const ti = layerIndex(toV?.constructLayer);
          if (fi >= 0 && ti >= 0) {
            if (ti < fi) {
              return { ok: false, reason: `backward layer edge: ${fromV?.constructLayer}(${fromV?.name}) → ${toV?.constructLayer}(${toV?.name})` };
            }
            // RULE 10c: prohibit 2-layer jumps (e.g. stimulus → behavior with no cognitive/affective mediator).
            // Skipping ≥3 layers in a single edge is structurally a "logic jump" and is rejected.
            if (ti - fi >= 3) {
              return { ok: false, reason: `2-step layer jump: ${fromV?.constructLayer}(${fromV?.name}) → ${toV?.constructLayer}(${toV?.name}) (insert a mediator)` };
            }
          }
        }
      }

      // RULE 10b: mediator chain length ≤ 3 hops, measured ONLY along IV → … → DV paths.
      // Long side branches that don't terminate at a DV must not trigger rejection.
      const adj = new Map<number, number[]>();
      for (const e of m.edges) {
        if (e.relationship === "moderates") continue;
        if (!adj.has(e.fromVariableId)) adj.set(e.fromVariableId, []);
        adj.get(e.fromVariableId)!.push(e.toVariableId);
      }
      const dvIds = new Set(m.nodes.filter((n) => n.type === "dependent").map((n) => n.variableId));
      // longestToDV(start) = longest # of nodes on any path from `start` ending at a DV; -Infinity if none.
      function longestToDV(start: number, visited: Set<number>): number {
        if (visited.has(start)) return -Infinity; // cycle guard
        const isDV = dvIds.has(start);
        const next = adj.get(start) ?? [];
        if (next.length === 0) return isDV ? 1 : -Infinity;
        const v2 = new Set(visited); v2.add(start);
        let best = isDV ? 1 : -Infinity;
        for (const n of next) {
          const sub = longestToDV(n, v2);
          if (sub !== -Infinity) best = Math.max(best, 1 + sub);
        }
        return best;
      }
      const ivIds = m.nodes.filter((n) => n.type === "independent").map((n) => n.variableId);
      let maxChain = 0;
      for (const iv of ivIds) {
        const r = longestToDV(iv, new Set());
        if (r !== -Infinity) maxChain = Math.max(maxChain, r);
      }
      if (maxChain > 4) {
        // 4 = IV + up to 2 mediators + DV (3 hops). Reject if any IV→DV path is > 3 hops.
        return { ok: false, reason: `mediator chain too long (${maxChain - 1} hops on an IV→DV path, max allowed = 3)` };
      }
      return { ok: true };
    }

    // Distinguish HARD failures (data corruption — unknown ids, missing fields,
    // moderator without justification — these models are unusable) from SOFT
    // failures (theoretical-shape violations like 2-step layer jumps or long
    // mediator chains — the model is still readable, just imperfect). When we
    // end up with zero hard-pass models, we rescue all soft-fail models so the
    // user gets *something* to look at, with the warnings surfaced inline in
    // the rationale instead of a blank screen.
    const SOFT_FAIL_PATTERNS = [
      /2-step layer jump/i,
      /backward layer edge/i,
      /mediator chain too long/i,
      /node count out of range/i,
      /edge count out of range/i,
      /requires nodes from/i,
    ];
    const isSoftFail = (reason: string) => SOFT_FAIL_PATTERNS.some((re) => re.test(reason));

    const accepted: typeof generated = [];
    const rejected: Array<{ m: typeof generated[number]; v: { reason: string }; soft: boolean }> = [];
    const seenOpPairs = new Set<string>();
    const seenBaseSets = new Set<string>();
    for (const m of generated) {
      const v = validate(m);
      if (!v.ok) {
        rejected.push({ m, v: { reason: v.reason }, soft: isSoftFail(v.reason) });
        continue;
      }
      const opPair = `${m.operator}+${m.secondaryOperator}`;
      const baseSet = [...new Set(m.nodes.map((n) => n.paperId))].sort((a, b) => a - b).join(",");
      if (seenOpPairs.has(opPair)) {
        rejected.push({ m, v: { reason: `duplicate operator pair across models: ${opPair}` }, soft: true });
        continue;
      }
      if (seenBaseSets.has(baseSet)) {
        rejected.push({ m, v: { reason: `duplicate base-paper set across models: [${baseSet}]` }, soft: true });
        continue;
      }
      seenOpPairs.add(opPair);
      seenBaseSets.add(baseSet);
      accepted.push(m);
    }
    if (rejected.length > 0) {
      req.log.warn({ rejected: rejected.map((r) => ({ name: r.m?.name, reason: r.v.reason, soft: r.soft })) }, "Some generated models rejected by validator");
    }

    // Rescue path: when zero hard-pass models, salvage every soft-fail model
    // so the user sees something to work from instead of a 502 error wall.
    // We attach the warnings into both partialPassMeta (machine-readable) and
    // a [质量警告:...] prefix on the rationale (so it shows up in the UI even
    // before the frontend learns about the new field).
    type RescuedItem = typeof generated[number] & { _qualityWarnings?: string[] };
    if (accepted.length === 0) {
      const softFails = rejected.filter((r) => r.soft && r.m && typeof r.m.name === "string" && Array.isArray(r.m.nodes) && Array.isArray(r.m.edges) && r.m.nodes.length > 0);
      if (softFails.length === 0) {
        res.status(502).json({
          error: "AI 生成的模型都没通过基础数据校验（如缺字段、变量 id 不存在）。请重试一次，或精简你的『自定义提示词』。",
          rejected: rejected.map((r) => ({ name: r.m?.name ?? "(unnamed)", reason: r.v.reason })),
        });
        return;
      }
      // Rescue must respect the same dedup rules the strict path enforced —
      // otherwise we could reintroduce models that were rejected as duplicate
      // operator-pairs / base-paper-sets.
      const rescueOpPairs = new Set<string>();
      const rescueBaseSets = new Set<string>();
      let salvaged = 0;
      for (const r of softFails) {
        const opPair = `${r.m.operator ?? "?"}+${r.m.secondaryOperator ?? "?"}`;
        const baseSet = [...new Set((r.m.nodes ?? []).map((n) => n.paperId))].sort((a, b) => a - b).join(",");
        if (rescueOpPairs.has(opPair) || rescueBaseSets.has(baseSet)) continue;
        rescueOpPairs.add(opPair);
        rescueBaseSets.add(baseSet);
        const item = r.m as RescuedItem;
        item._qualityWarnings = [r.v.reason];
        accepted.push(item);
        salvaged++;
      }
      req.log.warn({ candidates: softFails.length, salvaged }, "Rescue mode: salvaged soft-fail models because zero passed strict validation");
      if (accepted.length === 0) {
        res.status(502).json({
          error: "AI 生成的模型都没通过基础数据校验。请重试一次，或精简你的『自定义提示词』。",
          rejected: rejected.map((r) => ({ name: r.m?.name ?? "(unnamed)", reason: r.v.reason })),
        });
        return;
      }
    }

    await db.delete(researchModelsTable).where(eq(researchModelsTable.sessionId, sessionId));

    const inserted = await Promise.all(
      accepted.map((m) => {
        const opTag = `${m.operator}+${m.secondaryOperator}`;
        const tagPrefix = `[OPERATOR: ${opTag}] [BASE: ${(m.basePaperTags ?? []).join("+") || "?"}] [BACKBONE: ${m.backbone ?? "NONE"}]`;
        // Always normalize: strip any pre-existing [OPERATOR:...] [BASE:...] [BACKBONE:...] header so the persisted prefix is canonical.
        const stripped = (m.rationale ?? "").replace(/^\s*\[OPERATOR:[^\]]*\]\s*(\[BASE:[^\]]*\])?\s*(\[BACKBONE:[^\]]*\])?\s*/i, "").trim();
        const warns = (m as RescuedItem)._qualityWarnings ?? [];
        const warnPrefix = warns.length > 0 ? `[质量警告: ${warns.join("; ")}] ` : "";
        const rationale = `${warnPrefix}${tagPrefix} ${stripped}`;
        // Stash quality warnings into partialPassMeta (jsonb — schema-flexible).
        const meta: (PartialPassMeta & { qualityWarnings?: string[] }) | null =
          warns.length > 0
            ? { ...(partialPassMeta ?? { allowPartial: false, basedOnPaperIds: papersWithVars.map((p) => p.id), missingPaperIds: [], missingPapers: [] }), qualityWarnings: warns }
            : partialPassMeta;
        return db.insert(researchModelsTable).values({
          sessionId,
          name: m.name,
          description: m.description,
          rationale,
          selected: "false",
          nodes: m.nodes,
          edges: m.edges,
          partialPassMeta: meta,
        }).returning();
      })
    );

    // Record this generation in the learning log.
    await db.insert(generationFeedbackTable).values({
      sessionId,
      userPrompt,
      numModelsRequested: numModels,
      generatedModelNames: accepted.map((m) => m.name),
    });

    res.json(inserted.flat().map(formatModel));
  } catch (err) {
    req.log.error({ err }, "Error generating models");
    res.status(500).json({ error: "Failed to generate research models" });
  }
});

router.get("/sessions/:id/models", async (req, res): Promise<void> => {
  const params = ListSessionModelsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const models = await db
    .select()
    .from(researchModelsTable)
    .where(eq(researchModelsTable.sessionId, params.data.id))
    .orderBy(researchModelsTable.createdAt);

  res.json(models.map(formatModel));
});

router.get("/sessions/:id/learning-stats", async (req, res): Promise<void> => {
  const params = GetSessionLearningStatsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withSel: sql<number>`count(*) filter (where ${generationFeedbackTable.selectedModelSnapshot} is not null)::int`,
      withEdits: sql<number>`count(*) filter (where ${generationFeedbackTable.userEditedSnapshot} is not null)::int`,
    })
    .from(generationFeedbackTable);
  res.json({
    totalFeedback: row?.total ?? 0,
    withSelections: row?.withSel ?? 0,
    withEdits: row?.withEdits ?? 0,
  });
});

router.get("/models/:id", async (req, res): Promise<void> => {
  const params = GetModelParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [model] = await db.select().from(researchModelsTable).where(eq(researchModelsTable.id, params.data.id));
  if (!model) {
    res.status(404).json({ error: "Model not found" });
    return;
  }

  res.json(formatModel(model));
});

router.patch("/models/:id", async (req, res): Promise<void> => {
  const params = UpdateModelParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateModelBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db.select().from(researchModelsTable).where(eq(researchModelsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Model not found" });
    return;
  }

  const patch: Partial<typeof researchModelsTable.$inferInsert> = {};
  if (typeof body.data.name === "string") patch.name = body.data.name;
  if (typeof body.data.description === "string") patch.description = body.data.description;
  if (typeof body.data.rationale === "string") patch.rationale = body.data.rationale;
  if (Array.isArray(body.data.nodes)) patch.nodes = body.data.nodes as unknown as ModelNode[];
  if (Array.isArray(body.data.edges)) patch.edges = body.data.edges as unknown as ModelEdge[];

  const [updated] = await db
    .update(researchModelsTable)
    .set(patch)
    .where(eq(researchModelsTable.id, params.data.id))
    .returning();

  const [latestFeedback] = await db
    .select()
    .from(generationFeedbackTable)
    .where(eq(generationFeedbackTable.sessionId, existing.sessionId))
    .orderBy(desc(generationFeedbackTable.createdAt))
    .limit(1);
  if (latestFeedback) {
    await db
      .update(generationFeedbackTable)
      .set({ userEditedSnapshot: formatModel(updated) })
      .where(eq(generationFeedbackTable.id, latestFeedback.id));
  }

  res.json(formatModel(updated));
});

// Pure-compute model quality report. No AI cost. Reads model + session
// hypotheses + variable layers, returns 5 health checks + a list of weak edges
// for the UI to highlight.
router.get("/models/:id/quality-report", async (req, res): Promise<void> => {
  const params = GetModelParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [model] = await db.select().from(researchModelsTable).where(eq(researchModelsTable.id, params.data.id));
  if (!model) {
    res.status(404).json({ error: "Model not found" });
    return;
  }

  const nodes = (model.nodes ?? []) as ModelNode[];
  const edges = (model.edges ?? []) as ModelEdge[];

  // Pull session-scoped variable layer info.
  const sessionVars = await db.select().from(variablesTable).where(eq(variablesTable.sessionId, model.sessionId));
  const layerByVarId = new Map<number, string | null>();
  const canonicalByVarId = new Map<number, string | null>();
  for (const v of sessionVars) {
    layerByVarId.set(v.id, (v as { constructLayer?: string | null }).constructLayer ?? null);
    canonicalByVarId.set(v.id, (v as { canonicalConstructId?: string | null }).canonicalConstructId ?? null);
  }

  // ---- structuralScore: heuristic match against any backbone slot ranges
  const counts = nodes.reduce<Record<string, number>>((acc, n) => {
    acc[n.type] = (acc[n.type] ?? 0) + 1;
    return acc;
  }, {});
  const fitsBackbone = (b: typeof THEORY_BACKBONES[number]): number => {
    const inRange = (n: number, slot?: { min: number; max: number }) =>
      slot ? (n >= slot.min && n <= slot.max ? 1 : 0) : (n === 0 ? 1 : 0.5);
    const indFit = inRange(counts.independent ?? 0, b.slots.independent);
    const medFit = inRange(counts.mediator ?? 0, b.slots.mediator);
    const modFit = inRange(counts.moderator ?? 0, b.slots.moderator);
    const depFit = inRange(counts.dependent ?? 0, b.slots.dependent);
    return (indFit + medFit + modFit + depFit) / 4;
  };
  const bestFit = THEORY_BACKBONES.reduce((m, b) => Math.max(m, fitsBackbone(b)), 0);
  const structuralScore = Math.round(bestFit * 100);

  // ---- evidenceScore: % of edges with hypothesisId or effectSize or location
  const edgesWithEvidence = edges.filter(
    (e) => (e.evidenceHypothesisId && e.evidenceHypothesisId.trim()) || (e.effectSize && e.effectSize.trim()) || (e.evidenceLocation && e.evidenceLocation.trim()),
  ).length;
  const evidenceScore = edges.length === 0 ? 0 : Math.round((edgesWithEvidence / edges.length) * 100);

  // ---- layerCompliance + per-edge layer_jump weak-edges
  const weakEdges: Array<{ fromVariableName: string; toVariableName: string; reason: string }> = [];
  let layerCompliance = true;
  for (const e of edges) {
    if (e.relationship === "moderates") continue; // moderation has no directional layer rule
    const fromLayer = layerByVarId.get(e.fromVariableId);
    const toLayer = layerByVarId.get(e.toVariableId);
    if (!fromLayer || !toLayer) continue;
    const fi = layerIndex(fromLayer);
    const ti = layerIndex(toLayer);
    if (fi >= 0 && ti >= 0 && fi > ti) {
      layerCompliance = false;
      weakEdges.push({ fromVariableName: e.fromVariableName, toVariableName: e.toVariableName, reason: "layer_jump" });
    }
  }

  // ---- duplicateRoleCheck: same canonical construct in conflicting roles
  const canonRoles = new Map<string, Set<string>>();
  for (const n of nodes) {
    const c = canonicalByVarId.get(n.variableId);
    if (!c) continue;
    if (!canonRoles.has(c)) canonRoles.set(c, new Set());
    canonRoles.get(c)!.add(n.type);
  }
  // Match generator validator: ANY canonical construct appearing in >1 role is a conflict.
  let duplicateRoleCheck = true;
  const conflictedCanon = new Set<string>();
  for (const [c, roles] of canonRoles) {
    if (roles.size > 1) {
      duplicateRoleCheck = false;
      conflictedCanon.add(c);
    }
  }
  // Emit a weak edge for every edge whose endpoint canonical construct is conflicted.
  if (conflictedCanon.size > 0) {
    const seen = new Set<string>();
    for (const e of edges) {
      const cf = canonicalByVarId.get(e.fromVariableId);
      const ct = canonicalByVarId.get(e.toVariableId);
      if ((cf && conflictedCanon.has(cf)) || (ct && conflictedCanon.has(ct))) {
        const k = `${e.fromVariableId}->${e.toVariableId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        weakEdges.push({ fromVariableName: e.fromVariableName, toVariableName: e.toVariableName, reason: "duplicate_role" });
      }
    }
  }

  // ---- moderatorJustified: every moderates edge needs a justification
  const moderatesEdges = edges.filter((e) => e.relationship === "moderates");
  const moderatesJustified = moderatesEdges.filter((e) => e.moderatorJustification && e.moderatorJustification.trim().length > 0).length;
  const moderatorJustified = moderatesEdges.length === 0 || moderatesJustified === moderatesEdges.length;
  for (const e of moderatesEdges) {
    if (!e.moderatorJustification || !e.moderatorJustification.trim()) {
      weakEdges.push({ fromVariableName: e.fromVariableName, toVariableName: e.toVariableName, reason: "missing_moderator_justification" });
    }
  }

  // ---- weak-edge: no_evidence (no hypothesisId AND no effectSize AND no location AND no citation text)
  for (const e of edges) {
    const hasAny =
      (e.evidenceHypothesisId && e.evidenceHypothesisId.trim()) ||
      (e.effectSize && e.effectSize.trim()) ||
      (e.evidenceLocation && e.evidenceLocation.trim()) ||
      (e.evidenceCitationText && e.evidenceCitationText.trim());
    if (!hasAny) {
      weakEdges.push({ fromVariableName: e.fromVariableName, toVariableName: e.toVariableName, reason: "no_evidence" });
    }
  }

  res.json({
    structuralScore,
    evidenceScore,
    layerCompliance,
    duplicateRoleCheck,
    moderatorJustified,
    weakEdges,
    totals: {
      edges: edges.length,
      edgesWithEvidence,
      moderatesEdges: moderatesEdges.length,
      moderatesJustified,
    },
  });
});

// AI-generate a publication-ready literature review paragraph that summarizes
// the model and cites every supporting paper in APA-7 in-text style.
router.post("/models/:id/literature-review", async (req, res): Promise<void> => {
  const params = GetModelParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = GenerateModelLiteratureReviewBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const lang: "zh" | "en" = body.data.lang ?? "zh";

  const [model] = await db.select().from(researchModelsTable).where(eq(researchModelsTable.id, params.data.id));
  if (!model) {
    res.status(404).json({ error: "Model not found" });
    return;
  }

  const nodes = (model.nodes ?? []) as ModelNode[];
  const edges = (model.edges ?? []) as ModelEdge[];

  // Build a compact APA-style citation key for each cited paper.
  const apaInText = (authors: string[], year: number | null): string => {
    const a = (authors ?? []).filter(Boolean);
    const yr = year ?? "n.d.";
    if (a.length === 0) return `(Unknown, ${yr})`;
    if (a.length === 1) return `(${a[0]}, ${yr})`;
    if (a.length === 2) return `(${a[0]} & ${a[1]}, ${yr})`;
    return `(${a[0]} et al., ${yr})`;
  };

  const citedPapers = new Map<number, string>();
  for (const n of nodes) if (!citedPapers.has(n.paperId)) citedPapers.set(n.paperId, apaInText(n.paperAuthors, n.paperYear));
  for (const e of edges) if (!citedPapers.has(e.evidencePaperId)) citedPapers.set(e.evidencePaperId, apaInText(e.evidencePaperAuthors, e.evidencePaperYear));

  const edgeLines = edges.map((e) => {
    const cite = apaInText(e.evidencePaperAuthors, e.evidencePaperYear);
    const hyp = e.evidenceHypothesisId ? ` [${e.evidenceHypothesisId}]` : "";
    const eff = e.effectSize ? ` ${e.effectSize}` : "";
    const loc = e.evidenceLocation ? ` (${e.evidenceLocation})` : "";
    const just = e.relationship === "moderates" && e.moderatorJustification ? ` — moderator rationale: ${e.moderatorJustification}` : "";
    return `- ${e.fromVariableName} -[${e.relationship}]-> ${e.toVariableName} ${cite}${hyp}${eff}${loc}${just}`;
  }).join("\n");

  const nodeLines = nodes.map((n) => `- ${n.variableName} [${n.type}] ${apaInText(n.paperAuthors, n.paperYear)}`).join("\n");

  const sysPrompt = lang === "zh"
    ? `你是一位严谨的中文学术写作助手。请把下面的研究模型改写成一段可直接放入论文的「研究模型」综述段落（中文，约 250-400 字，单段不分行），要求：
1. 自然地嵌入 APA-7 行内引用，格式形如 (Wang & Liu, 2023) 或 (Zhang et al., 2022)。
2. 至少描述：核心被解释变量、关键前因/中介/调节、关键路径关系，并把每条关系的引用嵌在描述它的句子里。
3. 如果某条边带有效应量或假设编号，自然地写进句子里，例如"已有研究发现 A 显著正向影响 B (β=.42, p<.001; H2a)"。
4. 不要逐条列举边；要写成连贯的学术段落。
5. 不要捏造未在输入中出现的引用或效应量。
只输出这一段中文文字，不要标题、不要 markdown 列表。`
    : `You are a rigorous academic writing assistant. Rewrite the research model below into a single English paragraph (~200-350 words, suitable for a literature review section of a paper) that:
1. Embeds APA-7 in-text citations naturally, e.g. (Wang & Liu, 2023) or (Zhang et al., 2022).
2. Describes the focal dependent variable, the key antecedents/mediators/moderators, and the key paths, attaching each citation to the sentence where the relationship is described.
3. If an edge carries an effect size or hypothesis id, weave it in, e.g. "prior work has shown that A significantly increases B (β=.42, p<.001; H2a)".
4. Write a coherent paragraph, NOT a bullet list of edges.
5. Do not fabricate citations or effect sizes not present in the input.
Output only the paragraph — no title, no markdown headings, no bullet lists.`;

  const userPrompt = `MODEL NAME: ${model.name}
DESCRIPTION: ${model.description}
RATIONALE: ${model.rationale}

NODES:
${nodeLines}

EDGES (with evidence):
${edgeLines}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 1400,
      messages: [
        { role: "system", content: sysPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    const markdown = (completion.choices[0]?.message?.content ?? "").trim();
    if (!markdown) {
      res.status(503).json({ error: "AI returned empty response" });
      return;
    }
    res.json({ markdown, lang });
  } catch (err) {
    req.log.error({ err }, "literature review generation failed");
    res.status(503).json({ error: "AI integration unavailable" });
  }
});

router.post("/models/:id/select", async (req, res): Promise<void> => {
  const params = SelectModelParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [model] = await db.select().from(researchModelsTable).where(eq(researchModelsTable.id, params.data.id));
  if (!model) {
    res.status(404).json({ error: "Model not found" });
    return;
  }

  await db.update(researchModelsTable).set({ selected: "false" }).where(eq(researchModelsTable.sessionId, model.sessionId));
  const [updated] = await db.update(researchModelsTable).set({ selected: "true" }).where(eq(researchModelsTable.id, params.data.id)).returning();

  const [latestFeedback] = await db
    .select()
    .from(generationFeedbackTable)
    .where(eq(generationFeedbackTable.sessionId, model.sessionId))
    .orderBy(desc(generationFeedbackTable.createdAt))
    .limit(1);
  if (latestFeedback) {
    await db
      .update(generationFeedbackTable)
      .set({ selectedModelSnapshot: formatModel(updated) })
      .where(eq(generationFeedbackTable.id, latestFeedback.id));
  }

  res.json(formatModel(updated));
});

// ============================================================================
// Smart evidence matching (candidate models)
// ============================================================================

type EvidenceSearchBody = {
  scopes?: Array<"library" | "web">;
  granularity?: Array<"overall" | "per-edge">;
  instructions?: string | null;
};

type AdditionalEvidence = {
  paperId: number;
  paperTitle: string;
  paperAuthors: string[];
  paperYear: number | null;
  citationText: string;
  source: "library" | "web";
  score: number | null;
  addedAt: string;
};

type ModelEdgeWithEvidence = ModelEdge & { additionalEvidence?: AdditionalEvidence[] };

function buildEdgeInputs(edges: ModelEdge[]): EdgeInput[] {
  return edges.map((e) => ({
    edgeKey: makeEdgeKey(e.fromVariableId, e.toVariableId, e.relationship),
    fromVariableId: e.fromVariableId,
    toVariableId: e.toVariableId,
    fromVariableName: e.fromVariableName,
    toVariableName: e.toVariableName,
    relationship: e.relationship,
  }));
}

function summariseModel(m: { name: string; description: string; rationale: string; nodes: ModelNode[]; edges: ModelEdge[] }): string {
  const nodeLine = m.nodes.map((n) => `${n.variableName} [${n.type}]`).join(", ");
  const edgeLine = m.edges.map((e) => `${e.fromVariableName} --${e.relationship}--> ${e.toVariableName}`).join("; ");
  return `Title: ${m.name}\nDescription: ${m.description}\nRationale: ${m.rationale}\nVariables: ${nodeLine}\nRelationships: ${edgeLine}`;
}

router.post("/sessions/:id/models/:modelId/evidence-search", async (req, res): Promise<void> => {
  const sessionId = parseInt(req.params.id, 10);
  const modelId = parseInt(req.params.modelId, 10);
  if (!Number.isFinite(sessionId) || !Number.isFinite(modelId)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const [model] = await db.select().from(researchModelsTable).where(eq(researchModelsTable.id, modelId));
  if (!model || model.sessionId !== sessionId) {
    res.status(404).json({ error: "Model not found" });
    return;
  }
  const body = (req.body ?? {}) as EvidenceSearchBody;
  const scopes: Array<"library" | "web"> = Array.isArray(body.scopes) && body.scopes.length > 0 ? body.scopes : ["library", "web"];
  const granularity: Array<"overall" | "per-edge"> = Array.isArray(body.granularity) && body.granularity.length > 0 ? body.granularity : ["overall", "per-edge"];
  const formatted = formatModel(model);
  try {
    const result = await findEvidenceForModel({
      sessionId,
      edges: buildEdgeInputs(formatted.edges),
      modelSummary: summariseModel(formatted),
      options: { scopes, granularity, instructions: body.instructions ?? null },
    });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "evidence search failed");
    res.status(503).json({ error: "AI integration unavailable" });
  }
});

router.post("/sessions/:id/models/:modelId/evidence-apply", async (req, res): Promise<void> => {
  const sessionId = parseInt(req.params.id, 10);
  const modelId = parseInt(req.params.modelId, 10);
  if (!Number.isFinite(sessionId) || !Number.isFinite(modelId)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const [model] = await db.select().from(researchModelsTable).where(eq(researchModelsTable.id, modelId));
  if (!model || model.sessionId !== sessionId) {
    res.status(404).json({ error: "Model not found" });
    return;
  }
  const body = (req.body ?? {}) as {
    addPapers?: Array<{ externalId: string; title: string; authors?: string[]; year?: number | null; abstract?: string | null; url?: string | null }>;
    edgeAttachments?: Array<{ edgeKey: string; paperId?: number | null; externalId?: string | null; evidenceQuote: string }>;
    reason?: string | null;
  };

  // 1. Snapshot the model BEFORE any change so the user can revert.
  await db.insert(modelVersionsTable).values({
    sessionId,
    kind: "candidate",
    modelId,
    snapshot: formatModel(model) as unknown as Record<string, unknown>,
    reason: (body.reason ?? "evidence_apply").slice(0, 200),
  });

  // 2. Import any chosen web papers; build externalId → paperId map.
  const externalToPaperId = new Map<string, number>();
  for (const p of body.addPapers ?? []) {
    if (!p?.externalId) continue;
    try {
      const id = await importWebPaper({
        sessionId,
        externalId: p.externalId,
        title: p.title,
        authors: p.authors ?? [],
        year: p.year ?? null,
        abstract: p.abstract ?? null,
        url: p.url ?? null,
      });
      externalToPaperId.set(p.externalId, id);
    } catch (err) {
      req.log.warn({ err, externalId: p.externalId }, "importWebPaper failed");
    }
  }

  // 3. Look up paper metadata for everything we'll attach.
  const allPaperIds = new Set<number>();
  for (const a of body.edgeAttachments ?? []) {
    if (a.paperId) allPaperIds.add(a.paperId);
    else if (a.externalId && externalToPaperId.has(a.externalId)) allPaperIds.add(externalToPaperId.get(a.externalId)!);
  }
  const paperMeta = new Map<number, { title: string; authors: string[]; year: number | null }>();
  if (allPaperIds.size > 0) {
    const rows = await db.select().from(papersTable).where(eq(papersTable.sessionId, sessionId));
    for (const r of rows) {
      if (allPaperIds.has(r.id)) paperMeta.set(r.id, { title: r.title, authors: (r.authors as string[]) ?? [], year: r.year ?? null });
    }
  }

  // 4. Attach evidence to edges by appending to additionalEvidence[].
  const edges = (model.edges ?? []) as ModelEdgeWithEvidence[];
  const now = new Date().toISOString();
  for (const a of body.edgeAttachments ?? []) {
    if (!a?.evidenceQuote || !a.evidenceQuote.trim()) continue;
    let pid: number | null = a.paperId ?? null;
    if (!pid && a.externalId) pid = externalToPaperId.get(a.externalId) ?? null;
    if (!pid) continue;
    const meta = paperMeta.get(pid);
    if (!meta) continue;
    const targetIdx = edges.findIndex(
      (e) => makeEdgeKey(e.fromVariableId, e.toVariableId, e.relationship) === a.edgeKey,
    );
    if (targetIdx === -1) continue;
    const target = edges[targetIdx]!;
    const list: AdditionalEvidence[] = Array.isArray(target.additionalEvidence) ? [...target.additionalEvidence] : [];
    if (list.some((x) => x.paperId === pid && x.citationText === a.evidenceQuote)) continue; // dedupe
    list.push({
      paperId: pid,
      paperTitle: meta.title,
      paperAuthors: meta.authors,
      paperYear: meta.year,
      citationText: a.evidenceQuote.slice(0, 1000),
      source: a.externalId && externalToPaperId.has(a.externalId) ? "web" : "library",
      score: null,
      addedAt: now,
    });
    edges[targetIdx] = { ...target, additionalEvidence: list };
  }

  const [updated] = await db
    .update(researchModelsTable)
    .set({ edges: edges as unknown as ModelEdge[] })
    .where(eq(researchModelsTable.id, modelId))
    .returning();

  res.json(formatModel(updated));
});

router.get("/sessions/:id/models/:modelId/versions", async (req, res): Promise<void> => {
  const sessionId = parseInt(req.params.id, 10);
  const modelId = parseInt(req.params.modelId, 10);
  if (!Number.isFinite(sessionId) || !Number.isFinite(modelId)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const rows = await db
    .select()
    .from(modelVersionsTable)
    .where(eq(modelVersionsTable.sessionId, sessionId))
    .orderBy(desc(modelVersionsTable.createdAt))
    .limit(50);
  const out = rows
    .filter((v) => v.kind === "candidate" && v.modelId === modelId)
    .map((v) => {
      const snap = (v.snapshot ?? {}) as { nodes?: unknown[]; edges?: unknown[] };
      return {
        id: v.id,
        kind: "candidate",
        modelId: v.modelId,
        reason: v.reason,
        nodeCount: Array.isArray(snap.nodes) ? snap.nodes.length : 0,
        edgeCount: Array.isArray(snap.edges) ? snap.edges.length : 0,
        createdAt: v.createdAt.toISOString(),
      };
    });
  res.json(out);
});

router.post("/sessions/:id/models/:modelId/revert/:versionId", async (req, res): Promise<void> => {
  const sessionId = parseInt(req.params.id, 10);
  const modelId = parseInt(req.params.modelId, 10);
  const versionId = parseInt(req.params.versionId, 10);
  if (!Number.isFinite(sessionId) || !Number.isFinite(modelId) || !Number.isFinite(versionId)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const [version] = await db.select().from(modelVersionsTable).where(eq(modelVersionsTable.id, versionId));
  if (!version || version.sessionId !== sessionId || version.kind !== "candidate" || version.modelId !== modelId) {
    res.status(404).json({ error: "Version not found" });
    return;
  }
  const [model] = await db.select().from(researchModelsTable).where(eq(researchModelsTable.id, modelId));
  if (!model) {
    res.status(404).json({ error: "Model not found" });
    return;
  }
  // Snapshot the *current* state first so the revert itself is undoable.
  await db.insert(modelVersionsTable).values({
    sessionId,
    kind: "candidate",
    modelId,
    snapshot: formatModel(model) as unknown as Record<string, unknown>,
    reason: `pre_revert_to_v${versionId}`,
  });
  const snap = version.snapshot as { name?: string; description?: string; rationale?: string; nodes?: ModelNode[]; edges?: ModelEdge[] };
  const [updated] = await db
    .update(researchModelsTable)
    .set({
      name: typeof snap.name === "string" ? snap.name : model.name,
      description: typeof snap.description === "string" ? snap.description : model.description,
      rationale: typeof snap.rationale === "string" ? snap.rationale : model.rationale,
      nodes: (snap.nodes ?? model.nodes) as unknown as ModelNode[],
      edges: (snap.edges ?? model.edges) as unknown as ModelEdge[],
    })
    .where(eq(researchModelsTable.id, modelId))
    .returning();
  res.json(formatModel(updated));
});

export default router;

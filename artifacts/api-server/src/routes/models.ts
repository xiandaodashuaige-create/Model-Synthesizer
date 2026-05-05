import { Router, type IRouter } from "express";
import { eq, desc, isNotNull, sql } from "drizzle-orm";
import {
  db,
  researchModelsTable,
  variablesTable,
  papersTable,
  generationFeedbackTable,
} from "@workspace/db";
import {
  GenerateModelsParams,
  GenerateModelsBody,
  ListSessionModelsParams,
  GetModelParams,
  SelectModelParams,
  UpdateModelParams,
  UpdateModelBody,
  GetSessionLearningStatsParams,
} from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import {
  THEORY_BACKBONES,
  backbonesAsPromptBlock,
  operatorsAsPromptBlock,
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
    return `- ID:${v.id}${focus} | Name: "${v.name}" | Type: ${v.type} | Source: ${tag} ${paper?.title} (${(paper?.authors ?? []).slice(0, 2).join(", ")}, ${paper?.year ?? "n.d."}) | Definition: ${v.definition} | Citation: "${v.citationText}"`;
  }).join("\n");

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

Your task: produce ${numModels} *novel* and theoretically coherent research model proposals by RECOMBINING the source papers' own research models below using EXPLICIT STRUCTURAL OPERATORS. Each output model MUST be the result of applying ONE named operator to ONE OR MORE of the original models.

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
CLASSICAL THEORY BACKBONES you may graft onto (operator THEORY_GRAFT):
${backbonesAsPromptBlock()}

================================================================
STRUCTURAL OPERATORS (every output model must be tagged with exactly one):
${operatorsAsPromptBlock()}
${userBlock}${focusBlock}${learnedBlock}

================================================================
HARD RULES (violations = invalid output):
1. **Operator-driven**: each model MUST start its rationale with "[OPERATOR: <ID>] [BASE: <Pn>(+<Pm>...)] [BACKBONE: <id or NONE>]" so the recombination logic is auditable.
2. **Distinct operators**: the ${numModels} models must use ${Math.min(numModels, 4)} *different* operators if possible. Do not output two models with the same (operator, base papers) pair.
3. **Respect original directions**: when an edge connects two variables that already appeared together in a paper's hypothesis, use the SAME direction and sign that paper proposed. Do not flip causality unless explicitly justified in the rationale.
4. **Cross-paper synthesis**: each model MUST include nodes from ≥ 2 different source papers (THEORY_GRAFT must include nodes from ≥ 2 different papers AND match a backbone).
5. **Citation grounding**: every "evidenceCitationText" MUST be a verbatim sentence either from the variable's "Citation" field or from the paper graph's "evidence" field above. If you cannot find such a sentence, omit that edge.
6. **Layout discipline**: order nodes Independent → Mediator → Moderator → Dependent. Never put a dependent left of an independent.
7. **Size**: 4–7 nodes and 3–6 edges per model.
8. **Variety**: each model must have a clearly different theoretical focus (different DV, different mediator chain, or different moderator).

OUTPUT FORMAT — return ONLY a JSON array, no markdown:
[
  {
    "operator": "EXTEND|INSERT_MODERATOR|PARALLEL_MEDIATORS|SWAP_MEDIATOR|THEORY_GRAFT",
    "basePaperTags": ["P1", "P2"],
    "backbone": "SOR|TAM|UTAUT|ELM|TPB|TRUST_TRANSFER|PARASOCIAL|FLOW|NONE",
    "name": "concise model name",
    "description": "1-2 sentences",
    "rationale": "[OPERATOR: ...] [BASE: ...] [BACKBONE: ...] then 3-5 sentences explaining HOW the operator was applied (which edge from which paper was extended/grafted/swapped/etc.) and why this is theoretically coherent",
    "nodes": [
      { "variableId": <int>, "variableName": "<name>", "type": "independent|mediator|moderator|dependent", "paperId": <int>, "paperTitle": "<title>", "paperAuthors": ["<author>"], "paperYear": <year or null> }
    ],
    "edges": [
      { "fromVariableId": <int>, "toVariableId": <int>, "fromVariableName": "<name>", "toVariableName": "<name>", "relationship": "positive|negative|moderates|mediates", "evidencePaperId": <int>, "evidencePaperTitle": "<title>", "evidencePaperAuthors": ["<author>"], "evidencePaperYear": <year or null>, "evidenceCitationText": "<verbatim sentence from the paper>" }
    ]
  }
]`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 18000,
      messages: [{ role: "user", content: prompt }],
    });

    const content = completion.choices[0]?.message?.content ?? "[]";
    let generated: Array<{ operator?: string; basePaperTags?: string[]; backbone?: string; name: string; description: string; rationale: string; nodes: ModelNode[]; edges: ModelEdge[] }> = [];

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

    function validate(m: typeof generated[number]): { ok: true } | { ok: false; reason: string } {
      if (!m || typeof m.name !== "string" || !Array.isArray(m.nodes) || !Array.isArray(m.edges)) return { ok: false, reason: "missing required fields" };
      if (!m.operator || !ALLOWED_OPERATORS.has(m.operator)) return { ok: false, reason: `invalid operator: ${m.operator}` };
      if (m.backbone && !ALLOWED_BACKBONES.has(m.backbone)) return { ok: false, reason: `invalid backbone: ${m.backbone}` };
      if (m.nodes.length < 3 || m.nodes.length > 8) return { ok: false, reason: `node count out of range (${m.nodes.length})` };
      if (m.edges.length < 2 || m.edges.length > 8) return { ok: false, reason: `edge count out of range (${m.edges.length})` };
      // every node references a real variable from this session
      for (const n of m.nodes) {
        if (!validVarIds.has(n.variableId)) return { ok: false, reason: `unknown variableId ${n.variableId}` };
        if (!validPaperIds.has(n.paperId)) return { ok: false, reason: `unknown paperId ${n.paperId}` };
      }
      // cross-paper synthesis: ≥ 2 distinct source papers in nodes
      const distinctPapers = new Set(m.nodes.map((n) => n.paperId));
      if (distinctPapers.size < 2) return { ok: false, reason: "requires nodes from ≥ 2 different papers" };
      const nodeIds = new Set(m.nodes.map((n) => n.variableId));
      // every edge references a node that exists, and has non-empty evidence
      for (const e of m.edges) {
        if (!nodeIds.has(e.fromVariableId) || !nodeIds.has(e.toVariableId)) return { ok: false, reason: "edge references unknown node" };
        if (!e.evidenceCitationText || e.evidenceCitationText.trim().length < 12) return { ok: false, reason: "missing/too-short evidence text" };
        if (!validPaperIds.has(e.evidencePaperId)) return { ok: false, reason: `unknown evidencePaperId ${e.evidencePaperId}` };
      }
      return { ok: true };
    }

    const validated = generated.map((m) => ({ m, v: validate(m) }));
    const accepted = validated.filter((x) => x.v.ok).map((x) => x.m);
    const rejected = validated.filter((x) => !x.v.ok);
    if (rejected.length > 0) {
      req.log.warn({ rejected: rejected.map((r) => ({ name: r.m?.name, reason: (r.v as { reason: string }).reason })) }, "Some generated models rejected by validator");
    }
    if (accepted.length === 0) {
      res.status(502).json({
        error: "AI did not produce any structurally valid models. Try rephrasing your custom prompt or regenerating.",
        rejected: rejected.map((r) => ({ name: r.m?.name ?? "(unnamed)", reason: (r.v as { reason: string }).reason })),
      });
      return;
    }

    await db.delete(researchModelsTable).where(eq(researchModelsTable.sessionId, sessionId));

    const inserted = await Promise.all(
      accepted.map((m) => {
        const tagPrefix = `[OPERATOR: ${m.operator}] [BASE: ${(m.basePaperTags ?? []).join("+") || "?"}] [BACKBONE: ${m.backbone ?? "NONE"}]`;
        const rationale = m.rationale?.startsWith("[OPERATOR:") ? m.rationale : `${tagPrefix}\n${m.rationale ?? ""}`;
        return db.insert(researchModelsTable).values({
          sessionId,
          name: m.name,
          description: m.description,
          rationale,
          selected: "false",
          nodes: m.nodes,
          edges: m.edges,
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

export default router;

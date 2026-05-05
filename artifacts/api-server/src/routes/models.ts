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

interface PaperResearchModel {
  summary: string;          // 1-3 sentence plain-language summary of the paper's research model
  coreVariables: string[];  // canonical names of the core variables in the paper's own model
  hypotheses: string[];     // verbatim or paraphrased H1/H2... statements
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

// Lazily extract each paper's OWN research model from its full text and cache on the paper row.
// Runs once per paper, results are reused on every subsequent generation.
async function extractPaperResearchModel(
  paper: typeof papersTable.$inferSelect,
  reqLog: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<PaperResearchModel | null> {
  if (paper.researchModel) return paper.researchModel as PaperResearchModel;
  const text = paper.fullText && paper.fullText.length > 200 ? paper.fullText : paper.abstract;
  if (!text || text.length < 80) return null;

  const truncated = text.slice(0, 8000).replace(/\s+/g, " ");
  const prompt = `You are a research-methods analyst. Read this academic paper and extract its OWN research model in strict JSON.

Paper title: ${paper.title}
Authors: ${(paper.authors ?? []).slice(0, 3).join(", ")}
Year: ${paper.year ?? "n.d."}

Text:
${truncated}

Return ONLY this JSON (no markdown):
{
  "summary": "1-3 sentence plain-language summary of the model the paper proposes (what predicts what, through what)",
  "coreVariables": ["variable name 1", "variable name 2", "..."],
  "hypotheses": ["H1: X positively affects Y.", "H2: Z mediates the effect of X on Y.", "..."]
}

Rules:
- "coreVariables" must list the variables that appear IN THE PAPER'S MODEL/HYPOTHESES, not every concept mentioned.
- "hypotheses" should be the literal hypotheses (or close paraphrases) — keep them short and one per line.
- If the paper has no clearly stated research model, return summary="No explicit research model.", and empty arrays.
- Do not invent variables.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    const content = completion.choices[0]?.message?.content ?? "{}";
    const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned) as PaperResearchModel;
    if (typeof parsed.summary !== "string") return null;
    parsed.coreVariables = Array.isArray(parsed.coreVariables) ? parsed.coreVariables.slice(0, 12) : [];
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

  // Stage 1: extract each paper's OWN research model in parallel (cached).
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

  // Stage 2 input: each paper's own research model.
  const originalModelsBlock = perPaperModels
    .filter((x) => x.model)
    .map((x) => {
      const tag = paperTagById.get(x.paper.id) ?? "?";
      const m = x.model!;
      const hyps = m.hypotheses.length > 0 ? `\n  Hypotheses:\n${m.hypotheses.map((h) => `    - ${h}`).join("\n")}` : "";
      const cv = m.coreVariables.length > 0 ? `\n  Core variables: ${m.coreVariables.join(", ")}` : "";
      return `${tag} ORIGINAL MODEL (${x.paper.title}):\n  Summary: ${m.summary}${cv}${hyps}`;
    })
    .join("\n\n");

  // Learning loop: pull recent successful feedback (selected models with prompts) as few-shot examples
  // ACROSS the platform — this is how the AI "学习不同客户提出的需求".
  const pastFeedback = await db
    .select()
    .from(generationFeedbackTable)
    .where(isNotNull(generationFeedbackTable.selectedModelSnapshot))
    .orderBy(desc(generationFeedbackTable.updatedAt))
    .limit(8);

  const learnedBlock = pastFeedback.length > 0
    ? "\n\nLEARNED PREFERENCES FROM PAST USERS (use these as guidance for what makes a strong model — NOT as variables to copy):\n" +
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

  // Stage 2 prompt: synthesize NEW models that respect each paper's original logic.
  const prompt = `You are a senior researcher in academic methodology and structural equation modeling.

Your task: produce ${numModels} *novel* and theoretically coherent research model proposals by synthesizing across the source papers below.

PAPER REFERENCES (use exact tags when citing):
${paperRefs.map((r) => r.short).join("\n")}

EACH PAPER'S OWN RESEARCH MODEL (extracted from the paper's text — your new models MUST extend, combine, or refine these, not contradict them):
${originalModelsBlock || "(no extractable original models)"}

EXTRACTED VARIABLES (each variable is tagged with its source paper):
${variableList}
${userBlock}${focusBlock}${learnedBlock}

CRITICAL RULES (violations = invalid output):
1. **Layout**: order variables consistently as Independent → Mediator → Moderator → Dependent. Never put a dependent variable to the left of an independent variable.
2. **Synthesis, not copying**: Each model MUST combine variables from at least 2 different source papers. A model that only repeats one paper's existing model is REJECTED.
3. **Respect the originals**: When you draw an edge between two variables that both already appeared in a paper's hypothesis, use the SAME direction and sign of relationship that paper proposed. Do not flip causality.
4. **Citation grounding**: every "evidenceCitationText" MUST be a verbatim sentence either from the variable's "Citation" field or from the paper's hypotheses listed above. If you cannot find such a sentence, omit that edge.
5. **Variety**: the ${numModels} models must each have a *clearly different* theoretical focus (different DV, different mediator chain, or different moderator). Do not produce near-duplicates.
6. **Size**: 3–7 nodes and 2–6 edges per model.

Return ONLY a JSON array (no markdown, no commentary):
[
  {
    "name": "concise model name",
    "description": "1-2 sentences",
    "rationale": "3-5 sentences explaining the theoretical fit, naming paper tags (P1, P2…) and how this model extends/synthesizes their original models",
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
      max_completion_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    });

    const content = completion.choices[0]?.message?.content ?? "[]";
    let generated: Array<{ name: string; description: string; rationale: string; nodes: ModelNode[]; edges: ModelEdge[] }> = [];

    try {
      const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      generated = JSON.parse(cleaned);
    } catch {
      req.log.warn({ content }, "Failed to parse AI model generation response");
      res.status(500).json({ error: "Failed to parse AI model generation result" });
      return;
    }

    await db.delete(researchModelsTable).where(eq(researchModelsTable.sessionId, sessionId));

    const inserted = await Promise.all(
      generated.map((m) =>
        db.insert(researchModelsTable).values({
          sessionId,
          name: m.name,
          description: m.description,
          rationale: m.rationale,
          selected: "false",
          nodes: m.nodes,
          edges: m.edges,
        }).returning()
      )
    );

    // Record this generation in the learning log.
    await db.insert(generationFeedbackTable).values({
      sessionId,
      userPrompt,
      numModelsRequested: numModels,
      generatedModelNames: generated.map((m) => m.name),
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

  // Learning loop: record the user's edit on the most recent feedback row for this session.
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

  // Learning loop: record the user's selection on the most recent feedback row for this session.
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

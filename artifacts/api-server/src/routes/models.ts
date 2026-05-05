import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, researchModelsTable, variablesTable, papersTable } from "@workspace/db";
import {
  GenerateModelsParams,
  GenerateModelsBody,
  ListSessionModelsParams,
  GetModelParams,
  SelectModelParams,
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

  // Build per-paper compact reference list for citation grounding
  const paperRefs = papers
    .filter((p) => variables.some((v) => v.paperId === p.id))
    .map((p, idx) => {
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

  // Include up to ~1500 chars of full text per paper to ground edge relationships in actual evidence
  const paperExcerpts = papers
    .filter((p) => p.fullText && p.fullText.length > 200 && variables.some((v) => v.paperId === p.id))
    .slice(0, 6)
    .map((p) => {
      const tag = paperTagById.get(p.id) ?? "?";
      const text = (p.fullText ?? "").slice(0, 1500).replace(/\s+/g, " ");
      return `${tag} excerpt: ${text}`;
    })
    .join("\n\n");

  const userBlock = userPrompt
    ? `\n\nUSER REQUIREMENTS (must be followed):\n"""\n${userPrompt}\n"""\n`
    : "";
  const focusBlock = focusVariableIds.length > 0
    ? `\n\nThe user has marked the following variable IDs as priorities: ${focusVariableIds.join(", ")}. At least 2 of the 3 models MUST include these variables.`
    : "";

  const prompt = `You are an expert in academic research methodology, specifically in structural equation modeling and research design.

Your task: combine the extracted research variables below into ${numModels} *different* and theoretically coherent research model proposals that a researcher could use as the basis for a new study.

PAPER REFERENCES (use these tags exactly when citing):
${paperRefs.map((r) => r.short).join("\n")}

EXTRACTED VARIABLES (each variable's source paper tag is shown):
${variableList}

${paperExcerpts ? `RAW PAPER EXCERPTS (use these to justify relationships with EXACT quotes when possible):\n${paperExcerpts}\n` : ""}${userBlock}${focusBlock}

CRITICAL RULES:
1. Every node and every edge MUST cite a real variable ID and a real paper from the list above. Do NOT invent variables or papers.
2. The "evidenceCitationText" for each edge MUST be a *direct quote* (verbatim, in the paper's original language) from either the variable's "Citation" field or the paper's excerpt above. If you cannot find a real quote that supports the relationship, do not include that edge.
3. Mix variables from DIFFERENT papers within each model whenever possible — cross-paper synthesis is the whole point.
4. Each model should have 3-6 nodes and 2-5 edges and a clearly different theoretical focus.
5. Output ONLY valid JSON, no markdown fences, no commentary.

Return a JSON array with exactly ${numModels} model(s):
[
  {
    "name": "concise model name",
    "description": "1-2 sentence description of what this model investigates",
    "rationale": "2-4 sentences explaining why these variables and relationships fit together theoretically. Reference paper tags like P1, P2.",
    "nodes": [
      {
        "variableId": <integer from list above>,
        "variableName": "<exact name>",
        "type": "independent|mediator|moderator|dependent",
        "paperId": <integer>,
        "paperTitle": "<title>",
        "paperAuthors": ["<author>"],
        "paperYear": <year or null>
      }
    ],
    "edges": [
      {
        "fromVariableId": <id>,
        "toVariableId": <id>,
        "fromVariableName": "<name>",
        "toVariableName": "<name>",
        "relationship": "positive|negative|moderates|mediates",
        "evidencePaperId": <paper id>,
        "evidencePaperTitle": "<title>",
        "evidencePaperAuthors": ["<author>"],
        "evidencePaperYear": <year or null>,
        "evidenceCitationText": "<verbatim quote from the paper that supports this relationship>"
      }
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

  res.json(formatModel(updated));
});

export default router;

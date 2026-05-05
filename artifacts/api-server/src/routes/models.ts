import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, researchModelsTable, variablesTable, papersTable } from "@workspace/db";
import {
  GenerateModelsParams,
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

  const sessionId = params.data.id;

  const variables = await db
    .select()
    .from(variablesTable)
    .where(eq(variablesTable.sessionId, sessionId));

  if (variables.length < 2) {
    res.status(400).json({ error: "Need at least 2 extracted variables to generate models. Please extract variables from papers first." });
    return;
  }

  const paperIds = [...new Set(variables.map((v) => v.paperId))];
  const papers = await db.select().from(papersTable).where(eq(papersTable.sessionId, sessionId));
  const paperMap = new Map(papers.map((p) => [p.id, p]));

  const variableList = variables.map((v) => {
    const paper = paperMap.get(v.paperId);
    return `- ID:${v.id} | Name: "${v.name}" | Type: ${v.type} | From paper: "${paper?.title}" (${paper?.authors.join(", ")}, ${paper?.year}) | Definition: ${v.definition} | Citation: "${v.citationText}"`;
  }).join("\n");

  const prompt = `You are an expert in academic research methodology, specifically in structural equation modeling and research design.

Below are research variables extracted from multiple academic papers. Your task is to combine them into 3 different new research model proposals that a researcher could use as a basis for a new study.

Variables:
${variableList}

For each proposed model:
1. Select a meaningful combination of variables (mix from different papers where possible)
2. Create a name that reflects the model's theoretical focus
3. Provide a description of the model
4. Provide a rationale for why these variables work together
5. Define the relationships (edges) between variables with evidence from the source papers

Return a JSON array with exactly 3 models using this structure:
[
  {
    "name": "Model Name",
    "description": "Description of what this model investigates",
    "rationale": "Why these variables and relationships form a coherent model",
    "nodes": [
      {
        "variableId": <number from ID above>,
        "variableName": "<variable name>",
        "type": "independent|mediator|moderator|dependent",
        "paperId": <paper id>,
        "paperTitle": "<paper title>",
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
        "evidenceCitationText": "<a sentence from the paper justifying this relationship>"
      }
    ]
  }
]

Only return valid JSON. Each model should have 3-6 nodes and 2-5 edges. Use real variable IDs from the list above.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 8192,
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

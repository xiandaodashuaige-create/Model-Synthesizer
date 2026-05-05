import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, variablesTable, papersTable } from "@workspace/db";
import {
  ExtractVariablesParams,
  ListSessionVariablesParams,
  GetVariableGraphParams,
} from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";

const router: IRouter = Router();

function formatVariable(v: typeof variablesTable.$inferSelect, paper: typeof papersTable.$inferSelect) {
  return {
    id: v.id,
    sessionId: v.sessionId,
    paperId: v.paperId,
    paperTitle: paper.title,
    paperAuthors: paper.authors,
    paperYear: paper.year,
    name: v.name,
    type: v.type,
    definition: v.definition,
    citationText: v.citationText,
    createdAt: v.createdAt.toISOString(),
  };
}

router.post("/sessions/:id/papers/:paperId/extract", async (req, res): Promise<void> => {
  const params = ExtractVariablesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [paper] = await db
    .select()
    .from(papersTable)
    .where(and(eq(papersTable.id, params.data.paperId), eq(papersTable.sessionId, params.data.id)));

  if (!paper) {
    res.status(404).json({ error: "Paper not found" });
    return;
  }

  // Prefer full text (uploaded PDF) when available — gives the LLM far richer context than just the abstract.
  const baseHeader = `Title: ${paper.title}\nAuthors: ${paper.authors.join(", ")} (${paper.year ?? "unknown year"})`;
  const paperContext = paper.fullText && paper.fullText.length > 500
    ? `${baseHeader}\nFull text (truncated to keep within token limits):\n${paper.fullText.slice(0, 30000)}`
    : `${baseHeader}\nAbstract: ${paper.abstract ?? "No abstract available"}`;

  const prompt = `You are a research methodology expert. Analyze this academic paper and extract the research variables from its theoretical model.

Paper:
${paperContext}

Extract all research variables mentioned in this paper. For each variable, identify:
1. The variable name
2. Its type: "independent" (predictor/antecedent), "mediator" (intermediate), "moderator" (boundary condition), or "dependent" (outcome)
3. A brief definition of the variable in the context of this paper
4. A representative citation sentence from the paper that supports this variable's role

Return a JSON array with this exact format:
[
  {
    "name": "Variable Name",
    "type": "independent|mediator|moderator|dependent",
    "definition": "Brief definition of this variable",
    "citationText": "A sentence from the paper describing or justifying this variable"
  }
]

Only return valid JSON, no other text. Extract 3-8 key variables.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });

    const content = completion.choices[0]?.message?.content ?? "[]";
    let extracted: Array<{ name: string; type: string; definition: string; citationText: string }> = [];

    try {
      const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      extracted = JSON.parse(cleaned);
    } catch {
      req.log.warn({ content }, "Failed to parse AI response as JSON");
      res.status(500).json({ error: "Failed to parse AI extraction result" });
      return;
    }

    await db.delete(variablesTable).where(and(eq(variablesTable.paperId, paper.id), eq(variablesTable.sessionId, params.data.id)));

    const inserted = await Promise.all(
      extracted.map((v) =>
        db.insert(variablesTable).values({
          sessionId: params.data.id,
          paperId: paper.id,
          name: v.name,
          type: v.type,
          definition: v.definition,
          citationText: v.citationText,
        }).returning()
      )
    );

    await db.update(papersTable).set({ extracted: "true" }).where(eq(papersTable.id, paper.id));

    res.json(inserted.flat().map((v) => formatVariable(v, paper)));
  } catch (err) {
    req.log.error({ err }, "Error extracting variables");
    res.status(500).json({ error: "Failed to extract variables" });
  }
});

router.get("/sessions/:id/variables", async (req, res): Promise<void> => {
  const params = ListSessionVariablesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const variables = await db
    .select()
    .from(variablesTable)
    .where(eq(variablesTable.sessionId, params.data.id))
    .orderBy(variablesTable.type, variablesTable.createdAt);

  const paperIds = [...new Set(variables.map((v) => v.paperId))];
  const papers = await Promise.all(
    paperIds.map((id) => db.select().from(papersTable).where(eq(papersTable.id, id)).limit(1))
  );
  const paperMap = new Map(papers.flat().map((p) => [p.id, p]));

  res.json(
    variables.map((v) => {
      const paper = paperMap.get(v.paperId)!;
      return formatVariable(v, paper);
    })
  );
});

router.get("/sessions/:id/variable-graph", async (req, res): Promise<void> => {
  const params = GetVariableGraphParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const variables = await db
    .select()
    .from(variablesTable)
    .where(eq(variablesTable.sessionId, params.data.id));

  const papers = await db
    .select()
    .from(papersTable)
    .where(eq(papersTable.sessionId, params.data.id));
  const paperMap = new Map(papers.map((p) => [p.id, p]));

  const nodeMap = new Map<string, { id: string; label: string; type: string; paperCount: number }>();
  for (const v of variables) {
    const key = v.name.toLowerCase().trim();
    if (nodeMap.has(key)) {
      nodeMap.get(key)!.paperCount++;
    } else {
      nodeMap.set(key, { id: key, label: v.name, type: v.type, paperCount: 1 });
    }
  }

  const edges: Array<{ source: string; target: string; paperId: number; paperTitle: string }> = [];
  const byPaper = new Map<number, typeof variables>();
  for (const v of variables) {
    if (!byPaper.has(v.paperId)) byPaper.set(v.paperId, []);
    byPaper.get(v.paperId)!.push(v);
  }

  for (const [paperId, pvars] of byPaper) {
    const paper = paperMap.get(paperId);
    if (!paper) continue;
    const independents = pvars.filter((v) => v.type === "independent");
    const dependents = pvars.filter((v) => v.type === "dependent");
    const mediators = pvars.filter((v) => v.type === "mediator");
    for (const ind of independents) {
      for (const dep of dependents) {
        edges.push({ source: ind.name.toLowerCase().trim(), target: dep.name.toLowerCase().trim(), paperId, paperTitle: paper.title });
      }
      for (const med of mediators) {
        edges.push({ source: ind.name.toLowerCase().trim(), target: med.name.toLowerCase().trim(), paperId, paperTitle: paper.title });
      }
    }
    for (const med of mediators) {
      for (const dep of dependents) {
        edges.push({ source: med.name.toLowerCase().trim(), target: dep.name.toLowerCase().trim(), paperId, paperTitle: paper.title });
      }
    }
  }

  res.json({ nodes: [...nodeMap.values()], edges });
});

export default router;

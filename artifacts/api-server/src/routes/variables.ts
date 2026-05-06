import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, variablesTable, papersTable, paperHypothesesTable } from "@workspace/db";
import {
  ExtractVariablesParams,
  ListSessionVariablesParams,
  GetVariableGraphParams,
} from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { CONSTRUCT_LAYERS } from "../lib/theoryTemplates.js";

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
    canonicalConstructId: v.canonicalConstructId,
    constructLayer: v.constructLayer,
    createdAt: v.createdAt.toISOString(),
  };
}

// Lightweight canonicalization: strip whitespace, lowercase, remove "perceived/the/a/...".
// Two variables across papers that normalize to the same string get the SAME canonical id.
// (For now we use a string-equality scheme; embedding-based merging is a follow-up.)
function canonicalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^(perceived|the|a|an)\s+/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim();
}

const VALID_LAYERS = new Set<string>(CONSTRUCT_LAYERS as readonly string[]);

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

  const baseHeader = `Title: ${paper.title}\nAuthors: ${paper.authors.join(", ")} (${paper.year ?? "unknown year"})`;
  const paperContext = paper.fullText && paper.fullText.length > 500
    ? `${baseHeader}\nFull text (truncated to keep within token limits):\n${paper.fullText.slice(0, 30000)}`
    : `${baseHeader}\nAbstract: ${paper.abstract ?? "No abstract available"}`;

  const prompt = `You are a research methodology expert. Analyze this academic paper and extract BOTH (a) the research variables AND (b) the formal hypotheses (H1, H2, ...).

Paper:
${paperContext}

Return ONLY this JSON (no markdown, no commentary):
{
  "variables": [
    {
      "name": "Variable Name",
      "type": "independent|mediator|moderator|dependent",
      "definition": "Brief definition in this paper's context",
      "citationText": "A verbatim sentence from the paper supporting this variable",
      "canonicalConstruct": "lower-case canonical construct name, stripped of 'perceived/the/a' (e.g. 'trust', 'purchase intention', 'self-efficacy'). Use the SAME string for the same theoretical construct across papers.",
      "constructLayer": "stimulus|cognitive|affective|intention|behavior — which step of the standard psychology pipeline this variable occupies. (stimulus = external cue; cognitive = belief/expectancy; affective = feeling/attitude; intention = stated willingness; behavior = enacted action/outcome.)"
    }
  ],
  "hypotheses": [
    {
      "id": "H1",
      "from": "<variable name as in 'variables'>",
      "to": "<variable name as in 'variables'>",
      "via": "<mediator name if this is a mediated/moderated hypothesis, else null>",
      "relationship": "positive|negative|moderates|mediates",
      "statement": "Verbatim hypothesis sentence from the paper",
      "effectSize": "<reported coefficient/p-value/CI like 'β=.34, p<.001' or null if not stated>",
      "pageOrSection": "<page number or section heading where the hypothesis is stated, or null>"
    }
  ]
}

Strict rules:
- Extract 3-8 variables and 0-12 hypotheses.
- Every hypothesis "from"/"to"/"via" MUST exactly match a "name" in "variables".
- "constructLayer" is REQUIRED for every variable. If unclear, use the closest fit; never leave it blank.
- "canonicalConstruct" is REQUIRED — use a short, generic, lowercased construct name (e.g. "trust", not "consumer trust in AI streamer").
- "statement" / "citationText" must be COPIED verbatim from the paper.
- If the paper states no formal hypotheses (e.g. exploratory paper), return "hypotheses": [] (do not invent).`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 3500,
      messages: [{ role: "user", content: prompt }],
    });

    const content = completion.choices[0]?.message?.content ?? "{}";
    let parsed: {
      variables?: Array<{ name: string; type: string; definition: string; citationText: string; canonicalConstruct?: string; constructLayer?: string }>;
      hypotheses?: Array<{ id: string; from: string; to: string; via?: string | null; relationship: string; statement: string; effectSize?: string | null; pageOrSection?: string | null }>;
    } = {};

    try {
      const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      parsed = JSON.parse(cleaned);
      // Backwards-compat: previous prompt returned a bare array.
      if (Array.isArray(parsed)) parsed = { variables: parsed as typeof parsed.variables, hypotheses: [] };
    } catch {
      req.log.warn({ content }, "Failed to parse AI extraction JSON");
      res.status(500).json({ error: "Failed to parse AI extraction result" });
      return;
    }

    const extractedVars = Array.isArray(parsed.variables) ? parsed.variables : [];
    const extractedHyps = Array.isArray(parsed.hypotheses) ? parsed.hypotheses : [];

    if (extractedVars.length === 0) {
      res.status(422).json({ error: "AI returned no variables" });
      return;
    }

    // Wrap delete + insert + update in a single transaction so we never end up
    // with partial state (e.g. variables wiped but the new ones never inserted).
    const inserted = await db.transaction(async (tx) => {
      await tx.delete(variablesTable).where(and(eq(variablesTable.paperId, paper.id), eq(variablesTable.sessionId, params.data.id)));
      await tx.delete(paperHypothesesTable).where(and(eq(paperHypothesesTable.paperId, paper.id), eq(paperHypothesesTable.sessionId, params.data.id)));

      const insertedRows = await Promise.all(
        extractedVars.map((v) => {
          const layerRaw = (v.constructLayer ?? "").toLowerCase().trim();
          const layer = VALID_LAYERS.has(layerRaw) ? layerRaw : null;
          const canonical = (v.canonicalConstruct && v.canonicalConstruct.trim().length > 0)
            ? canonicalize(v.canonicalConstruct)
            : canonicalize(v.name);
          return tx.insert(variablesTable).values({
            sessionId: params.data.id,
            paperId: paper.id,
            name: v.name,
            type: v.type,
            definition: v.definition,
            citationText: v.citationText,
            canonicalConstructId: canonical,
            constructLayer: layer,
          }).returning();
        })
      );

      if (extractedHyps.length > 0) {
        const hypRows = extractedHyps
          .filter((h) => h && typeof h.id === "string" && typeof h.from === "string" && typeof h.to === "string" && typeof h.statement === "string" && h.statement.trim().length >= 8)
          .slice(0, 20)
          .map((h) => ({
            sessionId: params.data.id,
            paperId: paper.id,
            hypothesisId: h.id.trim().slice(0, 32),
            fromVariable: h.from.trim(),
            toVariable: h.to.trim(),
            viaVariable: h.via ? String(h.via).trim() : null,
            relationship: ["positive", "negative", "moderates", "mediates"].includes(h.relationship) ? h.relationship : "positive",
            statement: h.statement.trim(),
            effectSize: h.effectSize ? String(h.effectSize).trim().slice(0, 200) : null,
            pageOrSection: h.pageOrSection ? String(h.pageOrSection).trim().slice(0, 120) : null,
          }));
        if (hypRows.length > 0) {
          await tx.insert(paperHypothesesTable).values(hypRows).onConflictDoNothing();
        }
      }

      await tx.update(papersTable).set({ extracted: "true" }).where(eq(papersTable.id, paper.id));
      return insertedRows;
    });

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

router.get("/sessions/:id/hypotheses", async (req, res): Promise<void> => {
  const params = ListSessionVariablesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(paperHypothesesTable)
    .where(eq(paperHypothesesTable.sessionId, params.data.id))
    .orderBy(paperHypothesesTable.paperId, paperHypothesesTable.hypothesisId);
  const paperIds = [...new Set(rows.map((r) => r.paperId))];
  const papers = await Promise.all(
    paperIds.map((id) => db.select().from(papersTable).where(eq(papersTable.id, id)).limit(1)),
  );
  const paperMap = new Map(papers.flat().map((p) => [p.id, p]));
  res.json(rows.map((r) => {
    const p = paperMap.get(r.paperId);
    return {
      id: r.id,
      sessionId: r.sessionId,
      paperId: r.paperId,
      paperTitle: p?.title ?? "",
      paperAuthors: p?.authors ?? [],
      paperYear: p?.year ?? null,
      hypothesisId: r.hypothesisId,
      fromVariable: r.fromVariable,
      toVariable: r.toVariable,
      viaVariable: r.viaVariable,
      relationship: r.relationship,
      statement: r.statement,
      effectSize: r.effectSize,
      pageOrSection: r.pageOrSection,
      createdAt: r.createdAt.toISOString(),
    };
  }));
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

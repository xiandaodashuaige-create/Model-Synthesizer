import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, variablesTable, papersTable, paperHypothesesTable } from "@workspace/db";
import {
  ExtractVariablesParams,
  ListSessionVariablesParams,
  GetVariableGraphParams,
} from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logAiUsageFromOpenAI } from "../lib/ai-usage";
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
  // Unicode-aware: keep letters/numbers from any script (incl. CJK) plus
  // whitespace and hyphens. The previous `\w` was ASCII-only, so Chinese
  // construct names like "感知信任" got stripped to empty — every Chinese
  // variable then collapsed to the SAME canonical id and the variable graph
  // showed false "shared variable" overlaps across papers.
  // NFKC normalization first so visually-identical CJK characters with
  // different code-point compositions (e.g. composed vs decomposed, fullwidth
  // vs halfwidth latin) collapse to the same canonical form.
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^(perceived|the|a|an)\s+/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
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

  const prompt = `You are a research methodology expert. Analyze this academic paper and extract BOTH (a) the research variables AND (b) every directional relationship the paper STATES between them.

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
      "id": "H1 / R1 / A1 — use the paper's label if it has one (H1, H2a, ...); otherwise number them R1, R2, R3 for relationships you derived from the abstract/results.",
      "from": "<variable name as in 'variables'>",
      "to": "<variable name as in 'variables'>",
      "via": "<mediator name if this is a mediated/moderated relationship, else null>",
      "relationship": "positive|negative|moderates|mediates",
      "statement": "Verbatim sentence from the paper supporting this relationship",
      "effectSize": "<reported coefficient/p-value/CI like 'β=.34, p<.001' or null if not stated>",
      "pageOrSection": "<page number or section heading, or null>"
    }
  ]
}

What counts as a relationship (extract ALL of these — do NOT limit to formally labeled hypotheses):
1. Formal hypotheses (H1, H2a, ...).
2. Sentences in the abstract that assert a directional effect, e.g. "X positively predicts Y", "A increases B", "C reduces D", "E mediates the effect of F on G", "H moderates the relationship between I and J".
3. Reported empirical findings stating a relationship between two of the extracted variables, e.g. "Trust significantly increased purchase intention (β = .42, p < .001)".
4. Theoretical claims in the introduction/discussion that tie two of the extracted variables together with a stated direction.

Strict rules:
- Extract 3-8 variables and up to 20 relationships.
- Every relationship's "from"/"to"/"via" MUST exactly match a "name" in "variables". If a sentence ties together a variable you didn't extract, either add that variable to "variables" or skip the relationship.
- "constructLayer" is REQUIRED for every variable. If unclear, use the closest fit; never leave it blank.
- "canonicalConstruct" is REQUIRED — use a short, generic, lowercased construct name (e.g. "trust", not "consumer trust in AI streamer").
- "statement" / "citationText" must be COPIED verbatim from the paper — do NOT paraphrase or invent.
- "relationship": use "moderates" when the source is a moderator on a path; "mediates" when the source is a mediator; "positive" / "negative" for direct effects with the stated sign. If the sign is unclear from the sentence, default to "positive".
- If the paper genuinely states NO directional relationships between the extracted variables (e.g. a pure descriptive review with no claims), return "hypotheses": []. Otherwise extract them — do not return [] just because the paper lacks H1/H2 labels.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 3500,
      messages: [{ role: "user", content: prompt }],
    });
    logAiUsageFromOpenAI(completion, { route: "variables/extract", sessionId: paper.sessionId });

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

// Manual rename / retype / delete of a variable. The AI's first-pass extraction
// is good but not perfect — researchers often want to:
//   - rename a variable that the AI named awkwardly ("perceived enjoyment" → "enjoyment")
//   - re-classify a borderline mediator/independent
//   - delete an outright bad extraction (e.g. AI hallucinated a control variable)
// without re-running extraction on the whole paper. These routes give them
// that escape hatch. Everything else (variable-graph, models, live model)
// reads variables on demand, so updates are picked up automatically.
router.patch("/sessions/:id/variables/:variableId", async (req, res): Promise<void> => {
  const sessionId = parseInt(req.params.id, 10);
  const variableId = parseInt(req.params.variableId, 10);
  if (!Number.isFinite(sessionId) || !Number.isFinite(variableId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = req.body ?? {};
  const patch: { name?: string; type?: string; definition?: string } = {};
  if (typeof body.name === "string" && body.name.trim().length > 0) patch.name = body.name.trim().slice(0, 200);
  if (typeof body.type === "string" && ["independent", "mediator", "moderator", "dependent"].includes(body.type)) patch.type = body.type;
  if (typeof body.definition === "string") patch.definition = body.definition.trim().slice(0, 2000);
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No supported fields to update" });
    return;
  }
  // Recompute canonical id when the name changes so downstream "shared variable"
  // detection picks up the rename.
  const updateValues: Record<string, unknown> = { ...patch };
  if (patch.name) updateValues.canonicalConstructId = canonicalize(patch.name);
  const result = await db
    .update(variablesTable)
    .set(updateValues)
    .where(and(eq(variablesTable.sessionId, sessionId), eq(variablesTable.id, variableId)))
    .returning();
  if (result.length === 0) {
    res.status(404).json({ error: "Variable not found" });
    return;
  }
  const v = result[0];
  const [paper] = await db.select().from(papersTable).where(eq(papersTable.id, v.paperId)).limit(1);
  if (!paper) {
    res.status(500).json({ error: "Variable's paper missing" });
    return;
  }
  res.json(formatVariable(v, paper));
});

router.delete("/sessions/:id/variables/:variableId", async (req, res): Promise<void> => {
  const sessionId = parseInt(req.params.id, 10);
  const variableId = parseInt(req.params.variableId, 10);
  if (!Number.isFinite(sessionId) || !Number.isFinite(variableId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const result = await db
    .delete(variablesTable)
    .where(and(eq(variablesTable.sessionId, sessionId), eq(variablesTable.id, variableId)))
    .returning({ id: variablesTable.id });
  if (result.length === 0) {
    res.status(404).json({ error: "Variable not found" });
    return;
  }
  res.json({ ok: true });
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

  // Edges come ONLY from real relationships extracted from each paper
  // (paper_hypotheses table). We do NOT synthesize edges by taking the
  // cartesian product of variable types — that would invent relationships
  // the paper never actually states.
  const hypotheses = await db
    .select()
    .from(paperHypothesesTable)
    .where(eq(paperHypothesesTable.sessionId, params.data.id));

  const norm = (s: string) => s.toLowerCase().trim();
  type EdgeRel = "positive" | "negative" | "moderates" | "mediates";
  const edges: Array<{ source: string; target: string; paperId: number; paperTitle: string; relationship: EdgeRel; statement: string }> = [];
  const seen = new Set<string>();
  const pushEdge = (src: string, tgt: string, paperId: number, paperTitle: string, relationship: EdgeRel, statement: string) => {
    if (!src || !tgt || src === tgt) return;
    if (!nodeMap.has(src) || !nodeMap.has(tgt)) return; // skip if endpoint isn't a known variable
    const k = `${src}->${tgt}|${relationship}|${paperId}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ source: src, target: tgt, paperId, paperTitle, relationship, statement });
  };

  const isRel = (r: string): r is EdgeRel => r === "positive" || r === "negative" || r === "moderates" || r === "mediates";

  for (const h of hypotheses) {
    const paper = paperMap.get(h.paperId);
    if (!paper) continue;
    const from = norm(h.fromVariable);
    const to = norm(h.toVariable);
    const via = h.viaVariable ? norm(h.viaVariable) : null;
    const rel: EdgeRel = isRel(h.relationship) ? h.relationship : "positive";
    if (via && nodeMap.has(via)) {
      // Mediation chain: from → via → to (label both legs as "mediates")
      pushEdge(from, via, h.paperId, paper.title, "mediates", h.statement);
      pushEdge(via, to, h.paperId, paper.title, "mediates", h.statement);
    } else {
      pushEdge(from, to, h.paperId, paper.title, rel, h.statement);
    }
  }

  res.json({ nodes: [...nodeMap.values()], edges });
});

export default router;

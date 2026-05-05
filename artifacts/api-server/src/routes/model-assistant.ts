import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, papersTable, variablesTable, researchModelsTable } from "@workspace/db";
import { ChatModelAssistantParams, ChatModelAssistantBody } from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { backbonesAsPromptBlock, operatorsAsPromptBlock } from "../lib/theoryTemplates.js";

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

  // Build session context: papers, variables, existing models.
  const [papers, variables, models] = await Promise.all([
    db.select().from(papersTable).where(eq(papersTable.sessionId, sessionId)),
    db.select().from(variablesTable).where(eq(variablesTable.sessionId, sessionId)),
    db.select().from(researchModelsTable).where(eq(researchModelsTable.sessionId, sessionId)),
  ]);

  if (variables.length === 0) {
    res.json({
      reply: "目前这个项目里还没有提取出任何变量。请先回到『提取变量』那一步，让 AI 把论文里的研究变量识别出来，我才能帮你设计模型组合方案。",
    });
    return;
  }

  const paperLines = papers.map((p, i) => {
    const tag = `P${i + 1}`;
    const authors = (p.authors ?? []).slice(0, 2).join(", ");
    return `  - id=${p.id} ${tag}: ${p.title} (${authors}${p.year ? `, ${p.year}` : ""})`;
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

================ SESSION CONTEXT ================
PAPERS (${papers.length}):
${paperLines || "  (none)"}

VARIABLES (${variables.length}):
${varLines}

EXISTING GENERATED MODELS:
${existingModelLines}

AVAILABLE STRUCTURAL OPERATORS:
${operatorsAsPromptBlock()}

AVAILABLE THEORY BACKBONES:
${backbonesAsPromptBlock()}
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
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 2400,
      messages: oaMessages as any,
    });

    const raw = completion.choices[0]?.message?.content ?? "";

    // Extract optional ```suggestion {...}``` block.
    let reply = raw;
    let suggestion: { userPrompt?: string; focusVariableIds?: number[]; requiredOperators?: string[] } | undefined;
    const m = raw.match(/```suggestion\s*([\s\S]*?)```/i);
    if (m) {
      try {
        const parsed = JSON.parse(m[1].trim());
        // Defensive cleaning.
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
        reply = raw.replace(m[0], "").trim();
      } catch (err) {
        req.log.warn({ err, block: m[1] }, "Failed to parse suggestion block");
      }
    }

    res.json({ reply, suggestion });
  } catch (err) {
    req.log.error({ err }, "Model assistant chat failed");
    res.status(500).json({ error: "Assistant failed to respond" });
  }
});

export default router;

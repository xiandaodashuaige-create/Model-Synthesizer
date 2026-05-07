import { eq, and } from "drizzle-orm";
import { db, variablesTable, papersTable, paperHypothesesTable, sessionsTable } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { normalizeName } from "@workspace/canonicalize";
import { logAiUsageFromOpenAI } from "./ai-usage.js";
import { scheduleLandscapeRebuild } from "./literature-landscape.js";
import { CONSTRUCT_LAYERS } from "./theoryTemplates.js";

type Paper = typeof papersTable.$inferSelect;
type Variable = typeof variablesTable.$inferSelect;

// Behavioral / applied-domain terms used as a server-side corroboration
// signal for the SCOPE CHECK gate. A paper that names NONE of these in its
// title/abstract AND emits NONE of them as variable constructs is unlikely
// to belong to an applied behavioral session (consumer / user / live
// commerce / human-AI interaction etc). Used only to confirm a high-confidence
// out_of_scope verdict already issued by the AI — never to overrule an
// in_scope verdict, so cross-domain theoretical-migration papers are safe.
const BEHAVIORAL_DOMAIN_TERMS = [
  "consumer", "customer", "user", "audience", "viewer", "shopper",
  "behavior", "behaviour", "intention", "trust", "satisfaction",
  "attitude", "perception", "perceived", "adoption", "engagement",
  "loyalty", "experience", "purchase", "buying", "wtb", "wom",
  "livestream", "live stream", "live-stream", "live commerce",
  "streamer", "broadcaster", "influencer", "anchor",
  "parasocial", "anthropomorph", "social presence", "warmth",
];

export type ScopeStatus = "in_scope" | "out_of_scope" | "uncertain";

interface MinimalLogger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const VALID_LAYERS = new Set<string>(CONSTRUCT_LAYERS as readonly string[]);
const VALID_GAP_TYPES = new Set(["mechanism", "boundary", "integration", "correction", "construct", "context"]);

function canonicalize(name: string): string {
  return normalizeName(name);
}

export class ExtractionError extends Error {
  code: "parse_failed" | "no_variables" | "timeout" | "unknown";
  status: number;
  constructor(code: ExtractionError["code"], message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function tryRepairTruncatedJson(raw: string): string | null {
  if (!raw || raw[0] !== "{") return null;
  const stack: Array<"{" | "["> = [];
  let inStr = false;
  let escape = false;
  let lastSafeEnd = -1;
  let lastCommaInArray = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === "\\") { escape = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") { stack.push(c); continue; }
    if (c === "}" || c === "]") {
      stack.pop();
      if (stack.length === 1) lastSafeEnd = i + 1;
    }
    if (c === "," && stack.length >= 2 && stack[stack.length - 1] === "[") {
      lastCommaInArray = i;
    }
  }
  if (lastCommaInArray < 0 && lastSafeEnd < 0) return null;
  const cutAt = lastCommaInArray > 0 ? lastCommaInArray : lastSafeEnd;
  let head = raw.slice(0, cutAt);
  const openStack: string[] = [];
  let s2 = false, esc2 = false;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (esc2) { esc2 = false; continue; }
    if (s2) {
      if (c === "\\") { esc2 = true; continue; }
      if (c === '"') s2 = false;
      continue;
    }
    if (c === '"') { s2 = true; continue; }
    if (c === "{" || c === "[") openStack.push(c);
    else if (c === "}" || c === "]") openStack.pop();
  }
  while (openStack.length > 0) {
    const top = openStack.pop();
    head += top === "{" ? "}" : "]";
  }
  return head;
}

export function buildExtractionPrompt(paper: Paper, sessionTopic: string): string {
  const baseHeader = `Title: ${paper.title}\nAuthors: ${paper.authors.join(", ")} (${paper.year ?? "unknown year"})`;
  const paperContext = paper.fullText && paper.fullText.length > 500
    ? `${baseHeader}\nFull text (truncated to keep within token limits):\n${paper.fullText.slice(0, 30000)}`
    : `${baseHeader}\nAbstract: ${paper.abstract ?? "No abstract available"}`;

  const topicBlock = sessionTopic && sessionTopic.trim().length > 0
    ? sessionTopic.trim().slice(0, 600)
    : "(no session topic provided)";

  return `You are a research methodology expert. Analyze this academic paper and extract BOTH (a) the research variables AND (b) every directional relationship the paper STATES between them.

SESSION TOPIC:
${topicBlock}

STEP 0 — SCOPE CHECK (do this BEFORE extracting variables).
Decide whether this paper is SUBSTANTIVELY about the session topic. Be strict:
- Generic mention of "AI" is NOT enough. The paper must match the APPLIED context (e.g. an AI-broadcaster / live-commerce / consumer-behavior session needs an applied human-AI interaction or consumer paper — a distributed-systems / networking / hardware paper that happens to ship "for AI workloads" is NOT in scope).
- A theoretical paper from a NEIGHBORING applied domain (e.g. a tourism / education / healthcare paper that uses constructs the topic also cares about, like trust or anthropomorphism) is "uncertain" — NOT out_of_scope. Cross-domain theoretical migration is valuable.
- Only return "out_of_scope" when the paper's research object is in a clearly different field (engineering / networking / pure ML benchmarking / unrelated medicine etc) AND its variables would not plausibly inform the topic.
If you return "out_of_scope", you MUST return variables: [] and hypotheses: []. Do NOT extract technical terms (algorithms, protocols, system components) as research variables.

Paper:
${paperContext}

Return ONLY this JSON (no markdown, no commentary):
{
  "scopeCheck": {
    "status": "in_scope|out_of_scope|uncertain",
    "topicFitScore": 0-100,    // semantic FIT to the SESSION TOPIC. 100 = paper's research object/variables match the topic perfectly. 0 = clearly different field. Independent of 'confidence'.
    "confidence": 0-100,        // your confidence in the 'status' verdict ITSELF. e.g. an obvious distributed-systems paper → status:'out_of_scope', topicFitScore:5, confidence:95. A borderline tourism paper using 'trust' → status:'uncertain', topicFitScore:40, confidence:90 (you are very sure it's borderline).
    "reason": "One short sentence explaining the verdict.",
    "matchedTopicTerms": ["..."],
    "mismatchedSignals": ["..."]
  },
  "variables": [
    {
      "name": "Variable Name AS THIS PAPER USES IT — keep the domain qualifier (e.g. 'chatbot anthropomorphism', NOT 'anthropomorphism'; 'AI chatbot empathy', NOT 'empathy'; 'perceived chatbot competence', NOT 'competence'). Strip ONLY filler words like leading 'the/a/an'.",
      "type": "independent|mediator|moderator|dependent",
      "definition": "Brief definition in this paper's context",
      "citationText": "A verbatim sentence from the paper supporting this variable",
      "canonicalConstruct": "Short, generic, lower-case construct name with the domain stripped, used to merge the SAME construct across papers (e.g. 'anthropomorphism', 'empathy', 'trust', 'purchase intention', 'self-efficacy'). This is DIFFERENT from 'name' — 'name' keeps the paper's wording, 'canonicalConstruct' is the bare theoretical label.",
      "constructLayer": "stimulus|cognitive|affective|intention|behavior — which step of the standard psychology pipeline this variable occupies. (stimulus = external cue / system feature / design characteristic; cognitive = belief/expectancy/perception; affective = feeling/attitude/emotion; intention = stated willingness; behavior = enacted action/outcome.)"
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
  ],
  "theoryBackbone": [
    {
      "name": "Named theory the paper anchors on, in standard textbook form (e.g. 'Theory of Planned Behavior', 'Stimulus-Organism-Response', 'Technology Acceptance Model', 'Social Exchange Theory', 'Parasocial Interaction Theory'). Do NOT invent ad-hoc names — only emit a row when the paper itself names a theory or framework.",
      "role": "primary|secondary",
      "citationText": "Verbatim sentence where the paper names the theory, or null if cited only by author-year reference"
    }
  ],
  "statedGaps": [
    {
      "type": "mechanism|boundary|integration|correction|construct|context",
      "statement": "Verbatim sentence where the AUTHORS describe the gap they say their study addresses (introduction or discussion). Do NOT paraphrase. Do NOT emit gaps you inferred — only ones explicitly stated.",
      "pageOrSection": "<page number or section heading, or null>"
    }
  ],
  "studyContext": {
    "objectType": "What the paper STUDIES (the concrete object/agent/setting), in 1-3 lower-case words. Examples: 'ai streamer', 'chatbot', 'voice assistant', 'recommender system', 'metaverse retail', 'short-video commerce', 'live streaming', 'virtual influencer', 'autonomous vehicle'. REQUIRED.",
    "sampleType": "consumer|student|employee|patient|expert|other or null",
    "geography": "Country / region of the sample, or null if not reported",
    "platform": "Specific platform if applicable (e.g. 'TikTok', 'Taobao Live', 'ChatGPT'), or null",
    "modality": "text|voice|video|multimodal|vr|ar or null",
    "language": "Primary stimulus language (e.g. 'English', 'Chinese'), or null"
  }
}

What counts as a VARIABLE — be GENEROUS, not stingy. A variable is anything the paper:
- formally labels as a construct, factor, dimension, characteristic, feature, attribute, cue, quality, or trait;
- treats as an antecedent, predictor, manipulation, moderator, mediator, or outcome;
- operationalizes with a measurement scale, a manipulation check, or a stimulus condition.

CRITICAL — system / agent / technology characteristics ARE independent variables.
For papers about AI, chatbots, conversational agents, voice assistants, recommendation systems, AR/VR, livestreaming, or any human–technology interaction, the characteristics OF the system are the most important independent (stimulus-layer) variables. Do NOT skip them and jump straight to generic outcomes like "trust" or "satisfaction". Examples of stimulus-layer IVs that MUST be extracted when the paper discusses them:
- chatbot/AI: anthropomorphism, humanlikeness, empathy, warmth, competence, social presence, conversational style, response speed, personalization, interactivity, transparency/explainability, voice, avatar realism, gender/persona, error handling, proactivity, self-disclosure, identity disclosure (human vs AI), dialogue script type, message framing
- recommendation / livestream: explanation type, source credibility, parasocial cues, product information richness, streamer attractiveness, scarcity cues
- VR/AR/metaverse: immersion, telepresence, embodiment, visual fidelity

If the paper talks about "the design of the chatbot", "characteristics of the AI agent", "features of the system", "qualities of the assistant", "cues of the streamer" — those are independent variables. Extract each one as a separate row.

CRITICAL — UMBRELLA / NAMED-ENTITY CONSTRUCT (read carefully).
When the paper studies a NAMED system, agent, context, or stimulus as its central object — e.g. "AI broadcast(er) / AI 主播", "AI streamer / virtual streamer / virtual influencer / digital human", "AI chatbot Eva", "robot Pepper", "metaverse retail", "voice assistant Alexa", "short-video commerce" — you MUST emit ONE umbrella variable row with the entity itself, in addition to its perceived dimensions. Specifically:
- "name" = the entity exactly as the paper names it (e.g. "AI broadcast", "AI streamer", "virtual influencer"), NOT a dimension of it.
- "type" = "independent", "constructLayer" = "stimulus".
- "canonicalConstruct" = the bare lowercased entity (e.g. "ai broadcast", "virtual streamer").
- "definition" = the paper's one-sentence framing of what the entity is.
- "citationText" = a verbatim sentence from the paper that names the entity as its study object.
This umbrella row is REQUIRED so that downstream features (focus picks, model generation, the user's natural-language search) can match the entity by its plain name. Without it, a user who types the entity name finds nothing because every extracted row carries a long compound qualifier.
Then, ALSO emit the perceived-dimension rows you would normally extract (e.g. "perceived anthropomorphism of AI broadcast", "AI broadcast host expression technology", "perceived responsiveness", "parasocial interaction"). The umbrella row and the dimension rows COEXIST — do not collapse them.

What counts as a RELATIONSHIP (extract ALL of these — do NOT limit to formally labeled hypotheses):
1. Formal hypotheses (H1, H2a, ...).
2. Sentences in the abstract that assert a directional effect, e.g. "X positively predicts Y", "A increases B", "C reduces D", "E mediates the effect of F on G", "H moderates the relationship between I and J".
3. Reported empirical findings stating a relationship between two of the extracted variables, e.g. "Trust significantly increased purchase intention (β = .42, p < .001)".
4. Theoretical claims in the introduction/discussion that tie two of the extracted variables together with a stated direction.

Strict rules:
- Extract 4-12 variables and up to 20 relationships. Lean toward MORE variables when the paper studies multiple system / design / agent characteristics — it is a serious error to drop chatbot/agent-specific stimulus variables (anthropomorphism, empathy, interactivity, voice, etc.) in favor of only generic outcome variables.
- For chatbot / AI / human–agent interaction papers specifically, the result MUST contain at least one stimulus-layer variable describing the agent itself, UNLESS the paper truly does not study any agent characteristic (rare).
- "name" keeps the paper's domain wording (e.g. "chatbot anthropomorphism"). "canonicalConstruct" strips the domain (e.g. "anthropomorphism"). Never collapse the two — both fields are required and serve different purposes.
- Every relationship's "from"/"to"/"via" MUST exactly match a "name" in "variables". If a sentence ties together a variable you didn't extract, either add that variable to "variables" or skip the relationship.
- "constructLayer" is REQUIRED for every variable. If unclear, use the closest fit; never leave it blank. Agent / system / design characteristics → "stimulus".
- "canonicalConstruct" is REQUIRED — use a short, generic, lowercased construct name.
- "statement" / "citationText" must be COPIED verbatim from the paper — do NOT paraphrase or invent.
- "relationship": use "moderates" when the source is a moderator on a path; "mediates" when the source is a mediator; "positive" / "negative" for direct effects with the stated sign. If the sign is unclear from the sentence, default to "positive".
- If the paper genuinely states NO directional relationships between the extracted variables (e.g. a pure descriptive review with no claims), return "hypotheses": []. Otherwise extract them — do not return [] just because the paper lacks H1/H2 labels.

Mini-example of the correct shape for a typical chatbot paper:
{
  "variables": [
    {"name":"chatbot anthropomorphism","type":"independent","constructLayer":"stimulus","canonicalConstruct":"anthropomorphism","definition":"...","citationText":"..."},
    {"name":"chatbot empathy","type":"independent","constructLayer":"stimulus","canonicalConstruct":"empathy","definition":"...","citationText":"..."},
    {"name":"perceived warmth","type":"mediator","constructLayer":"cognitive","canonicalConstruct":"warmth","definition":"...","citationText":"..."},
    {"name":"trust in chatbot","type":"mediator","constructLayer":"cognitive","canonicalConstruct":"trust","definition":"...","citationText":"..."},
    {"name":"continuance intention","type":"dependent","constructLayer":"intention","canonicalConstruct":"continuance intention","definition":"...","citationText":"..."}
  ],
  "hypotheses": [ ... ]
}
NOTICE: the chatbot characteristics are kept as separate IV rows even though the paper "is really about" trust and intention. That is the correct behavior.`;
}

interface ParsedScopeCheck {
  status?: string;
  confidence?: number;
  topicFitScore?: number;
  reason?: string;
  matchedTopicTerms?: unknown;
  mismatchedSignals?: unknown;
}

interface ParsedExtraction {
  scopeCheck?: ParsedScopeCheck;
  variables?: Array<{ name: string; type: string; definition: string; citationText: string; canonicalConstruct?: string; constructLayer?: string }>;
  hypotheses?: Array<{ id: string; from: string; to: string; via?: string | null; relationship: string; statement: string; effectSize?: string | null; pageOrSection?: string | null }>;
  theoryBackbone?: Array<{ name?: string; role?: string; citationText?: string | null }>;
  statedGaps?: Array<{ type?: string; statement?: string; citationText?: string | null; pageOrSection?: string | null }>;
  studyContext?: { objectType?: string; sampleType?: string | null; geography?: string | null; platform?: string | null; modality?: string | null; language?: string | null };
}

// Server-side corroboration of the AI's scopeCheck verdict. We only
// tangential-flag a paper when (a) the AI returned out_of_scope with
// non-trivial confidence AND (b) at least one independent signal agrees.
// "uncertain" never tangential-flags. "in_scope" is always trusted.
function assessTopicScope(parsed: ParsedExtraction, paper: Paper): {
  tangential: boolean;
  scopeStatus: ScopeStatus;
  // CONFIDENCE in the scopeStatus verdict itself (0-100).
  scopeConfidence: number;
  // SEMANTIC FIT to the session topic (0-100), independent of confidence.
  // Falls back to a verdict-based default when the AI omits the field, so
  // older prompt outputs still produce a sensible value.
  topicFitScore: number;
  tangentialReason: string | null;
} {
  const sc = parsed.scopeCheck ?? {};
  const rawStatus = typeof sc.status === "string" ? sc.status.trim().toLowerCase() : "";
  const aiStatus: ScopeStatus = rawStatus === "in_scope" || rawStatus === "out_of_scope" ? rawStatus : "uncertain";
  const rawConf = typeof sc.confidence === "number" && Number.isFinite(sc.confidence) ? sc.confidence : 50;
  const scopeConfidence = Math.max(0, Math.min(100, Math.round(rawConf)));
  // topicFitScore is independent of confidence. If the AI didn't supply it
  // (e.g. legacy prompt output), derive a reasonable default from the
  // verdict so downstream sorting/filtering still works.
  const fitDefault = aiStatus === "in_scope" ? 80 : aiStatus === "uncertain" ? 50 : 15;
  const rawFit = typeof sc.topicFitScore === "number" && Number.isFinite(sc.topicFitScore) ? sc.topicFitScore : fitDefault;
  const topicFitScore = Math.max(0, Math.min(100, Math.round(rawFit)));
  const reason = typeof sc.reason === "string" ? sc.reason.trim().slice(0, 280) : null;

  if (aiStatus !== "out_of_scope") {
    return { tangential: false, scopeStatus: aiStatus, scopeConfidence, topicFitScore, tangentialReason: null };
  }

  // High-confidence out_of_scope corroboration. Lowercase haystacks.
  const titleAbs = `${paper.title} ${paper.abstract ?? ""}`.toLowerCase();
  const vars = Array.isArray(parsed.variables) ? parsed.variables : [];
  const varText = vars
    .map((v) => `${v?.name ?? ""} ${v?.canonicalConstruct ?? ""}`)
    .join(" ")
    .toLowerCase();
  const objectType = (parsed.studyContext?.objectType ?? "").toLowerCase().trim();

  const titleHasBehavioral = BEHAVIORAL_DOMAIN_TERMS.some((t) => titleAbs.includes(t));
  const varsHaveBehavioral = BEHAVIORAL_DOMAIN_TERMS.some((t) => varText.includes(t));
  // engineering / system signals that strongly suggest a non-applied paper
  const ENGINEERING_RE = /(allgather|broadcast protocol|smartnic|gpu kernel|throughput|latency budget|fpga|asic|tcp|rdma|kernel-bypass|distributed training|sharded|fsdp|allreduce|bandwidth-optimal|inference engine|tensor parallel|model parallel)/i;
  const objectIsEngineering = /(distributed|network|protocol|hardware|kernel|compiler|database system|operating system|nic\b|smartnic)/.test(objectType)
    || ENGINEERING_RE.test(`${paper.title} ${paper.abstract ?? ""}`);

  // Multi-signal: AI says OOS AND at least one of (no behavioral terms in title/abstract,
  // no behavioral terms in extracted vars, engineering objectType).
  const corroborated = (!titleHasBehavioral && !varsHaveBehavioral) || objectIsEngineering || (!titleHasBehavioral && objectIsEngineering);
  const highConfidence = scopeConfidence >= 60; // AI's own confidence in its OOS verdict

  if (corroborated && highConfidence) {
    return {
      tangential: true,
      scopeStatus: "out_of_scope",
      scopeConfidence,
      topicFitScore,
      tangentialReason: reason ?? "Out-of-scope: paper sits in an engineering / non-applied domain with no behavioral constructs.",
    };
  }

  // AI said OOS but corroboration weak — downgrade to uncertain so we keep the
  // paper but surface the verdict to reviewers.
  return {
    tangential: false,
    scopeStatus: "uncertain",
    scopeConfidence,
    topicFitScore,
    tangentialReason: null,
  };
}

export interface ExtractionResult {
  insertedVariables: Variable[];
  hypothesesInsertedCount: number;
  theoryBackbone: Array<{ name: string; role: "primary" | "secondary"; citationText: string | null }>;
  statedGaps: Array<{ type: string; statement: string; pageOrSection: string | null }>;
  studyContext: {
    objectType: string;
    sampleType: string | null;
    geography: string | null;
    platform: string | null;
    modality: string | null;
    language: string | null;
  } | null;
  parseRecovered: boolean;
  scope: {
    tangential: boolean;
    scopeStatus: ScopeStatus;
    scopeConfidence: number;
    topicFitScore: number;
    tangentialReason: string | null;
  };
}

export async function extractAndStorePaperVariables(
  paper: Paper,
  log: MinimalLogger,
): Promise<ExtractionResult> {
  // Load the session topic so the SCOPE CHECK gate can compare against it.
  // Done inside this function to avoid a signature change at every caller.
  const [session] = await db.select({ topic: sessionsTable.topic })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, paper.sessionId))
    .limit(1);
  const sessionTopic = session?.topic ?? "";
  const prompt = buildExtractionPrompt(paper, sessionTopic);

  let completion;
  try {
    completion = await openai.chat.completions.create(
      {
        model: "gpt-5.4",
        max_completion_tokens: 10000,
        messages: [{ role: "user", content: prompt }],
      },
      { signal: AbortSignal.timeout(90_000) },
    );
  } catch (err) {
    const e = err as { name?: string; message?: string };
    const isTimeout = e?.name === "AbortError" || e?.name === "TimeoutError" || /aborted|timeout/i.test(e?.message ?? "");
    if (isTimeout) throw new ExtractionError("timeout", e?.message ?? "timeout", 504);
    throw new ExtractionError("unknown", e?.message ?? "openai call failed", 500);
  }

  logAiUsageFromOpenAI(completion, { route: "variables/extract", sessionId: paper.sessionId });

  const content = completion.choices[0]?.message?.content ?? "{}";
  let parsed: ParsedExtraction = {};
  let parseRecovered = false;
  const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  try {
    parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) parsed = { variables: parsed as ParsedExtraction["variables"], hypotheses: [] };
  } catch {
    const repaired = tryRepairTruncatedJson(cleaned);
    if (repaired) {
      try {
        parsed = JSON.parse(repaired);
        parseRecovered = true;
        log.warn({ paperId: paper.id, finishReason: completion.choices[0]?.finish_reason }, "Recovered truncated extraction JSON");
      } catch {
        log.warn({ content, finishReason: completion.choices[0]?.finish_reason }, "Failed to parse AI extraction JSON (repair also failed)");
        throw new ExtractionError("parse_failed", "AI 返回的内容无法解析，请稍后再试。", 500);
      }
    } else {
      log.warn({ content, finishReason: completion.choices[0]?.finish_reason }, "Failed to parse AI extraction JSON");
      throw new ExtractionError("parse_failed", "AI 返回的内容无法解析，请稍后再试。", 500);
    }
  }

  const extractedVars = Array.isArray(parsed.variables) ? parsed.variables : [];
  const extractedHyps = Array.isArray(parsed.hypotheses) ? parsed.hypotheses : [];

  // SCOPE CHECK gate (three-state, server-corroborated). When the AI flags
  // a paper as high-confidence out_of_scope AND independent server signals
  // agree, we mark it tangential: extracted="true", variables=[],
  // hypotheses=[], so it is filtered from landscape / model-generation /
  // paper-count downstream and never re-attacked by the "extract all" loop.
  // Uncertain verdicts and weakly-corroborated OOS verdicts fall through
  // and follow the normal extraction path.
  const scope = assessTopicScope(parsed, paper);
  if (scope.tangential) {
    await db.transaction(async (tx) => {
      await tx.delete(variablesTable).where(and(eq(variablesTable.paperId, paper.id), eq(variablesTable.sessionId, paper.sessionId)));
      await tx.delete(paperHypothesesTable).where(and(eq(paperHypothesesTable.paperId, paper.id), eq(paperHypothesesTable.sessionId, paper.sessionId)));
      await tx.update(papersTable).set({
        extracted: "true",
        theoryBackbone: [],
        statedGaps: [],
        studyContext: null,
        tangential: true,
        tangentialReason: scope.tangentialReason,
        scopeStatus: scope.scopeStatus,
        topicFitScore: scope.topicFitScore,
        scopeConfidence: scope.scopeConfidence,
        // Back-compat: mirror confidence into the deprecated scopeScore column.
        scopeScore: scope.scopeConfidence,
      }).where(eq(papersTable.id, paper.id));
    });
    // Rebuild landscape so any prior in-scope rows from this paper are dropped.
    scheduleLandscapeRebuild(paper.sessionId);
    log.warn(
      { paperId: paper.id, sessionId: paper.sessionId, title: paper.title, topicFitScore: scope.topicFitScore, scopeConfidence: scope.scopeConfidence, reason: scope.tangentialReason },
      "Paper flagged tangential by scope check — extraction skipped",
    );
    return {
      insertedVariables: [],
      hypothesesInsertedCount: 0,
      theoryBackbone: [],
      statedGaps: [],
      studyContext: null,
      parseRecovered,
      scope,
    };
  }

  if (extractedVars.length === 0) {
    throw new ExtractionError("no_variables", "这篇论文里没有可识别的研究变量（多见于综述、技术应用类或非实证论文）。", 422);
  }

  // Diagnostic: HCI/agent papers should produce at least one stimulus-layer IV.
  const titleAbstract = `${paper.title} ${paper.abstract ?? ""}`;
  const detectionHaystack = (titleAbstract.trim().length < 80 && paper.fullText)
    ? `${titleAbstract} ${paper.fullText.slice(0, 4000)}`
    : titleAbstract;
  const AGENT_PAPER_RE = /(chat[- ]?bot|conversational agent|voice assistant|virtual assistant|ai assistant|ai agent|llm[- ]?based agent|dialogue system|smart speaker|ai companion|ai chatbot|generative ai|chatgpt|social robot|embodied agent|virtual (influencer|human|streamer)|digital human|recommender system|recommendation agent|human[- ]?ai interaction|human[- ]?computer interaction|hci experiment)/i;
  if (AGENT_PAPER_RE.test(detectionHaystack)) {
    const stimulusCount = extractedVars.filter((v) => (v.constructLayer ?? "").toLowerCase().trim() === "stimulus").length;
    const independentCount = extractedVars.filter((v) => (v.type ?? "").toLowerCase() === "independent").length;
    const stimulusIndependentCount = extractedVars.filter((v) => (v.type ?? "").toLowerCase() === "independent" && (v.constructLayer ?? "").toLowerCase().trim() === "stimulus").length;
    if (stimulusIndependentCount === 0) {
      log.warn(
        { paperId: paper.id, sessionId: paper.sessionId, title: paper.title, totalVariables: extractedVars.length, stimulusCount, independentCount, stimulusIndependentCount },
        "Agent/HCI paper extracted with 0 (independent ∩ stimulus) variables — prompt-following regression?",
      );
    }
  }

  const cleanTheoryBackbone = Array.isArray(parsed.theoryBackbone)
    ? parsed.theoryBackbone
        .filter((t) => t && typeof t.name === "string" && t.name.trim().length > 1)
        .slice(0, 8)
        .map((t) => ({
          name: t.name!.trim().slice(0, 200),
          role: (t.role === "secondary" ? "secondary" : "primary") as "primary" | "secondary",
          citationText: typeof t.citationText === "string" ? t.citationText.trim().slice(0, 600) : null,
        }))
    : [];
  const cleanStatedGaps = Array.isArray(parsed.statedGaps)
    ? parsed.statedGaps
        .filter((g) => g && typeof g.statement === "string" && g.statement.trim().length >= 10 && typeof g.type === "string" && VALID_GAP_TYPES.has(g.type))
        .slice(0, 8)
        .map((g) => ({
          type: g.type!,
          statement: g.statement!.trim().slice(0, 800),
          pageOrSection: typeof g.pageOrSection === "string" ? g.pageOrSection.trim().slice(0, 120) : null,
        }))
    : [];
  const ctx = parsed.studyContext;
  const cleanStudyContext = ctx && typeof ctx === "object" && typeof ctx.objectType === "string" && ctx.objectType.trim().length > 0
    ? {
        objectType: ctx.objectType.trim().slice(0, 80).toLowerCase(),
        sampleType: typeof ctx.sampleType === "string" ? ctx.sampleType.trim().slice(0, 40).toLowerCase() : null,
        geography: typeof ctx.geography === "string" ? ctx.geography.trim().slice(0, 80) : null,
        platform: typeof ctx.platform === "string" ? ctx.platform.trim().slice(0, 80) : null,
        modality: typeof ctx.modality === "string" ? ctx.modality.trim().slice(0, 40).toLowerCase() : null,
        language: typeof ctx.language === "string" ? ctx.language.trim().slice(0, 40) : null,
      }
    : null;

  let hypothesesInsertedCount = 0;

  const inserted = await db.transaction(async (tx) => {
    await tx.delete(variablesTable).where(and(eq(variablesTable.paperId, paper.id), eq(variablesTable.sessionId, paper.sessionId)));
    await tx.delete(paperHypothesesTable).where(and(eq(paperHypothesesTable.paperId, paper.id), eq(paperHypothesesTable.sessionId, paper.sessionId)));

    const insertedRows = await Promise.all(
      extractedVars.map((v) => {
        const layerRaw = (v.constructLayer ?? "").toLowerCase().trim();
        const layer = VALID_LAYERS.has(layerRaw) ? layerRaw : null;
        const canonical = (v.canonicalConstruct && v.canonicalConstruct.trim().length > 0)
          ? canonicalize(v.canonicalConstruct)
          : canonicalize(v.name);
        return tx.insert(variablesTable).values({
          sessionId: paper.sessionId,
          paperId: paper.id,
          name: v.name,
          type: v.type,
          definition: v.definition,
          citationText: v.citationText,
          canonicalConstructId: canonical,
          constructLayer: layer,
        }).returning();
      }),
    );

    if (extractedHyps.length > 0) {
      const hypRows = extractedHyps
        .filter((h) => h && typeof h.id === "string" && typeof h.from === "string" && typeof h.to === "string" && typeof h.statement === "string" && h.statement.trim().length >= 8)
        .slice(0, 20)
        .map((h) => ({
          sessionId: paper.sessionId,
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
        // returning() with onConflictDoNothing reflects only the rows that
        // actually inserted, so the reported count stays honest if the AI
        // emits duplicate hypothesis ids in one batch.
        const insertedHyps = await tx
          .insert(paperHypothesesTable)
          .values(hypRows)
          .onConflictDoNothing()
          .returning({ id: paperHypothesesTable.id });
        hypothesesInsertedCount = insertedHyps.length;
      }
    }

    await tx.update(papersTable).set({
      extracted: "true",
      theoryBackbone: cleanTheoryBackbone,
      statedGaps: cleanStatedGaps,
      studyContext: cleanStudyContext,
      // A paper that just passed the scope gate is, by definition, no longer
      // tangential. Clear any prior tangential mark in case the same paper
      // had been flagged on an earlier extraction.
      tangential: false,
      tangentialReason: null,
      scopeStatus: scope.scopeStatus,
      topicFitScore: scope.topicFitScore,
      scopeConfidence: scope.scopeConfidence,
      // Back-compat: mirror confidence into the deprecated scopeScore column.
      scopeScore: scope.scopeConfidence,
    }).where(eq(papersTable.id, paper.id));
    return insertedRows;
  });

  scheduleLandscapeRebuild(paper.sessionId);

  return {
    insertedVariables: inserted.flat(),
    hypothesesInsertedCount,
    theoryBackbone: cleanTheoryBackbone,
    statedGaps: cleanStatedGaps,
    studyContext: cleanStudyContext,
    parseRecovered,
    scope,
  };
}

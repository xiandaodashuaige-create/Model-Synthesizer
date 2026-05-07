// Phase 1 internal self-test (D2 / D3 gate).
//
// Pure (no DB) — exercises the canonicalize 3-layer + the aggregator on
// fixture data, then asserts the documented invariants from
// docs/innovation-taxonomy.md and replit.md.
//
// Run:   pnpm --filter @workspace/scripts run selftest:phase-1
// Exits 0 on success, 1 with a list of failed assertions on failure.

import { canonicalize, normalizeName, aggregationKey, aggregationKeyOf } from "@workspace/canonicalize";
import { aggregateLandscape, aggregateTheoryClusters } from "../../artifacts/api-server/src/lib/literature-landscape.js";
import type { Paper, PaperHypothesis } from "@workspace/db";

type Check = { name: string; pass: boolean; detail?: string };
const checks: Check[] = [];
function check(name: string, pass: boolean, detail?: string): void {
  checks.push({ name, pass, detail });
}

// -------------------------------------------------------------------- canonicalize layer 1+2+3
{
  const a = canonicalize("Trust in AI Streamer");
  const b = canonicalize("trust in platform");
  const c = canonicalize("Trust");
  const d = canonicalize("Perceived Anthropomorphism of Chatbot");
  const e = canonicalize("AI 主播感知拟人化"); // Chinese — no preposition, no split

  check("layer 2 lowercases + strips perceived (qualified)",
    d.canonicalName === "anthropomorphism" && d.contextQualifier === "chatbot",
    JSON.stringify(d));

  check("layer 3 splits 'X in Y' qualifier",
    a.canonicalName === "trust" && a.contextQualifier === "ai streamer",
    JSON.stringify(a));

  check("'trust in AI streamer' and 'trust in platform' are DIFFERENT aggregation keys",
    aggregationKey(a) !== aggregationKey(b),
    `${aggregationKey(a)} vs ${aggregationKey(b)}`);

  check("'trust in AI streamer' and 'trust in platform' share constructFamily 'trust'",
    a.constructFamily === "trust" && b.constructFamily === "trust",
    `${a.constructFamily} / ${b.constructFamily}`);

  check("unqualified 'Trust' produces null contextQualifier",
    c.contextQualifier === null && c.canonicalName === "trust",
    JSON.stringify(c));

  check("Chinese names do not get spuriously split",
    e.contextQualifier === null && e.canonicalName.length > 0,
    JSON.stringify(e));

  // Chinese / mixed-script regression — the literature in this app is heavily
  // Chinese; the qualifier-split heuristic is English-only by design (no
  // Chinese prepositions), so these MUST stay one undivided construct.
  for (const phrase of [
    "AI 主播信任",
    "对 AI 主播的信任",
    "消费者信任",
    "感知拟人化",
    "AI 主播感知拟人化",
    "对人工智能主播的信任",
    "消费者冲动购买意愿",
    "心流体验",
    "社会临场感",
  ]) {
    const r = canonicalize(phrase);
    check(`Chinese "${phrase}" stays as one construct (no spurious split)`,
      r.contextQualifier === null && r.canonicalName.length > 0,
      JSON.stringify(r));
  }

  // Lock-step: same Chinese name with different casing/spacing on the AI tag
  // must collapse to one canonicalName so cross-paper aggregation works.
  check("'AI 主播信任' and 'ai主播信任' collapse to the same canonical",
    canonicalize("AI 主播信任").canonicalName === canonicalize("ai主播信任").canonicalName,
    `${canonicalize("AI 主播信任").canonicalName} vs ${canonicalize("ai主播信任").canonicalName}`);

  // Compound "X of Y" constructs that must NOT split (regression guard from
  // the Phase 1 architect review).
  for (const [phrase, expectedCanonical] of [
    ["fear of missing out", "fear of missing out"],
    ["sense of community", "sense of community"],
    ["quality of life", "quality of life"],
    ["perception of risk", "perception of risk"],
    ["lack of trust", "lack of trust"],
    ["level of involvement", "level of involvement"],
    ["ease of use", "ease of use"],
    ["locus of control", "locus of control"],
    ["intention of use", "intention of use"],
    ["fear of crime", "fear of crime"],
    ["theory of planned behavior", "theory of planned behavior"],
  ] as const) {
    const r = canonicalize(phrase);
    check(`compound "${phrase}" does not split`,
      r.canonicalName === expectedCanonical && r.contextQualifier === null,
      JSON.stringify(r));
  }

  // Splits that MUST still happen even after the blocklist hardening.
  for (const [phrase, expectedCore, expectedQual] of [
    ["trust in AI streamer", "trust", "ai streamer"],
    ["trust in platform", "trust", "platform"],
    ["warmth of chatbot", "warmth", "chatbot"],
    ["satisfaction with service", "satisfaction", "service"],
    ["loyalty towards brand", "loyalty", "brand"],
    ["credibility of source", "credibility", "source"],
  ] as const) {
    const r = canonicalize(phrase);
    check(`legitimate split "${phrase}" → core+qualifier`,
      r.canonicalName === expectedCore && r.contextQualifier === expectedQual,
      JSON.stringify(r));
  }

  // Layer 2 lock-step: legacy normalizeName on a multi-paper "重复举例变量" case.
  check("AI-chatbot service quality normalizes equal to AI chatbot service quality",
    normalizeName("AI-chatbot service quality") === normalizeName("AI chatbot service quality"),
    `'${normalizeName("AI-chatbot service quality")}' vs '${normalizeName("AI chatbot service quality")}'`);

  check("aggregationKeyOf convenience matches aggregationKey(canonicalize(...))",
    aggregationKeyOf("Trust in AI Streamer") === aggregationKey(canonicalize("Trust in AI Streamer")));
}

// -------------------------------------------------------------------- aggregator on fixture data
{
  const papers: Paper[] = [
    fixturePaper(101, "p1", 2022, "ai streamer", [{ name: "Parasocial Interaction Theory", role: "primary" }]),
    fixturePaper(102, "p2", 2023, "ai streamer", [{ name: "Parasocial Interaction Theory", role: "primary" }]),
    fixturePaper(103, "p3", 2024, "chatbot",     [{ name: "Theory of Planned Behavior", role: "primary" }]),
    fixturePaper(104, "p4", 2024, "ai streamer", [{ name: "parasocial interaction theory", role: "secondary" }]), // case variation
  ];
  const papersById = new Map(papers.map((p) => [p.id, p]));

  const hyps: PaperHypothesis[] = [
    fixtureHyp(1, 101, "trust in AI streamer", "purchase intention", "positive"),
    fixtureHyp(2, 102, "trust in AI streamer", "purchase intention", "positive"),
    fixtureHyp(3, 103, "trust in chatbot",     "purchase intention", "positive"),
    fixtureHyp(4, 104, "trust in AI streamer", "purchase intention", "negative"), // sign conflict on the 'ai streamer' cell
    fixtureHyp(5, 101, "social presence",      "trust in AI streamer", "moderates", "social presence"),
    // Phase 1.x dedup regression guard: paper 101 also restates its H1 as a
    // discussion-section finding. Same paper, same cell → must NOT inflate
    // totalOccurrences (which would push the cell from novelty=50 to a
    // wrong bracket).
    fixtureHyp(6, 101, "trust in AI streamer", "purchase intention", "positive"),
  ];

  const rows = aggregateLandscape(hyps, papersById);

  // Two papers say AI-streamer-trust → PI positive; one says negative — ONE row, sign=mixed, signConflict=true, totalOccurrences=3
  const aiStreamerCell = rows.find(
    (r) => r.canonicalFrom === "trust" && r.contextQualifierFrom === "ai streamer" && r.canonicalTo === "purchase intention" && r.relationshipType === "direct",
  );
  check("AI-streamer trust→PI cell exists",
    !!aiStreamerCell, JSON.stringify(aiStreamerCell));
  check("AI-streamer trust→PI is sign='mixed' (2 positive + 1 negative)",
    aiStreamerCell?.sign === "mixed" && aiStreamerCell?.signConflict === true,
    `sign=${aiStreamerCell?.sign} conflict=${aiStreamerCell?.signConflict}`);
  check("AI-streamer trust→PI totalOccurrences=3 (DISTINCT papers, not hypothesis rows)",
    aiStreamerCell?.totalOccurrences === 3,
    `n=${aiStreamerCell?.totalOccurrences} (cell has ${aiStreamerCell?.supportingPapers && (aiStreamerCell.supportingPapers as unknown[]).length} hypothesis rows)`);
  check("AI-streamer trust→PI domainsCovered=['ai streamer']",
    JSON.stringify(aiStreamerCell?.domainsCovered) === '["ai streamer"]',
    JSON.stringify(aiStreamerCell?.domainsCovered));
  check("AI-streamer trust→PI year span 2022-2024",
    aiStreamerCell?.earliestYear === 2022 && aiStreamerCell?.latestYear === 2024);

  // Chatbot trust→PI is its own cell (DIFFERENT contextQualifier) — separate aggregation, totalOccurrences=1
  const chatbotCell = rows.find(
    (r) => r.canonicalFrom === "trust" && r.contextQualifierFrom === "chatbot" && r.canonicalTo === "purchase intention" && r.relationshipType === "direct",
  );
  check("chatbot trust→PI is a SEPARATE cell from AI-streamer trust→PI",
    !!chatbotCell && chatbotCell !== aiStreamerCell,
    JSON.stringify(chatbotCell));
  check("chatbot trust→PI totalOccurrences=1, sign=positive",
    chatbotCell?.totalOccurrences === 1 && chatbotCell?.sign === "positive");

  // Moderation row exists with sign=none AND preserves moderator structural
  // metadata so Phase 2 boundary detection can identify the moderated (X,Y).
  const modCell = rows.find((r) => r.relationshipType === "moderation");
  check("moderation hypothesis produces a relationshipType='moderation' row with sign='none'",
    !!modCell && modCell.sign === "none",
    JSON.stringify(modCell));
  const modPapers = (modCell?.supportingPapers ?? []) as Array<{ viaVariable: string | null; originalFrom: string; originalTo: string }>;
  check("moderation row carries viaVariable + originalFrom/To for Phase 2 boundary check",
    modPapers.length > 0
      && modPapers[0].viaVariable === "social presence"
      && modPapers[0].originalFrom === "social presence"
      && modPapers[0].originalTo === "trust in AI streamer",
    JSON.stringify(modPapers[0]));

  // Novelty potential brackets per docs/innovation-taxonomy.md
  check("totalOccurrences=1 → noveltyPotentialScore=75",
    chatbotCell?.noveltyPotentialScore === 75, `score=${chatbotCell?.noveltyPotentialScore}`);
  check("totalOccurrences=3 → noveltyPotentialScore=50",
    aiStreamerCell?.noveltyPotentialScore === 50, `score=${aiStreamerCell?.noveltyPotentialScore}`);
}

// -------------------------------------------------------------------- theory clustering
{
  const papers: Paper[] = [
    fixturePaper(201, "p1", 2022, "ai streamer", [{ name: "Parasocial Interaction Theory", role: "primary" }]),
    fixturePaper(202, "p2", 2023, "ai streamer", [{ name: "parasocial interaction theory", role: "secondary" }]), // case variation
    fixturePaper(203, "p3", 2024, "chatbot",     [{ name: "Theory of Planned Behavior", role: "primary" }]),
    fixturePaper(204, "p4", 2024, "chatbot",     [{ name: "Theory of Planned Behavior", role: "primary" }, { name: "Theory of Planned Behavior", role: "secondary" }]), // dedup within paper
  ];
  const clusters = aggregateTheoryClusters(papers);
  const para = clusters.find((c) => c.id === "parasocial interaction theory");
  const tpb = clusters.find((c) => c.id === "theory of planned behavior");
  check("parasocial cluster groups 2 papers (case-insensitive)",
    para?.paperCount === 2 && para?.theoryIds.length === 2,
    JSON.stringify(para));
  check("TPB cluster does NOT double-count when one paper lists it twice",
    tpb?.paperCount === 2,
    JSON.stringify(tpb));
  check("clusters sorted by paperCount desc",
    clusters[0]?.paperCount >= clusters[clusters.length - 1]?.paperCount);
}

// -------------------------------------------------------------------- report
const failed = checks.filter((c) => !c.pass);
const passed = checks.length - failed.length;
console.log(`\nPhase 1 self-test: ${passed}/${checks.length} passed`);
for (const c of failed) {
  console.log(`  FAIL  ${c.name}${c.detail ? `\n        → ${c.detail}` : ""}`);
}
if (failed.length === 0) {
  console.log("  all green");
  process.exit(0);
}
process.exit(1);

// -------------------------------------------------------------------- helpers
function fixturePaper(
  id: number,
  externalId: string,
  year: number,
  objectType: string,
  theoryBackbone: Array<{ name: string; role: string }>,
): Paper {
  return {
    id,
    sessionId: 999,
    externalId,
    title: `fixture ${externalId}`,
    abstract: null,
    authors: [],
    year,
    venue: null,
    citationCount: null,
    openAccessUrl: null,
    url: "",
    fullText: null,
    extracted: "true",
    researchModel: null,
    figureResults: null,
    figuresFetchedAt: null,
    theoryBackbone,
    statedGaps: [],
    studyContext: { objectType },
    createdAt: new Date(),
  } as unknown as Paper;
}

function fixtureHyp(
  id: number,
  paperId: number,
  fromVariable: string,
  toVariable: string,
  relationship: string,
  viaVariable: string | null = null,
): PaperHypothesis {
  return {
    id,
    sessionId: 999,
    paperId,
    hypothesisId: `H${id}`,
    fromVariable,
    toVariable,
    viaVariable,
    relationship,
    statement: `fixture statement for H${id}`,
    effectSize: null,
    pageOrSection: null,
    createdAt: new Date(),
  } as unknown as PaperHypothesis;
}

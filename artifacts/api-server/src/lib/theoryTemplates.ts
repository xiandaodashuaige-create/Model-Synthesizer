// Theory backbones — classical research models that AI can graft variables onto
// when generating recombined research models. Expanded from 8 → 17 to cover
// organizational behavior, education, strategy, psychology, and health domains.

export interface TheoryBackbone {
  id: string;
  name: string;
  domain: string;
  shape: string;
  description: string;
  // Construct-layer slots (light structure — we deliberately don't list canonical
  // variable names here, to avoid the AI overfitting to those examples).
  slots: {
    independent: { min: number; max: number };
    mediator?: { min: number; max: number; position: "serial" | "parallel" };
    moderator?: { min: number; max: number; moderates: "main-effect" | "mediation-path" | "both" };
    dependent: { min: number; max: number };
  };
  // Heuristic keywords that indicate this backbone is a good fit for the user's DV.
  // Used by recommendBackbones() to pre-filter — NOT shown to the AI as hard constraint.
  dvHints: string[];
}

export const THEORY_BACKBONES: TheoryBackbone[] = [
  {
    id: "TAM",
    name: "Technology Acceptance Model (Davis 1989)",
    domain: "technology adoption",
    shape: "[Perceived Usefulness, Perceived Ease of Use] (independents) -> Attitude (mediator) -> Behavioral Intention (mediator) -> Actual Use (dependent)",
    description: "Two parallel cognitive evaluations drive attitude, attitude drives intention, intention drives behavior. Useful when the DV is adoption/use of a technology.",
    slots: {
      independent: { min: 2, max: 3 },
      mediator: { min: 1, max: 2, position: "serial" },
      dependent: { min: 1, max: 1 },
    },
    dvHints: ["adoption", "use", "acceptance", "intention to use", "behavioral intention", "system use"],
  },
  {
    id: "UTAUT",
    name: "Unified Theory of Acceptance and Use of Technology (Venkatesh 2003)",
    domain: "technology adoption",
    shape: "[Performance Expectancy, Effort Expectancy, Social Influence] -> Behavioral Intention -> Use Behavior; Facilitating Conditions -> Use Behavior; moderators: Age, Gender, Experience, Voluntariness on every path",
    description: "Multi-antecedent intention model with strong moderator structure. Use when there are 3+ independents and the user wants moderators.",
    slots: {
      independent: { min: 3, max: 4 },
      mediator: { min: 1, max: 1, position: "serial" },
      moderator: { min: 1, max: 4, moderates: "main-effect" },
      dependent: { min: 1, max: 2 },
    },
    dvHints: ["adoption", "use", "acceptance", "intention", "system use", "continuance"],
  },
  {
    id: "SOR",
    name: "Stimulus-Organism-Response (Mehrabian & Russell 1974)",
    domain: "consumer behavior, environmental psychology, live commerce, retail",
    shape: "Stimulus (external cue: streamer/store/ad/atmosphere) -> Organism (internal state: emotion, trust, flow, perception) -> Response (approach/avoid: purchase, engagement, WOM)",
    description: "Classic three-stage chain. Highly applicable to live commerce, AI streamers, retail atmospherics. Stimuli are external IVs, Organism variables are mediators, Response variables are DVs.",
    slots: {
      independent: { min: 1, max: 4 },
      mediator: { min: 1, max: 3, position: "parallel" },
      dependent: { min: 1, max: 2 },
    },
    dvHints: ["purchase", "purchase intention", "impulse buying", "approach", "engagement", "wom", "word of mouth", "satisfaction", "loyalty", "patronage"],
  },
  {
    id: "ELM",
    name: "Elaboration Likelihood Model (Petty & Cacioppo 1986)",
    domain: "persuasion, advertising, information adoption",
    shape: "[Central-route cues (argument quality), Peripheral-route cues (source credibility, attractiveness)] -> Attitude Change -> Behavioral Intention; moderator: Involvement / motivation determines which route dominates",
    description: "Dual-route persuasion. Use when the model contrasts content-quality vs surface cues, or when 'involvement' style moderator fits.",
    slots: {
      independent: { min: 2, max: 4 },
      mediator: { min: 1, max: 2, position: "serial" },
      moderator: { min: 1, max: 1, moderates: "main-effect" },
      dependent: { min: 1, max: 1 },
    },
    dvHints: ["attitude", "persuasion", "information adoption", "credibility", "intention"],
  },
  {
    id: "TPB",
    name: "Theory of Planned Behavior (Ajzen 1991)",
    domain: "behavior prediction",
    shape: "[Attitude, Subjective Norm, Perceived Behavioral Control] -> Intention -> Behavior; PBC -> Behavior (direct)",
    description: "Three-antecedent intention model. Good when 'norms' or 'control' style variables are present.",
    slots: {
      independent: { min: 3, max: 3 },
      mediator: { min: 1, max: 1, position: "serial" },
      dependent: { min: 1, max: 1 },
    },
    dvHints: ["intention", "behavior", "compliance", "adoption", "engagement", "exercise", "recycling", "voting"],
  },
  {
    id: "TRUST_TRANSFER",
    name: "Trust Transfer Theory (Stewart 2003)",
    domain: "platforms, intermediaries, AI agents, brand extension",
    shape: "Trust in Source A (e.g., platform / brand / human streamer) -> Trust in Target B (e.g., AI agent / new product) -> Behavioral Intention toward B",
    description: "Trust flows along a perceived link. Strong fit for AI streamer / AI agent contexts where user already trusts a platform or human.",
    slots: {
      independent: { min: 1, max: 2 },
      mediator: { min: 1, max: 1, position: "serial" },
      dependent: { min: 1, max: 1 },
    },
    dvHints: ["trust", "intention", "purchase", "adoption", "platform"],
  },
  {
    id: "PARASOCIAL",
    name: "Parasocial Interaction / Relationship (Horton & Wohl 1956; Rubin 1985)",
    domain: "media figures, influencers, virtual streamers",
    shape: "[Streamer characteristics (anthropomorphism, attractiveness, responsiveness)] -> Parasocial Interaction (mediator) -> Parasocial Relationship -> Loyalty / Purchase Intention",
    description: "One-sided viewer-to-figure bond. Especially useful for AI/virtual streamer studies.",
    slots: {
      independent: { min: 1, max: 3 },
      mediator: { min: 1, max: 2, position: "serial" },
      dependent: { min: 1, max: 1 },
    },
    dvHints: ["loyalty", "purchase", "engagement", "follow", "attachment", "parasocial"],
  },
  {
    id: "FLOW",
    name: "Flow Theory (Csikszentmihalyi 1990; Hoffman & Novak 1996)",
    domain: "online experience, gaming, live commerce",
    shape: "[Skill, Challenge, Telepresence, Interactivity] -> Flow State (mediator: enjoyment, concentration, time distortion) -> Outcomes (purchase, satisfaction, revisit)",
    description: "Intrinsic-immersion mediator. Use when user mentions 'flow' / 'immersion' / '心流'.",
    slots: {
      independent: { min: 2, max: 4 },
      mediator: { min: 1, max: 1, position: "serial" },
      dependent: { min: 1, max: 2 },
    },
    dvHints: ["flow", "immersion", "enjoyment", "satisfaction", "purchase", "revisit", "time spent"],
  },
  {
    id: "JD_R",
    name: "Job Demands-Resources Model (Bakker & Demerouti 2007)",
    domain: "organizational behavior, occupational health",
    shape: "Job Demands -> Burnout (mediator) -> Strain/Turnover; Job Resources -> Engagement (mediator) -> Performance; Resources buffer Demands -> Burnout (moderator)",
    description: "Dual-pathway model: demands cause burnout, resources cause engagement, with cross-buffering. Use for any workplace stress / engagement / burnout study.",
    slots: {
      independent: { min: 2, max: 4 },
      mediator: { min: 2, max: 2, position: "parallel" },
      moderator: { min: 0, max: 2, moderates: "main-effect" },
      dependent: { min: 1, max: 2 },
    },
    dvHints: ["burnout", "engagement", "turnover", "performance", "well-being", "exhaustion", "strain", "commitment"],
  },
  {
    id: "COR",
    name: "Conservation of Resources Theory (Hobfoll 1989)",
    domain: "organizational behavior, stress, well-being",
    shape: "[Resource Loss, Resource Gain] -> Psychological State (stress / motivation, mediator) -> Outcome (well-being, performance, withdrawal)",
    description: "People strive to acquire/protect resources; loss spirals predict negative outcomes. Use for stress, work-family, withdrawal, recovery research.",
    slots: {
      independent: { min: 1, max: 3 },
      mediator: { min: 1, max: 2, position: "serial" },
      dependent: { min: 1, max: 2 },
    },
    dvHints: ["stress", "well-being", "withdrawal", "burnout", "recovery", "performance", "work-family"],
  },
  {
    id: "SET",
    name: "Social Exchange Theory (Blau 1964)",
    domain: "organizational behavior, leadership, citizenship",
    shape: "[Perceived Organizational Support, Leader Support, Justice] -> Felt Obligation / Trust (mediator) -> Reciprocation (commitment, OCB, performance)",
    description: "Reciprocity-based explanation of voluntary effort. Use when an IV is supportive treatment and the DV is discretionary contribution.",
    slots: {
      independent: { min: 1, max: 3 },
      mediator: { min: 1, max: 2, position: "serial" },
      dependent: { min: 1, max: 2 },
    },
    dvHints: ["commitment", "ocb", "citizenship", "performance", "loyalty", "turnover", "engagement", "trust"],
  },
  {
    id: "LMX",
    name: "Leader-Member Exchange (Graen & Uhl-Bien 1995)",
    domain: "leadership, organizational behavior",
    shape: "Leader Behaviors -> LMX Quality (mediator) -> Member Outcomes (performance, satisfaction, OCB); moderators: trust, justice, individual differences",
    description: "Quality of dyadic leader-follower relationship as the mechanism. Use for leadership-style → outcome studies.",
    slots: {
      independent: { min: 1, max: 3 },
      mediator: { min: 1, max: 1, position: "serial" },
      moderator: { min: 0, max: 2, moderates: "main-effect" },
      dependent: { min: 1, max: 2 },
    },
    dvHints: ["performance", "satisfaction", "ocb", "commitment", "voice", "leader", "follower"],
  },
  {
    id: "SDT",
    name: "Self-Determination Theory (Deci & Ryan 2000)",
    domain: "motivation, education, health, work",
    shape: "[Autonomy Support, Competence Support, Relatedness Support] -> Basic Need Satisfaction (mediator) -> Autonomous Motivation (mediator) -> Outcomes (well-being, persistence, performance)",
    description: "Self-determined motivation through satisfaction of three basic needs. Use for education, health behavior, intrinsic motivation studies.",
    slots: {
      independent: { min: 2, max: 3 },
      mediator: { min: 2, max: 2, position: "serial" },
      dependent: { min: 1, max: 2 },
    },
    dvHints: ["motivation", "engagement", "well-being", "persistence", "performance", "learning", "autonomy"],
  },
  {
    id: "SCT",
    name: "Social Cognitive Theory (Bandura 1986)",
    domain: "psychology, education, health, behavior change",
    shape: "[Personal Factors (self-efficacy, outcome expectations), Environmental Factors, Behavior] interact triadically -> Behavior; Self-Efficacy is the central mediator",
    description: "Reciprocal causation between person, environment, behavior. Self-efficacy is almost always the key mediator. Use for behavior-change, learning, health.",
    slots: {
      independent: { min: 2, max: 3 },
      mediator: { min: 1, max: 2, position: "serial" },
      dependent: { min: 1, max: 2 },
    },
    dvHints: ["behavior", "self-efficacy", "performance", "learning", "health behavior", "exercise", "academic"],
  },
  {
    id: "RBV",
    name: "Resource-Based View (Barney 1991)",
    domain: "strategic management",
    shape: "VRIN Resources / Capabilities -> Sustained Competitive Advantage (mediator) -> Firm Performance; moderators: industry conditions, environmental dynamism",
    description: "Firm-level — resources that are valuable, rare, inimitable, non-substitutable drive sustained advantage. Use for firm-level performance studies.",
    slots: {
      independent: { min: 2, max: 4 },
      mediator: { min: 1, max: 2, position: "serial" },
      moderator: { min: 0, max: 2, moderates: "main-effect" },
      dependent: { min: 1, max: 1 },
    },
    dvHints: ["firm performance", "competitive advantage", "innovation", "growth", "profitability", "market share"],
  },
  {
    id: "DC",
    name: "Dynamic Capabilities (Teece 2007)",
    domain: "strategic management, innovation",
    shape: "[Sensing, Seizing, Reconfiguring] -> Dynamic Capability (mediator) -> Adaptation / Innovation -> Performance in turbulent environments",
    description: "Three-step capability (sense / seize / transform) for fast-changing markets. Use for innovation, adaptation, digital transformation studies.",
    slots: {
      independent: { min: 2, max: 3 },
      mediator: { min: 1, max: 2, position: "serial" },
      moderator: { min: 0, max: 1, moderates: "main-effect" },
      dependent: { min: 1, max: 2 },
    },
    dvHints: ["innovation", "adaptation", "transformation", "agility", "performance", "digital"],
  },
  {
    id: "COI",
    name: "Community of Inquiry (Garrison, Anderson & Archer 2000)",
    domain: "online learning, education",
    shape: "[Social Presence, Cognitive Presence, Teaching Presence] (jointly) -> Educational Experience -> Learning Outcomes",
    description: "Three interacting 'presences' explaining online/blended learning quality. Use for education, MOOC, online course research.",
    slots: {
      independent: { min: 3, max: 3 },
      mediator: { min: 0, max: 1, position: "serial" },
      dependent: { min: 1, max: 2 },
    },
    dvHints: ["learning", "satisfaction", "engagement", "online course", "mooc", "education"],
  },
];

export function backbonesAsPromptBlock(): string {
  return THEORY_BACKBONES.map(
    (b) => `  - ${b.id} | ${b.name} (${b.domain})\n    Shape: ${b.shape}\n    When to use: ${b.description}`,
  ).join("\n");
}

// Pick the top-K backbones whose dvHints intersect with the user's likely DV terms.
// Falls back to the default 8 (TAM/UTAUT/SOR/ELM/TPB/TRUST_TRANSFER/PARASOCIAL/FLOW)
// when no hints match (don't bias the AI when we have no signal).
export function recommendBackbones(dvKeywords: string[], k = 6): TheoryBackbone[] {
  const norm = dvKeywords.map((s) => s.toLowerCase());
  const scored = THEORY_BACKBONES.map((b) => {
    let score = 0;
    for (const hint of b.dvHints) {
      for (const kw of norm) {
        if (kw.includes(hint) || hint.includes(kw)) score++;
      }
    }
    return { b, score };
  });
  const matched = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k).map((s) => s.b);
  if (matched.length >= 3) return matched;
  // Not enough signal — return the original 8 plus whatever matched.
  const fallback = ["TAM", "UTAUT", "SOR", "ELM", "TPB", "TRUST_TRANSFER", "PARASOCIAL", "FLOW"];
  const defaults = THEORY_BACKBONES.filter((b) => fallback.includes(b.id));
  const merged = [...matched];
  for (const d of defaults) if (!merged.includes(d)) merged.push(d);
  return merged.slice(0, Math.max(k, 8));
}

export const STRUCTURAL_OPERATORS = [
  {
    id: "EXTEND",
    name: "Chain Extension",
    description: "Take a chain A→B→C from one paper, and append C→D from a different paper that contains C. Result: A→B→C→D. Requires a SHARED variable C between the two papers' models. CONSTRAINT: the resulting chain must respect construct-layer ordering (stimulus → cognitive → affective → intention → behavior); never go backward.",
  },
  {
    id: "INSERT_MODERATOR",
    name: "Moderator Insertion",
    description: "Take an X→Y edge from paper P1, and insert a moderator M from paper P2 that conditions that edge. Edge becomes X→Y with M moderating. Use the relationship type 'moderates' on the M→(X→Y) edge. CONSTRAINT: M MUST come from a variable whose role in P2 is 'moderator' OR is a clearly contextual/dispositional construct (personality, cognitive ability, social orientation, experience, situational context). If M is a pure mediator or a pure outcome in every paper that mentions it, do NOT use it as a moderator. The model MUST include a `moderatorJustification` field on the moderator edge explaining why M can theoretically condition X→Y.",
  },
  {
    id: "PARALLEL_MEDIATORS",
    name: "Parallel Mediators",
    description: "Same antecedent A and same dependent D, but two parallel mediator paths: A→M1→D (from P1) and A→M2→D (from P2). Useful to test competing mechanisms. CONSTRAINT: M1 and M2 should belong to the SAME construct layer (e.g. both 'affective', or both 'cognitive') so the parallel comparison is meaningful.",
  },
  {
    id: "SWAP_MEDIATOR",
    name: "Mediator Substitution",
    description: "Same A→DV path, but replace P1's mediator with P2's mediator. Asks: 'is P2's mechanism a better explanation than P1's?' CONSTRAINT: the replacement mediator must occupy the same construct layer as the original.",
  },
  {
    id: "THEORY_GRAFT",
    name: "Theory-Backbone Grafting",
    description: "Pick a classical backbone (TAM, UTAUT, S-O-R, ELM, TPB, Trust Transfer, Parasocial, Flow, JD-R, COR, SET, LMX, SDT, SCT, RBV, DC, COI) and fill EACH role of that backbone with the most-fitting variable from across the papers. The model is structurally the backbone, but every variable is grounded in this project's papers.",
  },
];

export function operatorsAsPromptBlock(): string {
  return STRUCTURAL_OPERATORS.map(
    (op) => `  - ${op.id} (${op.name}): ${op.description}`,
  ).join("\n");
}

// Construct layers in standard psychology pipeline.
// Order matters: lower index = earlier in causal chain.
export const CONSTRUCT_LAYERS = ["stimulus", "cognitive", "affective", "intention", "behavior"] as const;
export type ConstructLayer = typeof CONSTRUCT_LAYERS[number];

export function layerIndex(layer: string | null | undefined): number {
  if (!layer) return -1;
  const idx = (CONSTRUCT_LAYERS as readonly string[]).indexOf(layer.toLowerCase().trim());
  return idx;
}

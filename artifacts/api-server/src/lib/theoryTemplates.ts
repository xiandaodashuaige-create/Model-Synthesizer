export interface TheoryBackbone {
  id: string;
  name: string;
  domain: string;
  shape: string;
  description: string;
}

export const THEORY_BACKBONES: TheoryBackbone[] = [
  {
    id: "TAM",
    name: "Technology Acceptance Model (Davis 1989)",
    domain: "technology adoption",
    shape: "[Perceived Usefulness, Perceived Ease of Use] (independents) -> Attitude (mediator) -> Behavioral Intention (mediator) -> Actual Use (dependent)",
    description: "Two parallel cognitive evaluations drive attitude, attitude drives intention, intention drives behavior. Useful when the DV is adoption/use of a technology.",
  },
  {
    id: "UTAUT",
    name: "Unified Theory of Acceptance and Use of Technology (Venkatesh 2003)",
    domain: "technology adoption",
    shape: "[Performance Expectancy, Effort Expectancy, Social Influence] -> Behavioral Intention -> Use Behavior; Facilitating Conditions -> Use Behavior; moderators: Age, Gender, Experience, Voluntariness on every path",
    description: "Multi-antecedent intention model with strong moderator structure. Use when there are 3+ independents and the user wants moderators.",
  },
  {
    id: "SOR",
    name: "Stimulus-Organism-Response (Mehrabian & Russell 1974)",
    domain: "consumer behavior, environmental psychology, live commerce, retail",
    shape: "Stimulus (external cue: streamer/store/ad/atmosphere) -> Organism (internal state: emotion, trust, flow, perception) -> Response (approach/avoid: purchase, engagement, WOM)",
    description: "Classic three-stage chain. Highly applicable to live commerce, AI streamers, retail atmospherics. Stimuli are external IVs, Organism variables are mediators, Response variables are DVs.",
  },
  {
    id: "ELM",
    name: "Elaboration Likelihood Model (Petty & Cacioppo 1986)",
    domain: "persuasion, advertising, information adoption",
    shape: "[Central-route cues (argument quality), Peripheral-route cues (source credibility, attractiveness)] -> Attitude Change -> Behavioral Intention; moderator: Involvement / motivation determines which route dominates",
    description: "Dual-route persuasion. Use when the model contrasts content-quality vs surface cues, or when 'involvement' style moderator fits.",
  },
  {
    id: "TPB",
    name: "Theory of Planned Behavior (Ajzen 1991)",
    domain: "behavior prediction",
    shape: "[Attitude, Subjective Norm, Perceived Behavioral Control] -> Intention -> Behavior; PBC -> Behavior (direct)",
    description: "Three-antecedent intention model. Good when 'norms' or 'control' style variables are present.",
  },
  {
    id: "TRUST_TRANSFER",
    name: "Trust Transfer Theory (Stewart 2003)",
    domain: "platforms, intermediaries, AI agents, brand extension",
    shape: "Trust in Source A (e.g., platform / brand / human streamer) -> Trust in Target B (e.g., AI agent / new product) -> Behavioral Intention toward B",
    description: "Trust flows along a perceived link. Strong fit for AI streamer / AI agent contexts where user already trusts a platform or human.",
  },
  {
    id: "PARASOCIAL",
    name: "Parasocial Interaction / Relationship (Horton & Wohl 1956; Rubin 1985)",
    domain: "media figures, influencers, virtual streamers",
    shape: "[Streamer characteristics (anthropomorphism, attractiveness, responsiveness)] -> Parasocial Interaction (mediator) -> Parasocial Relationship -> Loyalty / Purchase Intention",
    description: "One-sided viewer-to-figure bond. Especially useful for AI/virtual streamer studies.",
  },
  {
    id: "FLOW",
    name: "Flow Theory (Csikszentmihalyi 1990; Hoffman & Novak 1996)",
    domain: "online experience, gaming, live commerce",
    shape: "[Skill, Challenge, Telepresence, Interactivity] -> Flow State (mediator: enjoyment, concentration, time distortion) -> Outcomes (purchase, satisfaction, revisit)",
    description: "Intrinsic-immersion mediator. Use when user mentions 'flow' / 'immersion' / '心流'.",
  },
];

export function backbonesAsPromptBlock(): string {
  return THEORY_BACKBONES.map(
    (b) => `  - ${b.id} | ${b.name} (${b.domain})\n    Shape: ${b.shape}\n    When to use: ${b.description}`,
  ).join("\n");
}

export const STRUCTURAL_OPERATORS = [
  {
    id: "EXTEND",
    name: "Chain Extension",
    description: "Take a chain A→B→C from one paper, and append C→D from a different paper that contains C. Result: A→B→C→D. Requires a SHARED variable C between the two papers' models.",
  },
  {
    id: "INSERT_MODERATOR",
    name: "Moderator Insertion",
    description: "Take an X→Y edge from paper P1, and insert a moderator M from paper P2 that conditions that edge. Edge becomes X→Y with M moderating. Use the relationship type 'moderates' on the M→(X→Y) edge.",
  },
  {
    id: "PARALLEL_MEDIATORS",
    name: "Parallel Mediators",
    description: "Same antecedent A and same dependent D, but two parallel mediator paths: A→M1→D (from P1) and A→M2→D (from P2). Useful to test competing mechanisms.",
  },
  {
    id: "SWAP_MEDIATOR",
    name: "Mediator Substitution",
    description: "Same A→DV path, but replace P1's mediator with P2's mediator. Asks: 'is P2's mechanism a better explanation than P1's?'",
  },
  {
    id: "THEORY_GRAFT",
    name: "Theory-Backbone Grafting",
    description: "Pick a classical backbone (TAM, UTAUT, S-O-R, ELM, TPB, Trust Transfer, Parasocial, Flow) and fill EACH role of that backbone with the most-fitting variable from across the papers. The model is structurally the backbone, but every variable is grounded in this project's papers.",
  },
];

export function operatorsAsPromptBlock(): string {
  return STRUCTURAL_OPERATORS.map(
    (op) => `  - ${op.id} (${op.name}): ${op.description}`,
  ).join("\n");
}

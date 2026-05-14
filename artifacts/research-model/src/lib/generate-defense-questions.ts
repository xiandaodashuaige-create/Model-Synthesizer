import type { InnovationMeta } from "@workspace/api-client-react";

export type DefenseQuestionSeverity = "high" | "medium" | "low";

export interface DefenseQuestion {
  id: string;
  question: string;
  severity: DefenseQuestionSeverity;
  /** Lower = more urgent. Used to sort within the same severity bucket. */
  sortScore: number;
}

const SEVERITY_ORDER: Record<DefenseQuestionSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const FALLBACK: DefenseQuestion[] = [
  {
    id: "fb-context",
    question:
      "你的研究样本情境与已有文献的情境有何不同？这一差异如何影响研究结论的外部效度？",
    severity: "low",
    sortScore: 100,
  },
  {
    id: "fb-boundary",
    question:
      "理论模型的边界条件是什么？在哪些情境下这些变量之间的关系可能不成立？",
    severity: "low",
    sortScore: 100,
  },
  {
    id: "fb-gap-process",
    question:
      "研究缺口的识别过程依赖了哪些判断标准？这些标准是否具有足够的客观依据？",
    severity: "low",
    sortScore: 100,
  },
];

// Matches Chinese reason text for "no literature support":
// 尚无 / 未有 / 无记录 / 无文献 / 无直接 or the English shorthand "no citation"
const NO_CITATION_RE = /尚无|未有|无记录|无文献|无直接|no.?cit/i;

export function generateDefenseQuestions(
  meta: InnovationMeta,
): DefenseQuestion[] {
  const {
    subScores,
    contributionScore,
    computedAgainst,
    mode,
    edgeNoveltyTags,
  } = meta;
  const { coverageRate } = computedAgainst;

  const questions: DefenseQuestion[] = [];

  // ── High severity rules ────────────────────────────────────────────────────

  // R1: evidence support critically low
  if (subScores.evidenceSupport < 50) {
    questions.push({
      id: "evidence-support-low",
      question:
        "模型中部分关系缺乏直接文献支撑，答辩委员可能质疑：这些关系的理论依据是什么？你如何在没有直接证据的情况下论证其存在？",
      severity: "high",
      sortScore: subScores.evidenceSupport,
    });
  }

  // R2: gap fit critically low — model may not address a real gap
  if (subScores.gapFit < 50) {
    questions.push({
      id: "gap-fit-low",
      question:
        "你声称填补的研究缺口，在现有文献中是否已有类似研究覆盖？如果有，本研究与之相比的增量贡献是什么？",
      severity: "high",
      sortScore: subScores.gapFit,
    });
  }

  // R3: contradicting edge present but no moderator edge to resolve it
  const hasContradicting = edgeNoveltyTags.some((e) => e.tag === "contradicting");
  const hasModeratorEdge = edgeNoveltyTags.some(
    (e) => e.relationship === "moderates",
  );
  if (hasContradicting && !hasModeratorEdge) {
    questions.push({
      id: "contradicting-no-moderator",
      question:
        "你的模型中存在与已有文献结论相矛盾的关系，但未引入调节变量来解释这一分歧，答辩委员可能问：如何在理论层面解释这一冲突？是文献错了，还是情境不同？",
      severity: "high",
      sortScore: 0,
    });
  }

  // ── Medium severity rules ──────────────────────────────────────────────────

  // R4: differentiation below threshold
  if (subScores.differentiation < 60) {
    questions.push({
      id: "differentiation-low",
      question:
        "与已有模型相比，本研究的理论贡献如何区分？你的模型在哪些关键维度上超越了现有研究，而不只是重复验证？",
      severity: "medium",
      sortScore: subScores.differentiation,
    });
  }

  // R5: theoretical soundness below threshold
  if (subScores.theoreticalSoundness < 60) {
    questions.push({
      id: "theory-low",
      question:
        "模型的理论基础来自哪些主流理论框架？各变量之间的因果推断依据是什么，有没有成熟的理论支撑这种因果方向？",
      severity: "medium",
      sortScore: subScores.theoreticalSoundness,
    });
  }

  // R6: novel edges where reason indicates no citation support, or where no
  // literature match was found (matchedRelationship === null is the reliable
  // proxy; NO_CITATION_RE catches explicit reason text as an additional signal)
  const novelEdgesWithNoCitation = edgeNoveltyTags.filter(
    (e) =>
      e.tag === "novel" &&
      (e.matchedRelationship === null || NO_CITATION_RE.test(e.reason)),
  );
  if (novelEdgesWithNoCitation.length > 0) {
    const names = novelEdgesWithNoCitation
      .slice(0, 3)
      .map((e) => `${e.fromVariableName} → ${e.toVariableName}`)
      .join("、");
    const suffix = novelEdgesWithNoCitation.length > 3 ? "等" : "";
    const lowestSubscore = Math.min(
      ...novelEdgesWithNoCitation.map((e) => e.subscore),
    );
    questions.push({
      id: "novel-no-citation",
      question: `模型中存在未被现有文献直接支撑的新颖关系（${names}${suffix}），如何保证其理论效度？你在没有先例支撑的情况下，为何认为这一关系存在？`,
      severity: "medium",
      sortScore: lowestSubscore,
    });
  }

  // R7: analysis-only mode (coverage too low for enforcement) — independent of R8
  if (mode === "analysis_only") {
    const pct = Math.round(coverageRate * 100);
    questions.push({
      id: "analysis-only",
      question: `当前文献覆盖率为 ${pct}%，尚未达到充分论证水平，答辩委员可能问：为什么仍选择此研究方向？你打算如何补充文献来强化理论论证？`,
      severity: "medium",
      sortScore: coverageRate * 100,
    });
  }

  // R8: coverage low but not analysis_only — independent of R7; both can fire
  if (coverageRate < 0.7) {
    questions.push({
      id: "coverage-low",
      question:
        "文献覆盖率偏低，模型中是否存在尚未被文献充分涵盖的核心变量？如何确保所选变量的理论代表性？",
      severity: "medium",
      sortScore: coverageRate * 100,
    });
  }

  // R9: overall contribution score low
  if (contributionScore < 60) {
    questions.push({
      id: "contribution-low",
      question:
        "整体贡献评分偏低，你认为本研究最薄弱的维度是什么？在提交前有哪些具体的补强方案？",
      severity: "medium",
      sortScore: contributionScore,
    });
  }

  // ── Sort: severity bucket first, then by sortScore ascending (lower = more urgent) ──
  questions.sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sev !== 0) return sev;
    return a.sortScore - b.sortScore;
  });

  // ── Pad to at least 5 with fallbacks ─────────────────────────────────────
  let fi = 0;
  while (questions.length < 5 && fi < FALLBACK.length) {
    questions.push(FALLBACK[fi++]);
  }

  // Cap at 8
  return questions.slice(0, 8);
}

// Model generation readiness pre-flight check.
// Pure algorithm — no AI calls, no DB calls (caller passes pre-loaded data).
// Returns a structured result so the route can return 422 with actionable detail.

export type ReadinessIssueType =
  | "no_iv"
  | "no_dv"
  | "too_many_dvs"
  | "low_paper_count"
  | "all_single_paper_variables"
  | "no_cross_paper_overlap"
  | "no_construct_relationships"
  | "domain_mismatch_suspected";

export interface ReadinessIssue {
  type: ReadinessIssueType;
  severity: "blocking" | "warning";
  message: string;
  detail?: string;
}

export interface CandidateDv {
  id: number;
  name: string;
  paperCount: number;
}

export interface ReadinessResult {
  status: "ok" | "warning" | "blocked";
  issues: ReadinessIssue[];
  candidateDvs: CandidateDv[];
}

interface ReadinessInputVariable {
  id: number;
  type: string;
  name: string;
  paperId: number | null;
  canonicalConstructId: string | null;
}

interface ReadinessInput {
  variables: ReadinessInputVariable[];
  focusVariableIds: number[];
  crCount: number;
  userPrompt?: string;
  sessionId?: number;
}

// Bio/engineering keyword list for R8. Checked against lowercased variable names.
const DOMAIN_MISMATCH_KEYWORDS = [
  "protein", "enzyme", "residue", "atpase", "microtubule", "gene",
  "molecular", "phosphorylation", "kinase", "receptor", "ligand",
  "amino acid", "nucleotide", "chromosome", "pathogen", "antibody",
];

export function checkModelGenerationReadiness(input: ReadinessInput): ReadinessResult {
  const { variables, focusVariableIds, crCount, userPrompt } = input;

  const issues: ReadinessIssue[] = [];
  let candidateDvs: CandidateDv[] = [];

  const ivs = variables.filter((v) => v.type === "independent");
  const dvs = variables.filter((v) => v.type === "dependent");

  // R2 — no IVs
  if (ivs.length === 0) {
    issues.push({
      type: "no_iv",
      severity: "blocking",
      message: "变量池中没有自变量（IV），无法构建因果链",
    });
  }

  // R3 — no DVs
  if (dvs.length === 0) {
    issues.push({
      type: "no_dv",
      severity: "blocking",
      message: "变量池中没有因变量（DV），无法确定研究终点",
    });
  }

  // R4 — too many DVs without a focused target
  if (dvs.length >= 8) {
    const focusSet = new Set(focusVariableIds);
    const hasFocusedDv = dvs.some((dv) => focusSet.has(dv.id));
    if (!hasFocusedDv) {
      // Build candidateDvs: count distinct papers per DV (by canonicalConstructId or name)
      const dvPaperCounts = dvs.map((dv) => {
        // A DV may appear in multiple variables rows across papers
        const key = dv.canonicalConstructId !== null
          ? `cid:${dv.canonicalConstructId}`
          : `name:${dv.name.toLowerCase().trim()}`;
        return { dv, key };
      });

      // Group DVs by canonical key to deduplicate, count contributing paper IDs
      const dvGroupMap = new Map<string, { id: number; name: string; paperIds: Set<number> }>();
      for (const { dv, key } of dvPaperCounts) {
        const existing = dvGroupMap.get(key);
        const paperId = dv.paperId;
        if (existing) {
          if (paperId !== null) existing.paperIds.add(paperId);
        } else {
          dvGroupMap.set(key, {
            id: dv.id,
            name: dv.name,
            paperIds: new Set(paperId !== null ? [paperId] : []),
          });
        }
      }

      candidateDvs = Array.from(dvGroupMap.values())
        .map((g) => ({ id: g.id, name: g.name, paperCount: g.paperIds.size }))
        .sort((a, b) => b.paperCount - a.paperCount)
        .slice(0, 5);

      issues.push({
        type: "too_many_dvs",
        severity: "blocking",
        message: `检测到 ${dvs.length} 个因变量，AI 无法锁定研究终点。请在变量页钉选 1 个目标因变量后重试`,
        detail: String(dvs.length),
      });
    }
  }

  // Compute unique paper count from variables (papers already filtered: no manual, no tangential)
  const uniquePaperIds = new Set(variables.map((v) => v.paperId).filter((id): id is number => id !== null));
  const uniquePaperCount = uniquePaperIds.size;

  // R5 — few papers (warning only)
  if (uniquePaperCount < 3) {
    issues.push({
      type: "low_paper_count",
      severity: "warning",
      message: `当前只有 ${uniquePaperCount} 篇论文贡献了变量，建议补充至 5 篇以上以支撑跨论文创新`,
      detail: String(uniquePaperCount),
    });
  }

  // R6 — all variables are single-paper (blocking, only when paper count < 3 to avoid false positives)
  if (uniquePaperCount < 3) {
    // Build a map: canonicalKey -> Set<paperId>
    const constructPaperMap = new Map<string, Set<number>>();
    for (const v of variables) {
      if (v.paperId === null) continue;
      const key = v.canonicalConstructId !== null
        ? `cid:${v.canonicalConstructId}`
        : `name:${v.name.toLowerCase().trim()}`;
      const existing = constructPaperMap.get(key);
      if (existing) {
        existing.add(v.paperId);
      } else {
        constructPaperMap.set(key, new Set([v.paperId]));
      }
    }

    const allSinglePaper = constructPaperMap.size > 0
      && Array.from(constructPaperMap.values()).every((paperIds) => paperIds.size <= 1);

    if (allSinglePaper) {
      issues.push({
        type: "all_single_paper_variables",
        severity: "blocking",
        message: "所有变量都只出现在单篇论文中，缺少跨论文重叠基础，AI 无法生成有证据支撑的组合模型",
      });
    }
  }

  // R9 — no cross-paper construct overlap (fires only when uniquePaperCount >= 3;
  // R6 covers the < 3 case already)
  if (uniquePaperCount >= 3) {
    const constructPaperMap = new Map<string, Set<number>>();
    for (const v of variables) {
      if (v.paperId === null) continue;
      const key = v.canonicalConstructId !== null
        ? `cid:${v.canonicalConstructId}`
        : `name:${v.name.toLowerCase().trim()}`;
      if (!constructPaperMap.has(key)) constructPaperMap.set(key, new Set());
      constructPaperMap.get(key)!.add(v.paperId);
    }

    const crossPaperCount = Array.from(constructPaperMap.values())
      .filter((paperIds) => paperIds.size >= 2).length;

    if (crossPaperCount === 0 && constructPaperMap.size > 0) {
      const hasExplicitIntent =
        focusVariableIds.length > 0 ||
        (userPrompt !== undefined && userPrompt.trim().length > 0);

      issues.push({
        type: "no_cross_paper_overlap",
        severity: hasExplicitIntent ? "warning" : "blocking",
        message: hasExplicitIntent
          ? `${uniquePaperCount} 篇论文中没有共同构念——模型证据将完全分散，但系统将尊重你的指定方向继续尝试`
          : `${uniquePaperCount} 篇论文中没有任何共同构念，AI 无法构建跨论文组合模型。建议：搜索与现有变量同类的文献，或减少切换主题的论文`,
        detail: `crossPaperConstructs:0,totalConstructs:${constructPaperMap.size}`,
      });
    }
  }

  // R7 — no construct relationships (warning only)
  if (crCount === 0) {
    issues.push({
      type: "no_construct_relationships",
      severity: "warning",
      message: "文献全景尚未建立，建议先在「文献全景」页面生成一次，以提升模型生成质量",
    });
  }

  // R8 — suspected non-social-science domain (warning only)
  const sampleNames = variables.slice(0, 20).map((v) => v.name.toLowerCase());
  const domainMismatchVarCount = sampleNames.filter((name) =>
    DOMAIN_MISMATCH_KEYWORDS.some((kw) => name.includes(kw)),
  ).length;
  if (domainMismatchVarCount >= 3) {
    issues.push({
      type: "domain_mismatch_suspected",
      severity: "warning",
      message: "检测到生物/工程领域词汇，本系统针对社会科学 SEM 模型设计，建议更换社会科学文献",
      detail: String(domainMismatchVarCount),
    });
  }

  const hasBlocking = issues.some((i) => i.severity === "blocking");
  const hasWarning = issues.some((i) => i.severity === "warning");

  const status: ReadinessResult["status"] = hasBlocking
    ? "blocked"
    : hasWarning
      ? "warning"
      : "ok";

  return { status, issues, candidateDvs };
}

export function deriveRecommendedActions(issues: ReadinessIssue[]): string[] {
  const actions: string[] = [];
  const types = new Set(issues.map((i) => i.type));

  if (types.has("too_many_dvs")) {
    actions.push("请在变量页钉选 1 个目标因变量");
  }
  if (types.has("all_single_paper_variables")) {
    actions.push("补充同一研究主题的相关论文（5–10 篇）");
  }
  if (types.has("no_cross_paper_overlap")) {
    actions.push("搜索与现有变量同类的文献，使各论文之间有共同的研究构念");
  }
  if (types.has("no_construct_relationships")) {
    actions.push("先在「文献全景」页面生成全景分析");
  }
  if (types.has("domain_mismatch_suspected")) {
    actions.push("跳过领域不相关的论文，或更换社会科学文献");
  }
  if (types.has("no_iv")) {
    actions.push("请确认自变量已被正确提取（类型标注为「自变量」）");
  }
  if (types.has("no_dv")) {
    actions.push("请确认因变量已被正确提取（类型标注为「因变量」）");
  }
  if (types.has("low_paper_count")) {
    actions.push("补充更多同主题论文以覆盖更多研究证据");
  }

  return actions;
}

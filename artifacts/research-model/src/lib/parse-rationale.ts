export interface ParsedRationale {
  operator: string | null;
  secondaryOperator: string | null;
  base: string | null;
  backbone: string | null;
  topicFit: string | null;
  focusFit: string | null;
  userPromptFit: string | null;
  qualityWarning: string | null;
  freeText: string;
}

const OPERATOR_LABELS: Record<string, string> = {
  EXTEND: "边界延伸",
  INSERT_MODERATOR: "添加调节变量",
  PARALLEL_MEDIATORS: "并列中介",
  SWAP_MEDIATOR: "替换中介",
  THEORY_GRAFT: "理论嫁接",
};

export function operatorLabel(op: string): string {
  return OPERATOR_LABELS[op] ?? op;
}

export function parseRationale(raw: string): ParsedRationale {
  let text = raw ?? "";

  const extract = (pattern: RegExp): string | null => {
    const m = text.match(pattern);
    if (!m) return null;
    text = text.replace(pattern, "").trim();
    return m[1]?.trim() ?? null;
  };

  const operatorRaw = extract(/\[OPERATOR:\s*([^\]]+)\]/i);
  const base = extract(/\[BASE:\s*([^\]]+)\]/i);
  const backbone = extract(/\[BACKBONE:\s*([^\]]+)\]/i);
  const topicFit = extract(/\[TOPIC FIT\]\s*(.+?)(?=\[|$)/is);
  const focusFit = extract(/\[FOCUS FIT\]\s*(.+?)(?=\[|$)/is);
  const userPromptFit = extract(/\[USER PROMPT FIT\]\s*(.+?)(?=\[|$)/is);
  const qualityWarning = extract(/\[质量警告[：:]\s*([^\]]+)\]/);

  let operator: string | null = null;
  let secondaryOperator: string | null = null;
  if (operatorRaw) {
    const parts = operatorRaw.split("+").map((s) => s.trim());
    operator = parts[0] ?? null;
    secondaryOperator = parts[1] ?? null;
  }

  const freeText = text
    .replace(/^\s*[\n\r]+/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { operator, secondaryOperator, base, backbone, topicFit, focusFit, userPromptFit, qualityWarning, freeText };
}

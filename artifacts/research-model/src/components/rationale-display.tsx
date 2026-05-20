import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { parseRationale, operatorLabel } from "@/lib/parse-rationale";

interface RationaleDisplayProps {
  rationale: string;
  compact?: boolean;
}

function isNa(s: string | null): boolean {
  if (!s) return true;
  return /^n\/a\b/i.test(s.trim());
}

function Pill({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
      {label}
    </span>
  );
}

export function RationaleDisplay({ rationale, compact = false }: RationaleDisplayProps) {
  const [expanded, setExpanded] = useState(false);
  const p = parseRationale(rationale);

  const pills: string[] = [];
  if (p.operator) pills.push(operatorLabel(p.operator));
  if (p.secondaryOperator) pills.push(operatorLabel(p.secondaryOperator));
  if (p.backbone && p.backbone !== "NONE") pills.push(p.backbone);

  const hasFit = !isNa(p.topicFit) || !isNa(p.focusFit) || !isNa(p.userPromptFit);

  return (
    <div className="space-y-2">
      {p.qualityWarning && (
        <div className="rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <span className="font-semibold">质量提示：</span>{p.qualityWarning}
        </div>
      )}

      {!compact && pills.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {pills.map((label) => <Pill key={label} label={label} />)}
        </div>
      )}

      {p.freeText && (
        <p className="text-sm text-foreground leading-relaxed">{p.freeText}</p>
      )}

      {!compact && hasFit && (
        <div>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            对齐说明
          </button>
          {expanded && (
            <div className="mt-2 space-y-1.5 text-xs text-muted-foreground border-l-2 border-border pl-3">
              {!isNa(p.topicFit) && (
                <p><span className="font-medium text-foreground/70">主题适配：</span>{p.topicFit}</p>
              )}
              {!isNa(p.focusFit) && (
                <p><span className="font-medium text-foreground/70">重点变量：</span>{p.focusFit}</p>
              )}
              {!isNa(p.userPromptFit) && (
                <p><span className="font-medium text-foreground/70">用户指令：</span>{p.userPromptFit}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

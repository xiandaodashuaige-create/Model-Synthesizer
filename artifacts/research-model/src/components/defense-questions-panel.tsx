import React from "react";
import { GraduationCap, AlertCircle, AlertTriangle, Info } from "lucide-react";
import type { InnovationMeta } from "@workspace/api-client-react";
import { generateDefenseQuestions, type DefenseQuestionSeverity } from "@/lib/generate-defense-questions";

const SEVERITY_CONFIG: Record<
  DefenseQuestionSeverity,
  { icon: React.ReactNode; rowCls: string; dotCls: string; label: string }
> = {
  high: {
    icon: <AlertCircle className="w-3.5 h-3.5 shrink-0 text-rose-600 mt-0.5" />,
    rowCls: "bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800/60",
    dotCls: "bg-rose-500",
    label: "重要",
  },
  medium: {
    icon: <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-600 mt-0.5" />,
    rowCls: "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800/60",
    dotCls: "bg-amber-500",
    label: "注意",
  },
  low: {
    icon: <Info className="w-3.5 h-3.5 shrink-0 text-slate-500 mt-0.5" />,
    rowCls: "bg-slate-50 dark:bg-slate-900/30 border-slate-200 dark:border-slate-700",
    dotCls: "bg-slate-400",
    label: "建议",
  },
};

export function DefenseQuestionsPanel({
  meta,
}: {
  meta: InnovationMeta | null | undefined;
}) {
  if (!meta) return null;

  const questions = generateDefenseQuestions(meta);
  if (questions.length === 0) return null;

  const highCount = questions.filter((q) => q.severity === "high").length;
  const medCount = questions.filter((q) => q.severity === "medium").length;

  return (
    <div
      data-testid="panel-defense-questions"
      className="rounded-lg border border-border bg-card p-4 space-y-3"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <GraduationCap className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">可能的答辩问题</h3>
        </div>
        <div className="flex items-center gap-2">
          {highCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-rose-300 bg-rose-50 text-rose-800 px-2 py-0.5 text-[10px] font-semibold dark:border-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-500 inline-block" />
              {highCount} 项重点关注
            </span>
          )}
          {medCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 text-amber-800 px-2 py-0.5 text-[10px] font-semibold dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
              {medCount} 项需关注
            </span>
          )}
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground leading-relaxed">
        以下问题基于模型的创新指标自动生成，帮助你预判答辩委员可能的质疑方向。零 AI 成本，纯规则推断。
      </p>

      {/* Question list */}
      <div className="space-y-2">
        {questions.map((q, idx) => {
          const cfg = SEVERITY_CONFIG[q.severity];
          return (
            <div
              key={q.id}
              data-testid={`defense-question-${idx}`}
              className={`rounded-md border px-3 py-2.5 flex items-start gap-2.5 ${cfg.rowCls}`}
            >
              {cfg.icon}
              <div className="flex-1 min-w-0 text-[12px] leading-relaxed text-foreground">
                <span className="font-mono text-[10px] text-muted-foreground mr-1.5">
                  Q{idx + 1}
                </span>
                {q.question}
              </div>
              <span
                className={`shrink-0 mt-0.5 rounded-sm text-[9px] font-semibold px-1 py-0.5 text-white ${cfg.dotCls}`}
              >
                {cfg.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

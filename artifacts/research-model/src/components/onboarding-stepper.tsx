import React from "react";
import { Link } from "wouter";
import { FileText, Database, Share2, CheckCircle2, Circle, ArrowRight, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

type Status = "done" | "current" | "todo";

type Step = {
  key: "papers" | "variables" | "models" | "select";
  titleKey: any;
  descKey: any;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  status: Status;
};

export function OnboardingStepper({
  sessionId,
  paperCount,
  variableCount,
  modelCount,
  hasSelectedModel,
}: {
  sessionId: number;
  paperCount: number;
  variableCount: number;
  modelCount: number;
  hasSelectedModel: boolean;
}) {
  const { t } = useT();

  const stat = (done: boolean, current: boolean): Status => (done ? "done" : current ? "current" : "todo");

  const papersDone = paperCount > 0;
  const varsDone = variableCount > 0;
  const modelsDone = modelCount > 0;
  const selectDone = hasSelectedModel;

  const currentIdx = !papersDone ? 0 : !varsDone ? 1 : !modelsDone ? 2 : !selectDone ? 3 : 3;

  const steps: Step[] = [
    {
      key: "papers",
      titleKey: "step.papers.title" as const,
      descKey: "step.papers.desc" as const,
      href: `/sessions/${sessionId}/papers`,
      icon: FileText,
      status: stat(papersDone, currentIdx === 0),
    },
    {
      key: "variables",
      titleKey: "step.variables.title" as const,
      descKey: "step.variables.desc" as const,
      href: varsDone ? `/sessions/${sessionId}/variables` : `/sessions/${sessionId}/papers`,
      icon: Database,
      status: stat(varsDone, currentIdx === 1),
    },
    {
      key: "models",
      titleKey: "step.models.title" as const,
      descKey: "step.models.desc" as const,
      href: `/sessions/${sessionId}/models`,
      icon: Share2,
      status: stat(modelsDone, currentIdx === 2),
    },
    {
      key: "select",
      titleKey: "step.select.title" as const,
      descKey: "step.select.desc" as const,
      href: `/sessions/${sessionId}/models`,
      icon: Trophy,
      status: stat(selectDone, currentIdx === 3 && modelsDone),
    },
  ];

  return (
    <div className="bg-card border border-border rounded-lg p-4 md:p-5">
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("step.label" as any)}</p>
      </div>
      <ol className="grid grid-cols-1 md:grid-cols-4 gap-3">
        {steps.map((s, i) => {
          const Icon = s.icon;
          const isDone = s.status === "done";
          const isCurrent = s.status === "current";
          return (
            <li key={s.key} className="relative">
              <Link
                href={s.href}
                className={cn(
                  "flex items-start gap-3 p-3 rounded-md border transition-colors h-full",
                  isDone && "border-primary/40 bg-primary/5 hover:bg-primary/10",
                  isCurrent && "border-primary bg-primary/5 ring-2 ring-primary/20",
                  !isDone && !isCurrent && "border-border bg-background hover:border-border/80",
                )}
              >
                <div
                  className={cn(
                    "shrink-0 w-8 h-8 rounded-full flex items-center justify-center",
                    isDone && "bg-primary text-primary-foreground",
                    isCurrent && "bg-primary text-primary-foreground",
                    !isDone && !isCurrent && "bg-muted text-muted-foreground",
                  )}
                >
                  {isDone ? <CheckCircle2 className="w-5 h-5" /> : <Icon className="w-4 h-4" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p
                    className={cn(
                      "text-sm font-semibold",
                      isCurrent || isDone ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {t(s.titleKey)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{t(s.descKey)}</p>
                  <p
                    className={cn(
                      "text-xs mt-1.5 inline-flex items-center gap-1 font-medium",
                      isDone && "text-primary",
                      isCurrent && "text-primary",
                      !isDone && !isCurrent && "text-muted-foreground",
                    )}
                  >
                    {isDone
                      ? t("step.status.done" as any)
                      : isCurrent
                        ? t("step.status.current" as any)
                        : t("step.status.todo" as any)}
                    {isCurrent && <ArrowRight className="w-3 h-3" />}
                  </p>
                </div>
              </Link>
              {i < steps.length - 1 && (
                <div className="hidden md:block absolute top-1/2 -right-2 w-3 h-px bg-border -translate-y-1/2" />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function BigNextStep({
  eyebrow,
  title,
  body,
  href,
  cta,
  disabled,
  disabledReason,
}: {
  eyebrow: string;
  title: string;
  body: string;
  href: string;
  cta: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const sharedBtnClass =
    "shrink-0 inline-flex items-center justify-center gap-2 rounded-lg text-base font-semibold h-14 px-8 shadow-md transition-colors";
  return (
    <div className="mt-8 rounded-xl border-2 border-primary/30 bg-gradient-to-br from-primary/10 via-primary/5 to-background p-8 shadow-lg">
      <div className="flex flex-col md:flex-row md:items-center gap-6">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold text-primary uppercase tracking-widest mb-2">{eyebrow}</p>
          <h3 className="text-2xl font-serif font-bold text-foreground mb-2">{title}</h3>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl">{body}</p>
          {disabled && disabledReason ? (
            <p className="mt-3 text-xs font-medium text-amber-700 dark:text-amber-400">{disabledReason}</p>
          ) : null}
        </div>
        {disabled ? (
          <button
            type="button"
            disabled
            aria-disabled="true"
            data-testid="button-big-next-step"
            className={`${sharedBtnClass} bg-muted text-muted-foreground cursor-not-allowed opacity-70`}
          >
            <span className="inline-block w-4 h-4 border-2 border-muted-foreground/40 border-t-muted-foreground rounded-full animate-spin" />
            {cta}
          </button>
        ) : (
          <Link
            href={href}
            data-testid="button-big-next-step"
            className={`${sharedBtnClass} bg-primary text-primary-foreground hover:bg-primary/90 hover:shadow-lg`}
          >
            {cta}
            <ArrowRight className="w-5 h-5" />
          </Link>
        )}
      </div>
    </div>
  );
}

export function NextStepHint({
  title,
  body,
  href,
  cta,
  onClick,
  disabled,
  loading,
}: {
  title: string;
  body: string;
  href?: string;
  cta: string;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  const btnClass =
    "shrink-0 inline-flex items-center gap-1.5 rounded-md text-xs font-medium h-8 px-3 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  return (
    <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 flex items-start gap-3">
      <div className="shrink-0 w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
        <ArrowRight className="w-4 h-4" />
      </div>
      <div className="flex-1">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{body}</p>
      </div>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          disabled={disabled || loading}
          className={btnClass}
          data-testid="button-next-step-cta"
        >
          {loading ? (
            <span className="inline-block w-3.5 h-3.5 border-2 border-primary-foreground/40 border-t-primary-foreground rounded-full animate-spin" />
          ) : null}
          {cta}
          {!loading && <ArrowRight className="w-3.5 h-3.5" />}
        </button>
      ) : (
        <Link href={href ?? "#"} className={btnClass}>
          {cta}
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      )}
    </div>
  );
}

import { AlertTriangle, XCircle } from "lucide-react";
import { useT } from "@/lib/i18n";

interface ReadinessIssue {
  type: string;
  severity: "blocking" | "warning";
  message: string;
  detail?: string;
}

interface CandidateDv {
  id: number;
  name: string;
  paperCount: number;
}

export interface GenerationReadinessError {
  code: string;
  message: string;
  issues: ReadinessIssue[];
  candidateDvs?: CandidateDv[];
  recommendedActions?: string[];
}

interface ReadinessErrorCardProps {
  error: GenerationReadinessError;
  sessionId: number;
  onDismiss?: () => void;
}

export function ReadinessErrorCard({ error, sessionId, onDismiss }: ReadinessErrorCardProps) {
  const { t } = useT();

  const blockingIssues = error.issues.filter((i) => i.severity === "blocking");
  const warningIssues = error.issues.filter((i) => i.severity === "warning");
  const hasCandidates = error.candidateDvs && error.candidateDvs.length > 0;
  const hasActions = error.recommendedActions && error.recommendedActions.length > 0;

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
          <span className="font-semibold text-amber-900 text-sm">
            {t("readiness.title" as any)}
          </span>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="text-amber-500 hover:text-amber-700 shrink-0"
            aria-label="关闭"
          >
            <XCircle className="h-4 w-4" />
          </button>
        )}
      </div>

      {blockingIssues.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-red-700">{t("readiness.blocking" as any)}</p>
          <ul className="space-y-1">
            {blockingIssues.map((issue, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-red-800">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {warningIssues.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-amber-700">{t("readiness.warnings" as any)}</p>
          <ul className="space-y-1">
            {warningIssues.map((issue, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-amber-800">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasCandidates && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-slate-600">{t("readiness.candidateDvs" as any)}</p>
          <div className="flex flex-wrap gap-1.5">
            {error.candidateDvs!.map((dv) => (
              <a
                key={dv.id}
                href={`/sessions/${sessionId}/variables`}
                className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-2.5 py-0.5 text-xs text-slate-700 hover:bg-slate-50 transition-colors"
                title={`${dv.paperCount} 篇论文支持`}
              >
                {dv.name}
                {dv.paperCount > 1 && (
                  <span className="text-slate-400">×{dv.paperCount}</span>
                )}
              </a>
            ))}
          </div>
        </div>
      )}

      {hasActions && (
        <div className="space-y-1.5 pt-1 border-t border-amber-200">
          <p className="text-xs font-medium text-slate-600">{t("readiness.actions" as any)}</p>
          <ol className="space-y-1">
            {error.recommendedActions!.map((action, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-slate-700">
                <span className="shrink-0 font-medium text-amber-600">{i + 1}.</span>
                <span>{action}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

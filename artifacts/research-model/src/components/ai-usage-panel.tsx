import { useState } from "react";
import { useGetSessionAiUsage, getGetSessionAiUsageQueryKey } from "@workspace/api-client-react";
import { Activity, ChevronDown, ChevronUp } from "lucide-react";
import { useT } from "@/lib/i18n";

function fmtUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function AiUsagePanel({ sessionId }: { sessionId: number }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError, error } = useGetSessionAiUsage(sessionId, {
    query: { enabled: !!sessionId, queryKey: getGetSessionAiUsageQueryKey(sessionId), refetchInterval: open ? 15_000 : false },
  });

  if (!sessionId) return null;

  const totalCost = data?.totalCostUsd ?? 0;
  const totalCalls = data?.totalCalls ?? 0;
  const totalTokens = data?.totalTokens ?? 0;
  const panelId = `ai-usage-panel-body-${sessionId}`;

  return (
    <div className="bg-card border border-border rounded-lg shadow-sm" data-testid="ai-usage-panel">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="w-full px-4 py-2.5 flex items-center justify-between text-sm hover:bg-muted/40 transition-colors rounded-lg"
        data-testid="ai-usage-toggle"
      >
        <span className="flex items-center gap-2 text-muted-foreground">
          <Activity className="w-4 h-4" />
          <span className="font-medium text-foreground">{t("usage.title" as any)}</span>
          {!isLoading && !isError && data && (
            <span className="ml-1 text-xs">
              {fmtUsd(totalCost)} · {fmtNum(totalTokens)} {t("usage.tokens" as any)} · {totalCalls} {t("usage.calls" as any)}
            </span>
          )}
          {isError && (
            <span className="ml-1 text-xs text-destructive">{t("usage.error" as any)}</span>
          )}
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>

      {open && (
        <div id={panelId} className="border-t border-border px-4 py-3">
          {isLoading && <div className="text-xs text-muted-foreground">{t("common.loading" as any)}</div>}
          {!isLoading && isError && (
            <div className="text-xs text-destructive">
              {t("usage.error" as any)}
              {error instanceof Error && error.message ? `: ${error.message}` : ""}
            </div>
          )}
          {!isLoading && !isError && (data?.byRoute?.length ?? 0) === 0 && (
            <div className="text-xs text-muted-foreground">{t("usage.empty" as any)}</div>
          )}
          {!isLoading && !isError && (data?.byRoute?.length ?? 0) > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left font-medium py-1.5 pr-3">{t("usage.col.route" as any)}</th>
                    <th className="text-right font-medium py-1.5 px-2">{t("usage.col.calls" as any)}</th>
                    <th className="text-right font-medium py-1.5 px-2">{t("usage.col.tokens" as any)}</th>
                    <th className="text-right font-medium py-1.5 pl-2">{t("usage.col.cost" as any)}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(data?.byRoute ?? [])]
                    .sort((a, b) => b.costUsd - a.costUsd)
                    .map((r) => (
                      <tr key={r.route} className="border-b border-border last:border-b-0" data-testid={`ai-usage-row-${r.route}`}>
                        <td className="py-1.5 pr-3 font-mono text-foreground">{r.route}</td>
                        <td className="py-1.5 px-2 text-right text-muted-foreground">{r.calls}</td>
                        <td className="py-1.5 px-2 text-right text-muted-foreground">{fmtNum(r.totalTokens)}</td>
                        <td className="py-1.5 pl-2 text-right text-foreground">{fmtUsd(r.costUsd)}</td>
                      </tr>
                    ))}
                  <tr className="font-medium">
                    <td className="py-1.5 pr-3 text-foreground">{t("usage.total" as any)}</td>
                    <td className="py-1.5 px-2 text-right">{totalCalls}</td>
                    <td className="py-1.5 px-2 text-right">{fmtNum(totalTokens)}</td>
                    <td className="py-1.5 pl-2 text-right">{fmtUsd(totalCost)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

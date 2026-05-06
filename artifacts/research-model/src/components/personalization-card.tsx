import React from "react";
import { Brain, RefreshCw, Trash2, Loader2 } from "lucide-react";
import {
  useGetMyPersonalization,
  useRefreshMyPersonalization,
  useForgetMyPersonalization,
  getGetMyPersonalizationQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "@/lib/i18n";

export function PersonalizationCard(): React.ReactElement | null {
  const { t } = useT();
  const qc = useQueryClient();
  const { data, isLoading, error } = useGetMyPersonalization({
    query: { queryKey: getGetMyPersonalizationQueryKey() },
  });
  const refresh = useRefreshMyPersonalization();
  const forget = useForgetMyPersonalization();

  if (isLoading) {
    return (
      <div className="bg-card border border-border rounded-lg p-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t("personalization.loading" as any)}
      </div>
    );
  }
  if (error || !data) return null;

  const { profile, counters, lastRefreshedAt } = data;
  const isCold = counters.sessions < 2 && counters.modelsAccepted < 1;

  const onRefresh = async () => {
    await refresh.mutateAsync();
    qc.invalidateQueries({ queryKey: getGetMyPersonalizationQueryKey() });
  };
  const onForget = async () => {
    if (!window.confirm(t("personalization.forgetConfirm" as any))) return;
    await forget.mutateAsync();
    qc.invalidateQueries({ queryKey: getGetMyPersonalizationQueryKey() });
  };

  return (
    <div className="bg-card border border-border rounded-lg p-5">
      <div className="flex items-start justify-between mb-3 gap-3">
        <div className="flex items-center gap-2">
          <Brain className="w-5 h-5 text-primary" />
          <h3 className="font-serif font-semibold text-lg text-foreground">
            {t("personalization.title" as any)}
          </h3>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refresh.isPending}
            data-testid="button-refresh-personalization"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent disabled:opacity-50"
          >
            {refresh.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {t("personalization.refresh" as any)}
          </button>
          <button
            type="button"
            onClick={onForget}
            disabled={forget.isPending}
            data-testid="button-forget-personalization"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive px-2 py-1 rounded hover:bg-accent disabled:opacity-50"
          >
            <Trash2 className="w-3 h-3" />
            {t("personalization.forget" as any)}
          </button>
        </div>
      </div>

      {isCold ? (
        <p className="text-sm text-muted-foreground">{t("personalization.coldStart" as any)}</p>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <Stat label={t("personalization.counters.sessions" as any)} value={counters.sessions} />
            <Stat label={t("personalization.counters.papers" as any)} value={counters.papers} />
            <Stat label={t("personalization.counters.modelsGenerated" as any)} value={counters.modelsGenerated} />
            <Stat label={t("personalization.counters.modelsAccepted" as any)} value={counters.modelsAccepted} />
            <Stat label={t("personalization.counters.chatTurns" as any)} value={counters.chatTurns} />
          </div>

          {profile.topDomainKeywords.length > 0 && (
            <Row label={t("personalization.profile.keywords" as any)}>
              {profile.topDomainKeywords.map((k) => (
                <Chip key={k.token}>{k.token}</Chip>
              ))}
            </Row>
          )}
          {profile.topAcceptedBackbones.length > 0 && (
            <Row label={t("personalization.profile.backbones" as any)}>
              {profile.topAcceptedBackbones.map((b) => (
                <Chip key={b.id}>{b.id}<span className="opacity-60 ml-1">×{b.count}</span></Chip>
              ))}
            </Row>
          )}
          {profile.topAcceptedOperators.length > 0 && (
            <Row label={t("personalization.profile.operators" as any)}>
              {profile.topAcceptedOperators.map((o) => (
                <Chip key={o.op}>{o.op}<span className="opacity-60 ml-1">×{o.count}</span></Chip>
              ))}
            </Row>
          )}
          {profile.avgVariablesPerAcceptedModel > 0 && (
            <p className="text-muted-foreground">
              {t("personalization.profile.size" as any)}: ~{profile.avgVariablesPerAcceptedModel} /
              {" "}~{profile.avgEdgesPerAcceptedModel}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {t("personalization.lastRefreshed" as any)}: {new Date(lastRefreshedAt).toLocaleString()}
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }): React.ReactElement {
  return (
    <div className="bg-muted/40 rounded-md px-2 py-1.5 text-center">
      <div className="text-base font-semibold text-foreground">{value}</div>
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
    </div>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground mr-1">{label}:</span>
      {children}
    </div>
  );
}
function Chip({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <span className="inline-flex items-center text-xs bg-accent/60 text-accent-foreground rounded-full px-2 py-0.5">
      {children}
    </span>
  );
}

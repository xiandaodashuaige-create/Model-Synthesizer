import React from "react";
import { Link } from "wouter";
import { Loader2, AlertCircle, Layers, Network, BookOpen } from "lucide-react";
import { useGetSessionLandscape, getGetSessionLandscapeQueryKey } from "@workspace/api-client-react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// Phase 2 Innovation Layer — Landscape page.
// Pure read view of the per-session literature landscape: coverage banner,
// every aggregated construct relationship, theory clusters, and the set of
// theory backbones explicitly cited by at least one in-scope paper.
//
// All numbers come from the new GET /sessions/{id}/landscape endpoint, so the
// page does NOT trigger a rebuild — refreshing only re-reads the snapshot.

const COVERAGE_FLOOR = 0.7;
// Bracket cutoffs MUST mirror bracketByOccurrences() in
// artifacts/api-server/src/lib/innovation-scoring.ts. See the
// "Threshold contract" callout in docs/innovation-taxonomy.md.
const SATURATED_THRESHOLD = 7;
const ESTABLISHED_THRESHOLD = 3;

type BracketKey = "saturated" | "established" | "underexplored" | "empty";

function bracketOf(occ: number): BracketKey {
  if (occ <= 0) return "empty";
  if (occ >= SATURATED_THRESHOLD) return "saturated";
  if (occ >= ESTABLISHED_THRESHOLD) return "established";
  return "underexplored";
}

function bracketStyles(b: BracketKey): string {
  switch (b) {
    case "saturated":
      return "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800/40 dark:text-slate-300 dark:border-slate-700";
    case "established":
      return "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800";
    case "underexplored":
      return "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800";
    case "empty":
      return "bg-muted text-muted-foreground border-border";
  }
}

function formatDateTime(iso: string | null, lang: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString(lang === "en" ? "en-US" : "zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export default function SessionLandscape({ params }: { params: { id: string } }) {
  const { t, lang } = useT();
  const sessionId = params.id ? parseInt(params.id, 10) : 0;

  const { data, isLoading, error } = useGetSessionLandscape(sessionId, {
    query: { enabled: !!sessionId, queryKey: getGetSessionLandscapeQueryKey(sessionId) },
  });

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-[40vh]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-destructive/10 text-destructive p-6 rounded-md border border-destructive/20">
        <div className="flex items-center gap-2 font-semibold mb-2">
          <AlertCircle className="w-5 h-5" />
          {String((error as { message?: string })?.message ?? "load failed")}
        </div>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const { coverage, landscapeVersion, lastRebuildAt, relationships, theoryClusters, evidencedBackbones } = data;
  const total = coverage.totalEligiblePaperCount ?? 0;
  const extracted = coverage.extractedWithInnovationFieldsCount ?? 0;
  const ratePct = Math.round((coverage.coverageRate ?? 0) * 100);

  // True empty-state: never rebuilt yet AND no relationships AND no clusters.
  // Distinct from "rebuilt but corpus is small" — that case still shows the
  // (empty) tables with explanatory copy so users see the structure.
  const everBuilt = landscapeVersion !== null;

  if (!everBuilt && relationships.length === 0 && theoryClusters.length === 0 && total === 0) {
    return (
      <div className="bg-card border border-border rounded-lg p-8 text-center">
        <Layers className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
        <h2 className="text-lg font-semibold mb-2">{t("landscape.empty.title" as any)}</h2>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">{t("landscape.empty.body" as any)}</p>
        <Link
          href={`/sessions/${sessionId}/variables`}
          className="inline-flex items-center mt-5 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90"
        >
          {t("ws.tab.variables" as any)}
        </Link>
      </div>
    );
  }

  // Coverage banner color/copy by bracket.
  const coverageBracket: "high" | "low" | "zero" =
    total === 0 ? "zero" : coverage.coverageRate >= COVERAGE_FLOOR ? "high" : "low";
  const coverageBannerCls =
    coverageBracket === "high"
      ? "bg-emerald-50 border-emerald-200 text-emerald-900 dark:bg-emerald-950/30 dark:border-emerald-800 dark:text-emerald-100"
      : coverageBracket === "low"
        ? "bg-amber-50 border-amber-200 text-amber-900 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-100"
        : "bg-muted border-border text-muted-foreground";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-serif font-bold text-foreground mb-1">{t("landscape.title" as any)}</h1>
        <p className="text-sm text-muted-foreground max-w-3xl leading-relaxed">{t("landscape.subtitle" as any)}</p>
        <div className="mt-2 text-xs text-muted-foreground flex items-center gap-3 flex-wrap">
          <span>
            {everBuilt
              ? String(t("landscape.version" as any)).replace("{v}", String(landscapeVersion))
              : t("landscape.version.unknown" as any)}
          </span>
          {lastRebuildAt ? (
            <span>{String(t("landscape.lastRebuild" as any)).replace("{when}", formatDateTime(lastRebuildAt, lang))}</span>
          ) : null}
        </div>
      </div>

      {/* Coverage banner */}
      <div className={cn("border rounded-lg p-4", coverageBannerCls)}>
        <div className="font-semibold text-sm mb-1">{t("landscape.coverage.title" as any)}</div>
        <div className="text-sm">
          {String(t("landscape.coverage.line" as any))
            .replace("{extracted}", String(extracted))
            .replace("{total}", String(total))
            .replace("{pct}", String(ratePct))}
        </div>
        <div className="text-xs mt-2 opacity-80">
          {coverageBracket === "high"
            ? t("landscape.coverage.high" as any)
            : coverageBracket === "low"
              ? t("landscape.coverage.low" as any)
              : t("landscape.coverage.zero" as any)}
        </div>
      </div>

      {/* Construct relationships */}
      <section className="bg-card border border-border rounded-lg shadow-sm">
        <header className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Network className="w-4 h-4 text-muted-foreground" />
          <div>
            <div className="font-semibold text-sm">{t("landscape.relationships.title" as any)}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{t("landscape.relationships.help" as any)}</div>
          </div>
        </header>
        {relationships.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground text-center">
            {t("landscape.relationships.empty" as any)}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted-foreground bg-muted/40">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">{t("landscape.col.from" as any)}</th>
                  <th className="text-left px-3 py-2 font-medium">{t("landscape.col.to" as any)}</th>
                  <th className="text-left px-3 py-2 font-medium">{t("landscape.col.type" as any)}</th>
                  <th className="text-left px-3 py-2 font-medium">{t("landscape.col.sign" as any)}</th>
                  <th className="text-left px-3 py-2 font-medium">{t("landscape.col.occ" as any)}</th>
                  <th className="text-left px-3 py-2 font-medium">{t("landscape.col.years" as any)}</th>
                  <th className="text-left px-3 py-2 font-medium">{t("landscape.col.domains" as any)}</th>
                  <th className="text-left px-3 py-2 font-medium">{t("landscape.col.potential" as any)}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {relationships.map((r) => {
                  const b = bracketOf(r.totalOccurrences);
                  const from = r.contextQualifierFrom ? `${r.canonicalFrom} · ${r.contextQualifierFrom}` : r.canonicalFrom;
                  const to = r.contextQualifierTo ? `${r.canonicalTo} · ${r.contextQualifierTo}` : r.canonicalTo;
                  const yearLabel =
                    r.earliestYear != null && r.latestYear != null
                      ? r.earliestYear === r.latestYear
                        ? String(t("landscape.years.single" as any)).replace("{a}", String(r.earliestYear))
                        : String(t("landscape.years.range" as any))
                            .replace("{a}", String(r.earliestYear))
                            .replace("{b}", String(r.latestYear))
                      : "—";
                  return (
                    <tr key={r.id} className="hover:bg-muted/30">
                      <td className="px-3 py-2 font-medium text-foreground">{from}</td>
                      <td className="px-3 py-2 font-medium text-foreground">{to}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {t(`landscape.type.${r.relationshipType}` as any)}
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-muted-foreground">{t(`landscape.sign.${r.sign}` as any)}</span>
                        {r.signConflict ? (
                          <span className="ml-2 inline-block text-[10px] px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800">
                            {t("landscape.sign.conflict" as any)}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border",
                            bracketStyles(b),
                          )}
                        >
                          <span className="font-semibold tabular-nums">{r.totalOccurrences}</span>
                          <span className="opacity-80">{t(`landscape.bracket.${b}` as any)}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">{yearLabel}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {r.domainsCovered.length > 0 ? r.domainsCovered.join(" · ") : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs tabular-nums text-muted-foreground">
                        {r.noveltyPotentialScore}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Theory clusters + evidenced backbones */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-card border border-border rounded-lg shadow-sm">
          <header className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Layers className="w-4 h-4 text-muted-foreground" />
            <div>
              <div className="font-semibold text-sm">{t("landscape.theories.title" as any)}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{t("landscape.theories.help" as any)}</div>
            </div>
          </header>
          {theoryClusters.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground text-center">
              {t("landscape.theories.empty" as any)}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {theoryClusters.map((c) => (
                <li key={c.id} className="px-4 py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-sm text-foreground truncate" title={c.label}>
                      {c.label}
                    </div>
                    {c.theoryIds.length > 1 ? (
                      <div className="text-xs text-muted-foreground mt-0.5 truncate" title={c.theoryIds.join(" · ")}>
                        {c.theoryIds.join(" · ")}
                      </div>
                    ) : null}
                  </div>
                  <span className="shrink-0 inline-flex items-center text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 tabular-nums">
                    {String(t("landscape.theories.papers" as any)).replace("{n}", String(c.paperCount))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bg-card border border-border rounded-lg shadow-sm">
          <header className="px-4 py-3 border-b border-border flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-muted-foreground" />
            <div>
              <div className="font-semibold text-sm">{t("landscape.backbones.title" as any)}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{t("landscape.backbones.help" as any)}</div>
            </div>
          </header>
          {evidencedBackbones.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground text-center">
              {t("landscape.backbones.empty" as any)}
            </div>
          ) : (
            <div className="p-4 flex flex-wrap gap-2">
              {evidencedBackbones.map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center text-xs px-2 py-1 rounded-md bg-muted text-foreground border border-border"
                >
                  {name}
                </span>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

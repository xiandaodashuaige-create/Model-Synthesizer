import React, { useState } from "react";
import { ChevronDown, ChevronUp, RefreshCw, Sparkles, AlertTriangle, Info, Loader2 } from "lucide-react";
import {
  useRecomputeModelInnovation,
  getGetModelQueryKey,
  getListSessionModelsQueryKey,
} from "@workspace/api-client-react";
import type {
  InnovationMeta,
  EdgeNoveltyTag,
  InnovationMetaInnovationTypesItem,
  InnovationWarning,
  EdgeNoveltyTagTag,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";

// Phase 2 Innovation Layer slice 3 — single shared panel rendered both in
// the candidate model card (variant="compact") and the model detail page
// (variant="full"). The compact variant intentionally hides the per-edge
// novelty list because the detail page is the right place to read it.
//
// Per architect-side contract:
//   - 4 sub-scores ALWAYS shown next to the headline (never collapse)
//   - innovationMeta missing → empty card with "尚未生成创新分析" + recompute
//   - mode='analysis_only' → coverage warning banner displayed prominently
//   - contributionStatement null → friendly empty-state, NOT 0 / NaN / ""
//   - noveltyScore=null → "暂无可评分关系" (zero-edge model)
//   - stale=true → amber stale badge with one-click recompute

type Variant = "compact" | "full";

const TAG_COLOR: Record<EdgeNoveltyTagTag, string> = {
  contradicting: "bg-rose-50 text-rose-800 border-rose-300",
  mechanism_inserted: "bg-violet-50 text-violet-800 border-violet-300",
  boundary_extended: "bg-violet-50 text-violet-800 border-violet-300",
  context_transferred: "bg-sky-50 text-sky-800 border-sky-300",
  novel: "bg-emerald-50 text-emerald-800 border-emerald-300",
  underexplored: "bg-amber-50 text-amber-800 border-amber-300",
  established: "bg-slate-50 text-slate-700 border-slate-300",
  saturated: "bg-slate-100 text-slate-600 border-slate-300",
};

function fmtScore(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.round(n).toString();
}

function ScoreCell({
  label,
  value,
  testId,
  tone = "default",
}: {
  label: string;
  value: number | null;
  testId: string;
  tone?: "default" | "headline";
}) {
  const isHeadline = tone === "headline";
  return (
    <div
      className={
        "rounded-md border px-3 py-2 " +
        (isHeadline
          ? "border-primary/30 bg-primary/5"
          : "border-border bg-background/60")
      }
    >
      <div
        className={
          "text-[10px] uppercase tracking-wider font-semibold " +
          (isHeadline ? "text-primary" : "text-muted-foreground")
        }
      >
        {label}
      </div>
      <div
        data-testid={testId}
        className={
          "font-bold " +
          (isHeadline ? "text-2xl text-primary" : "text-lg text-foreground")
        }
      >
        {fmtScore(value)}
      </div>
    </div>
  );
}

function TypePill({ kind, label }: { kind: InnovationMetaInnovationTypesItem; label: string }) {
  return (
    <span
      data-testid={`badge-innovation-type-${kind}`}
      className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 text-primary px-2 py-0.5 text-[11px] font-medium"
    >
      <Sparkles className="w-3 h-3" />
      {label}
    </span>
  );
}

function EdgeRow({ edge }: { edge: EdgeNoveltyTag }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const tagLabel = t(`innovation.tag.${edge.tag}` as any) as string;
  const relLabel = t(`innovation.rel.${edge.relationship}` as any, undefined as any) as string;
  return (
    <div
      data-testid={`row-edge-novelty-${edge.edgeIndex}`}
      className="rounded-md border border-border bg-background/40"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`edge-novelty-detail-${edge.edgeIndex}`}
        className="w-full flex items-center gap-2 text-left px-3 py-2 text-xs hover:bg-accent/40 transition-colors"
      >
        <span className="font-mono text-[10px] text-muted-foreground shrink-0">H{edge.edgeIndex + 1}</span>
        <span
          data-testid={`badge-edge-tag-${edge.edgeIndex}`}
          className={"shrink-0 inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold " + TAG_COLOR[edge.tag]}
        >
          {tagLabel}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{fmtScore(edge.subscore)}</span>
        <span className="flex-1 truncate text-foreground">
          <span className="font-medium">{edge.fromVariableName}</span>
          <span className="mx-1.5 text-muted-foreground">{relLabel || edge.relationship}</span>
          <span className="font-medium">{edge.toVariableName}</span>
        </span>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
      </button>
      {open && (
        <div
          id={`edge-novelty-detail-${edge.edgeIndex}`}
          className="border-t border-border px-3 py-2 space-y-2 text-[11px] text-muted-foreground bg-muted/20"
        >
          <div>
            <div className="text-[10px] uppercase tracking-wider font-semibold text-foreground mb-0.5">
              {t("innovation.edge.reason" as any)}
            </div>
            <div className="leading-relaxed">{edge.reason}</div>
          </div>
          {edge.matchedRelationship ? (
            <div>
              <div className="text-[10px] uppercase tracking-wider font-semibold text-foreground mb-0.5">
                {t("innovation.edge.matched" as any)}
              </div>
              <div className="leading-relaxed">
                <span className="font-medium text-foreground">{edge.matchedRelationship.canonicalFrom}</span>
                <span className="mx-1">→</span>
                <span className="font-medium text-foreground">{edge.matchedRelationship.canonicalTo}</span>
                <span className="ml-2">
                  ({t(`landscape.type.${edge.matchedRelationship.relationshipType}` as any)} ·{" "}
                  {t("innovation.edge.occ" as any, { n: edge.matchedRelationship.totalOccurrences })}
                  {edge.matchedRelationship.signConflict ? ` · ${t("landscape.sign.conflict" as any)}` : ""})
                </span>
                {edge.matchedRelationship.domainsCovered.length > 0 && (
                  <div className="mt-0.5 text-muted-foreground">
                    {t("innovation.edge.contexts" as any)}: {edge.matchedRelationship.domainsCovered.slice(0, 6).join(" · ")}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="italic">{t("innovation.edge.matched.empty" as any)}</div>
          )}
        </div>
      )}
    </div>
  );
}

function WarningRow({ warning }: { warning: InnovationWarning }) {
  const { t } = useT();
  const friendly = t(`innovation.warning.${warning.code}` as any, undefined as any) as string;
  return (
    <li className="flex items-start gap-1.5">
      <AlertTriangle className="w-3 h-3 mt-0.5 text-amber-600 shrink-0" />
      <span className="text-foreground">{friendly || warning.message}</span>
    </li>
  );
}

export function InnovationMetaPanel({
  sessionId,
  modelId,
  meta,
  variant = "compact",
}: {
  sessionId: number;
  modelId: number;
  meta: InnovationMeta | null | undefined;
  variant?: Variant;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const recompute = useRecomputeModelInnovation();

  const onRecompute = () => {
    recompute.mutate(
      { id: sessionId, modelId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetModelQueryKey(modelId) });
          queryClient.invalidateQueries({ queryKey: getListSessionModelsQueryKey(sessionId) });
          toast({ title: t("innovation.recompute.done" as any) });
        },
        onError: () => {
          toast({ title: t("innovation.recompute.failed" as any), variant: "destructive" });
        },
      },
    );
  };

  // Empty state — model has no innovationMeta at all (legacy model, or
  // landscape rebuild pending). Per spec the UI must handle this without
  // showing 0 / NaN / undefined for any score.
  if (!meta) {
    return (
      <div
        data-testid="panel-innovation-empty"
        className="rounded-lg border border-dashed border-border bg-muted/20 p-4 text-center"
      >
        <Sparkles className="w-5 h-5 text-muted-foreground mx-auto mb-1" />
        <p className="text-xs text-muted-foreground mb-2">{t("innovation.empty.body" as any)}</p>
        <button
          type="button"
          onClick={onRecompute}
          disabled={recompute.isPending}
          data-testid="button-recompute-innovation-empty"
          className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium border border-border bg-background hover:bg-accent h-8 px-3 transition-colors disabled:opacity-50"
        >
          {recompute.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {t("innovation.recompute" as any)}
        </button>
      </div>
    );
  }

  const isAnalysisOnly = meta.mode === "analysis_only";
  const coveragePct = Math.round((meta.computedAgainst.coverageRate ?? 0) * 100);
  const stale = meta.stale === true;
  const noScoredEdges = meta.noveltyScore == null;
  const contributionMissing = meta.contributionStatement == null;

  return (
    <div
      data-testid="panel-innovation-meta"
      className="rounded-lg border border-border bg-card p-4 space-y-3"
    >
      {/* Header row: title + recompute */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">
            {t("innovation.title" as any)}
          </h3>
          {stale && (
            <span
              data-testid="badge-innovation-stale"
              title={t("innovation.stale.tip" as any) as string}
              className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 text-amber-800 px-1.5 py-0.5 text-[10px] font-semibold"
            >
              <AlertTriangle className="w-3 h-3" />
              {t("innovation.stale" as any)}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onRecompute}
          disabled={recompute.isPending}
          data-testid="button-recompute-innovation"
          className="inline-flex items-center gap-1.5 rounded-md text-[11px] font-medium border border-border bg-background hover:bg-accent h-7 px-2.5 transition-colors disabled:opacity-50"
        >
          {recompute.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          {t("innovation.recompute" as any)}
        </button>
      </div>

      {/* Mode banner: analysis_only must be very visible per spec */}
      {isAnalysisOnly ? (
        <div
          data-testid="banner-innovation-analysis-only"
          className="rounded-md border border-amber-300 bg-amber-50 dark:border-amber-800/60 dark:bg-amber-950/30 px-3 py-2 flex items-start gap-2"
        >
          <Info className="w-3.5 h-3.5 mt-0.5 text-amber-700 shrink-0" />
          <div className="text-[11px] text-amber-900 dark:text-amber-200 leading-relaxed">
            <div className="font-semibold">
              {t("innovation.mode.analysisOnly.title" as any)}
            </div>
            <div>
              {t("innovation.mode.analysisOnly.body" as any, { pct: coveragePct })}
            </div>
          </div>
        </div>
      ) : (
        <div
          data-testid="banner-innovation-enforced"
          className="rounded-md border border-emerald-200 bg-emerald-50 dark:border-emerald-800/60 dark:bg-emerald-950/30 px-3 py-2 text-[11px] text-emerald-800 dark:text-emerald-200"
        >
          {t("innovation.mode.enforced.body" as any, { pct: coveragePct })}
        </div>
      )}

      {/* Headline + 4 sub-scores: must always be visible together */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <ScoreCell
          tone="headline"
          label={t("innovation.score.contribution" as any)}
          value={meta.contributionScore}
          testId="score-contribution"
        />
        <ScoreCell
          label={t("innovation.score.differentiation" as any)}
          value={meta.subScores.differentiation}
          testId="score-differentiation"
        />
        <ScoreCell
          label={t("innovation.score.gapFit" as any)}
          value={meta.subScores.gapFit}
          testId="score-gapFit"
        />
        <ScoreCell
          label={t("innovation.score.theory" as any)}
          value={meta.subScores.theoreticalSoundness}
          testId="score-theory"
        />
        <ScoreCell
          label={t("innovation.score.evidence" as any)}
          value={meta.subScores.evidenceSupport}
          testId="score-evidence"
        />
      </div>

      {/* noveltyScore=null tells the user "the model has no scorable edges"
          without ever rendering "0" or "NaN". */}
      {noScoredEdges && (
        <div className="text-[11px] text-muted-foreground italic">
          {t("innovation.noveltyEmpty" as any)}
        </div>
      )}

      {/* Innovation type pills */}
      {meta.innovationTypes.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {meta.innovationTypes.map((kt) => (
            <TypePill
              key={kt}
              kind={kt}
              label={t(`innovation.type.${kt}` as any) as string}
            />
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground italic">
          {t("innovation.types.empty" as any)}
        </div>
      )}

      {/* Warnings */}
      {meta.warnings.length > 0 && (
        <ul
          data-testid="list-innovation-warnings"
          className="text-[11px] space-y-0.5"
        >
          {meta.warnings.map((w, i) => <WarningRow key={i} warning={w} />)}
        </ul>
      )}

      {/* Contribution statement: full variant only, with explicit empty
          state so users know it is intentionally pending (not a render bug). */}
      {variant === "full" && (
        <div className="border-t border-border pt-3">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1">
            {t("innovation.contribution.title" as any)}
          </div>
          {contributionMissing ? (
            <div
              data-testid="empty-contribution-statement"
              className="text-[11px] text-muted-foreground italic"
            >
              {t("innovation.contribution.empty" as any)}
            </div>
          ) : (
            <pre className="text-[11px] text-foreground whitespace-pre-wrap font-sans leading-relaxed">
              {JSON.stringify(meta.contributionStatement, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* Per-edge novelty list (full variant only) */}
      {variant === "full" && (
        <div className="border-t border-border pt-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
              {t("innovation.edges.title" as any)}
            </div>
            {meta.edgeNoveltyTags.length > 0 && (
              <div className="text-[10px] text-muted-foreground">
                {t("innovation.edges.help" as any)}
              </div>
            )}
          </div>
          {meta.edgeNoveltyTags.length === 0 ? (
            <div className="text-[11px] text-muted-foreground italic">
              {t("innovation.edges.empty" as any)}
            </div>
          ) : (
            <div className="space-y-1.5">
              {meta.edgeNoveltyTags.map((e) => <EdgeRow key={e.edgeIndex} edge={e} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

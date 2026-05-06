import React, { useState, useMemo, useEffect, useRef } from "react";
import { useParams, Link } from "wouter";
import { ModelGraph, buildEdgeHTagMap, buildPaperTagMap } from "@/components/model-graph";
import {
  useListSessionModels,
  useGenerateModels,
  useSelectModel,
  useGetSessionLearningStats,
  useListSessionVariables,
  useListSessionPapers,
  useImportLiveModelFromModel,
  useGetLiveModel,
  getListSessionModelsQueryKey,
  getGetSessionSummaryQueryKey,
  getGetSessionQueryKey,
  getGetSessionLearningStatsQueryKey,
  getListSessionVariablesQueryKey,
  getListSessionPapersQueryKey,
  getGetLiveModelQueryKey,
} from "@workspace/api-client-react";
import { useExtractionProgress } from "@/lib/extraction-progress";
import { ModelAssistantChat } from "@/components/model-assistant-chat";
import { NextStepHint } from "@/components/onboarding-stepper";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Share2, Sparkles, CheckCircle, ArrowRight, BookOpen, Wand2, GitBranch, AlertTriangle, Columns2 } from "lucide-react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";
import { loadFocusedClusterKeys, saveFocusedClusterKeys, expandToVariableIds } from "@/lib/focus-selection";

// (ModelGraph + buildEdgeHTagMap + buildPaperTagMap moved to @/components/model-graph)
function HypothesisLegend({ items }: { items: Array<{ tag: string; from: string; to: string; rel: string; paperTag: string }> }) {
  if (!items.length) return null;
  const relSymbol: Record<string, string> = { positive: "→ (+)", negative: "→ (−)", moderates: "⇢ moderates", mediates: "→ mediates" };
  return (
    <div className="mt-3 pt-3 border-t border-border/60 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
      {items.map((h) => (
        <div key={h.tag} className="flex items-start gap-2 text-[11px] text-muted-foreground" data-testid={`legend-hypothesis-${h.tag}`}>
          <span className="shrink-0 inline-flex items-center justify-center min-w-[26px] h-4 px-1 rounded bg-violet-50 text-violet-800 text-[10px] font-bold border border-violet-200">
            {h.tag}
          </span>
          <span className="truncate" title={`${h.from} ${relSymbol[h.rel] ?? "→"} ${h.to}${h.paperTag ? ` (${h.paperTag})` : ""}`}>
            <span className="text-foreground">{h.from}</span>
            <span className="mx-1 text-muted-foreground">{relSymbol[h.rel] ?? "→"}</span>
            <span className="text-foreground">{h.to}</span>
            {h.paperTag && <span className="ml-1 text-muted-foreground">({h.paperTag})</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

function PaperLegend({ refs }: { refs: Array<{ tag: string; label: string }> }) {
  if (!refs.length) return null;
  return (
    <div className="mt-3 pt-3 border-t border-border/60 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
      {refs.map((r) => (
        <div key={r.tag} className="flex items-start gap-2 text-[11px] text-muted-foreground">
          <span className="shrink-0 inline-flex items-center justify-center min-w-[26px] h-4 px-1 rounded bg-muted text-foreground text-[10px] font-bold border border-border">
            {r.tag}
          </span>
          <span className="truncate" title={r.label}>{r.label}</span>
        </div>
      ))}
    </div>
  );
}

export default function SessionModels({ params: routeParams }: { params?: { id?: string } }) {
  const { t } = useT();
  const params = useParams<{ id: string }>();
  const sessionId = parseInt(routeParams?.id ?? params.id ?? "0", 10);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const generateModels = useGenerateModels();
  const selectModel = useSelectModel();
  const importLiveModel = useImportLiveModelFromModel();
  const [, navigate] = useLocation();

  const { data: models, isLoading } = useListSessionModels(sessionId, {
    query: { enabled: !!sessionId, queryKey: getListSessionModelsQueryKey(sessionId) },
  });
  const { data: learningStats } = useGetSessionLearningStats(sessionId, {
    query: { enabled: !!sessionId, queryKey: getGetSessionLearningStatsQueryKey(sessionId) },
  });
  const { data: variables } = useListSessionVariables(sessionId, {
    query: { enabled: !!sessionId, queryKey: getListSessionVariablesQueryKey(sessionId) },
  });
  // Canonical pending-papers guard: if any paper hasn't had variables
  // extracted yet, generating models would silently drop their evidence.
  // We block generation here (the only generation entry point) so users
  // who navigate directly to /models or use AI assistant suggestions can't
  // bypass the BigNextStep CTA gating on the previous pages.
  const { data: papersForGuard, isLoading: papersLoading } = useListSessionPapers(sessionId, {
    query: { enabled: !!sessionId, queryKey: getListSessionPapersQueryKey(sessionId) },
  });
  const extractionProgress = useExtractionProgress(sessionId);
  const pendingPapersCount = (papersForGuard ?? []).filter((p) => !p.extracted).length;
  const guardLoading = papersLoading || papersForGuard === undefined;
  const hasPendingPapers = !guardLoading && pendingPapersCount > 0;
  const isExtracting = !!extractionProgress;
  const generationBlocked = guardLoading || hasPendingPapers || isExtracting;
  const { data: liveModel } = useGetLiveModel(sessionId, {
    query: { enabled: !!sessionId, queryKey: getGetLiveModelQueryKey(sessionId) },
  });
  const manualEdgeCount = (liveModel?.edges ?? []).filter((e) => e.userAdded).length;
  const hasNoVariables = variables !== undefined && variables.length === 0;

  const [userPrompt, setUserPrompt] = useState("");
  const [numModels, setNumModels] = useState(3);
  const [focusVariableIds, setFocusVariableIds] = useState<number[]>([]);
  // Tracks whether `focusVariableIds` was pre-filled from the user's
  // `/variables` page selection (vs. set by an AI chat suggestion or empty).
  // Used to render a small banner so the user knows the generation form is
  // already loaded with their picks and can clear them if needed.
  const [focusFromVariablesPage, setFocusFromVariablesPage] = useState(false);
  const [pendingSelect, setPendingSelect] = useState<{ modelId: number; name: string } | null>(null);
  // Partial-pass: opt-in flow that lets the user generate models even when
  // some papers haven't been extracted yet. We surface a confirm dialog with
  // the missing-paper titles before sending allowPartial=true to the server.
  const [confirmPartialOpen, setConfirmPartialOpen] = useState(false);
  // A/B compare mode: when on, each card gets a checkbox; the user picks
  // exactly two and clicks the sticky CTA to navigate to the compare page.
  const [compareMode, setCompareMode] = useState(false);
  const [compareSelected, setCompareSelected] = useState<number[]>([]);
  const missingPapersList = useMemo(
    () => (papersForGuard ?? []).filter((p) => !p.extracted),
    [papersForGuard],
  );
  const extractedPapersCount = (papersForGuard ?? []).length - missingPapersList.length;

  const variableNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const v of variables ?? []) m.set(v.id, v.name);
    return m;
  }, [variables]);

  const handleApplySuggestion = (s: { userPrompt: string; focusVariableIds: number[] }) => {
    setUserPrompt(s.userPrompt);
    setFocusVariableIds(s.focusVariableIds);
    setFocusFromVariablesPage(false);
    // Block AI-assistant-triggered generation through the same guard so
    // pending extractions can't be bypassed via the chat suggestion flow.
    if (generationBlocked) {
      toast({
        title: isExtracting
          ? t("models.guard.extracting.title" as any, { done: extractionProgress!.done, total: extractionProgress!.total })
          : t("models.guard.pending.title" as any, { count: pendingPapersCount }),
        description: isExtracting
          ? t("models.guard.extracting.body" as any)
          : t("models.guard.pending.body" as any),
        variant: "destructive",
      });
      return;
    }
    // Trigger generation immediately with the suggested params.
    generateModels.mutate({
      id: sessionId,
      data: { userPrompt: s.userPrompt || undefined, numModels, focusVariableIds: s.focusVariableIds.length ? s.focusVariableIds : undefined },
    }, {
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: getListSessionModelsQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
        toast({
          title: t("models.toast.generated" as any),
          description: t("models.toast.generatedDesc" as any, { count: result.length }),
        });
      },
      onError: (err: any) => {
        const apiMsg = err?.data?.error ?? err?.response?.data?.error;
        const rejected = err?.data?.rejected ?? err?.response?.data?.rejected;
        const rejectedSummary = Array.isArray(rejected) && rejected.length > 0
          ? "\n" + rejected.map((r: { name?: string; reason?: string }) => `• ${r.name ?? "?"}: ${r.reason ?? ""}`).join("\n")
          : "";
        toast({
          title: t("models.toast.failed" as any),
          description: (apiMsg ? String(apiMsg) : t("models.toast.failedDesc" as any)) + rejectedSummary,
          variant: "destructive",
        });
      },
    });
  };

  const handleGenerate = (opts: { allowPartial?: boolean } = {}) => {
    const allowPartial = opts.allowPartial === true;
    // Defense-in-depth: the button is also disabled, but guard the action
    // itself in case of programmatic invocation or stale state. The
    // pending-papers branch of the guard is intentionally bypassed when
    // `allowPartial` is true (the user has just confirmed the warning dialog).
    if (guardLoading || isExtracting) return;
    if (!allowPartial && hasPendingPapers) return;
    generateModels.mutate({
      id: sessionId,
      data: {
        userPrompt: userPrompt.trim() || undefined,
        numModels,
        focusVariableIds: focusVariableIds.length ? focusVariableIds : undefined,
        ...(allowPartial ? { allowPartial: true } : {}),
      },
    }, {
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: getListSessionModelsQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
        const skipped = result.find((m) => m.partialPassMeta?.allowPartial)?.partialPassMeta?.missingPapers?.length ?? 0;
        toast({
          title: t("models.toast.generated" as any),
          description:
            t("models.toast.generatedDesc" as any, { count: result.length }) +
            (skipped > 0 ? " " + t("models.toast.partialDesc" as any, { n: skipped }) : ""),
        });
      },
      onError: (err: any) => {
        const apiMsg = err?.data?.error ?? err?.response?.data?.error;
        const rejected = err?.data?.rejected ?? err?.response?.data?.rejected;
        const rejectedSummary = Array.isArray(rejected) && rejected.length > 0
          ? "\n" + rejected.map((r: { name?: string; reason?: string }) => `• ${r.name ?? "?"}: ${r.reason ?? ""}`).join("\n")
          : "";
        toast({
          title: t("models.toast.failed" as any),
          description: (apiMsg ? String(apiMsg) : t("models.toast.failedDesc" as any)) + rejectedSummary,
          variant: "destructive",
        });
      },
    });
  };

  const toggleCompareSelected = (modelId: number) => {
    setCompareSelected((prev) => {
      if (prev.includes(modelId)) return prev.filter((x) => x !== modelId);
      // Cap at 2; the sticky CTA only fires when exactly 2 are selected.
      if (prev.length >= 2) return [prev[1], modelId];
      return [...prev, modelId];
    });
  };
  const exitCompareMode = () => { setCompareMode(false); setCompareSelected([]); };

  const handleUseAsBase = (modelId: number, name: string) => {
    importLiveModel.mutate(
      { id: sessionId, data: { modelId, replace: false } },
      {
        onSuccess: (detail) => {
          queryClient.invalidateQueries({ queryKey: getGetLiveModelQueryKey(sessionId) });
          toast({
            title: t("live.toast.imported" as any),
            description: t("live.toast.importedDesc" as any, {
              name,
              vars: detail.nodes.length,
              edges: detail.edges.length,
            }),
          });
          navigate(`/sessions/${sessionId}/live-model`);
        },
        onError: () => toast({ title: t("live.toast.failed" as any), variant: "destructive" }),
      },
    );
  };

  const handleSelect = (modelId: number, name: string) => {
    if (manualEdgeCount > 0) {
      setPendingSelect({ modelId, name });
      return;
    }
    doSelect(modelId, name);
  };

  const doSelect = (modelId: number, name: string) => {
    selectModel.mutate({ id: modelId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSessionModelsQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
        // "选用" semantically promotes this model to be the user's working model — also
        // import its nodes/edges into the live model (replacing previous content) so the
        // "我的研究模型" page actually reflects the choice.
        importLiveModel.mutate(
          { id: sessionId, data: { modelId, replace: true } },
          {
            onSuccess: (detail) => {
              queryClient.invalidateQueries({ queryKey: getGetLiveModelQueryKey(sessionId) });
              toast({
                title: t("models.toast.selected" as any),
                description: t("live.toast.importedDesc" as any, {
                  name,
                  vars: detail.nodes.length,
                  edges: detail.edges.length,
                }),
              });
            },
            onError: () => {
              toast({
                title: t("models.toast.selected" as any),
                description: t("live.toast.failed" as any),
                variant: "destructive",
              });
            },
          },
        );
      },
    });
  };

  const learnedRounds = (learningStats?.withSelections ?? 0) + (learningStats?.withEdits ?? 0);

  // ── Hydrate focus-variable selection from /variables page ─────────────
  // The user can pin "must use" variable clusters on /variables; we restore
  // those picks into focusVariableIds the first time the variables list
  // loads, so the generation form (and the auto-recommendation below) both
  // see the user's selection without an explicit "import picks" button.
  // Re-running on every variables change would clobber chat-suggestion
  // overrides — so we use a ref guard scoped to (sessionId, variables-ready).
  // Hydration is SYNCHRONOUS so the auto-gen useEffect below (which lists
  // `focusHydrated` in its deps) sees the picks in the same render pass and
  // can't race ahead with an empty focus set.
  const focusHydratedRef = useRef<number | null>(null);
  const [focusHydrated, setFocusHydrated] = useState(false);
  useEffect(() => {
    if (!sessionId) return;
    if (variables === undefined) return;
    if (focusHydratedRef.current === sessionId) return;
    focusHydratedRef.current = sessionId;
    const keys = loadFocusedClusterKeys(sessionId);
    if (keys.length > 0) {
      const ids = expandToVariableIds(keys, variables);
      if (ids.length > 0) {
        setFocusVariableIds(ids);
        setFocusFromVariablesPage(true);
      }
    }
    setFocusHydrated(true);
  }, [sessionId, variables]);

  // ── Auto initial recommendation ────────────────────────────────────────
  // Once per browser session per sessionId, when the user has done all the
  // upstream prep (≥3 papers extracted, has a topic, no models yet, never
  // attempted generation before), kick off a default generation in the
  // background so they don't have to hunt for the button. Uses sessionStorage
  // so that a transient failure doesn't loop, and so refresh doesn't double-
  // fire while the previous attempt is still in flight server-side.
  const autoGenTriedRef = useRef(false);
  const [autoGenInFlight, setAutoGenInFlight] = useState(false);
  useEffect(() => {
    if (autoGenTriedRef.current) return;
    if (!sessionId) return;
    // Wait for all gating queries to load.
    if (isLoading) return;
    if (variables === undefined) return;
    if (papersForGuard === undefined) return;
    if (learningStats === undefined) return;
    // Already have models, or have generated before — never auto-trigger.
    if ((models?.length ?? 0) > 0) return;
    if ((learningStats.totalFeedback ?? 0) > 0) return;
    // Persistent guard across refreshes within the same browser session.
    const storageKey = `autoGenTried:${sessionId}`;
    try { if (sessionStorage.getItem(storageKey)) return; } catch { /* ignore */ }
    // Standard generation preconditions.
    if (hasNoVariables) return;
    if (generationBlocked) return;
    // Wait for the focus-selection hydration to finish — otherwise auto-gen
    // can fire in the same tick that variables first becomes defined,
    // dispatching with focusVariableIds=[] before the user's pinned picks
    // from /variables have been loaded into state.
    if (!focusHydrated) return;
    const extractedCount = (papersForGuard ?? []).filter((p) => p.extracted).length;
    if (extractedCount < 3) return;

    autoGenTriedRef.current = true;
    try { sessionStorage.setItem(storageKey, "1"); } catch { /* ignore */ }
    setAutoGenInFlight(true);
    // If the user pinned focus variables on /variables, honor them in the
    // auto-recommendation too — otherwise the auto-fired models would feel
    // disconnected from what the user just hand-picked.
    const autoFocusIds = focusVariableIds.length > 0 ? focusVariableIds : undefined;
    generateModels.mutate(
      { id: sessionId, data: { numModels: 3, focusVariableIds: autoFocusIds } },
      {
        onSuccess: (result) => {
          queryClient.invalidateQueries({ queryKey: getListSessionModelsQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getGetSessionLearningStatsQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
          toast({
            title: t("models.toast.autoGenerated" as any),
            description: t("models.toast.autoGeneratedDesc" as any, { count: result.length }),
          });
        },
        onError: (err: any) => {
          const apiMsg = err?.data?.error ?? err?.response?.data?.error;
          toast({
            title: t("models.toast.autoGenFailed" as any),
            description: apiMsg ? String(apiMsg) : t("models.toast.autoGenFailedDesc" as any),
            variant: "destructive",
          });
        },
        onSettled: () => setAutoGenInFlight(false),
      },
    );
    // We deliberately omit `generateModels`, `queryClient`, `t`, `toast` from
    // deps — they're stable across renders and including them would risk
    // re-triggering. The `autoGenTriedRef` guard is the real safety net.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, isLoading, variables, papersForGuard, learningStats, models, hasNoVariables, generationBlocked, focusHydrated]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <p className="text-sm text-muted-foreground max-w-2xl">{t("models.intro" as any)}</p>
        <div className="flex items-center gap-2 flex-wrap">
          {learnedRounds > 0 && (
            <span
              data-testid="badge-learning"
              title={t("models.learning.tip" as any)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full"
            >
              <Sparkles className="w-3 h-3" />
              {t("models.learning.badge" as any, { n: learnedRounds })}
            </span>
          )}
          {(models?.length ?? 0) >= 2 && (
            <button
              type="button"
              data-testid="button-toggle-compare"
              onClick={() => (compareMode ? exitCompareMode() : setCompareMode(true))}
              title={t("models.compare.hint" as any) as string}
              className={`inline-flex items-center gap-1.5 rounded-md text-xs font-medium h-8 px-3 transition-colors border ${
                compareMode
                  ? "bg-primary text-primary-foreground border-primary hover:bg-primary/90"
                  : "bg-secondary text-secondary-foreground border-border hover:bg-accent"
              }`}
            >
              <Columns2 className="w-3.5 h-3.5" />
              {compareMode ? t("models.compare.toggleOff" as any) : t("models.compare.toggle" as any)}
            </button>
          )}
        </div>
      </div>

      {/* AI assistant chat */}
      {hasNoVariables && (
        <NextStepHint
          title={t("models.guard.noVars.title" as any)}
          body={t("models.guard.noVars.body" as any)}
          href={`/sessions/${sessionId}/papers`}
          cta={t("models.guard.noVars.cta" as any)}
        />
      )}

      {/* Block generation when extraction is in flight or some papers
          remain unextracted — this is the canonical guard, since users can
          reach /models via tabs, the onboarding stepper, or a direct URL. */}
      {!hasNoVariables && isExtracting && (
        <NextStepHint
          title={t("models.guard.extracting.title" as any, { done: extractionProgress!.done, total: extractionProgress!.total })}
          body={t("models.guard.extracting.body" as any)}
          href={`/sessions/${sessionId}/papers`}
          cta={t("models.guard.pending.cta" as any)}
        />
      )}
      {!hasNoVariables && !isExtracting && hasPendingPapers && (
        <div className="space-y-2">
          <NextStepHint
            title={t("models.guard.pending.title" as any, { count: pendingPapersCount })}
            body={t("models.guard.pending.body" as any)}
            href={`/sessions/${sessionId}/papers`}
            cta={t("models.guard.pending.cta" as any)}
          />
          {extractedPapersCount >= 2 && (
            <div className="flex justify-end">
              <button
                type="button"
                data-testid="button-generate-partial"
                onClick={() => setConfirmPartialOpen(true)}
                disabled={generateModels.isPending}
                className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 h-8 px-3 transition-colors disabled:opacity-50"
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                {t("models.guard.partial.cta" as any, { n: extractedPapersCount })}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Banner: focus picks were carried over from the /variables page.
          Tells the user the generation form is already pre-loaded so they
          don't manually re-select, and offers a one-click clear. */}
      {focusFromVariablesPage && focusVariableIds.length > 0 && (
        <div
          data-testid="banner-focus-prefilled"
          className="rounded-lg border border-amber-300 bg-amber-50/60 dark:border-amber-800/60 dark:bg-amber-950/30 p-3 flex items-start gap-3"
        >
          <Sparkles className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
          <div className="flex-1 min-w-0 text-xs">
            <p className="text-foreground leading-relaxed">
              {t("models.focusPrefilled.body" as any, { count: focusVariableIds.length })}
            </p>
          </div>
          <button
            type="button"
            data-testid="button-clear-prefilled-focus"
            onClick={() => {
              setFocusVariableIds([]);
              setFocusFromVariablesPage(false);
              saveFocusedClusterKeys(sessionId, []);
            }}
            className="shrink-0 text-xs text-primary hover:underline"
          >
            {t("models.focusPrefilled.clear" as any)}
          </button>
        </div>
      )}

      {/* Auto-generation banner — shown only while the one-shot initial
          recommendation request is in flight. Tells the user what's happening
          so the 30-60s wait doesn't feel like the page is broken. */}
      {autoGenInFlight && (
        <div
          data-testid="banner-auto-generating"
          className="rounded-lg border border-primary/30 bg-primary/5 p-4 flex items-start gap-3"
        >
          <Loader2 className="w-5 h-5 text-primary animate-spin shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-foreground mb-0.5">
              {t("models.autoGen.title" as any)}
            </h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t("models.autoGen.body" as any)}
            </p>
          </div>
        </div>
      )}

      <ModelAssistantChat
        sessionId={sessionId}
        variableNameById={variableNameById}
        onApplySuggestion={handleApplySuggestion}
      />

      {/* Custom prompt panel */}
      <div className="bg-card border border-border rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">{t("models.custom.title" as any)}</h3>
        </div>
        <div>
          <label htmlFor="user-prompt" className="text-xs font-medium text-muted-foreground mb-1.5 block">
            {t("models.custom.promptLabel" as any)}
          </label>
          <textarea
            id="user-prompt"
            data-testid="textarea-user-prompt"
            value={userPrompt}
            onChange={(e) => setUserPrompt(e.target.value)}
            placeholder={t("models.custom.promptPlaceholder" as any)}
            rows={4}
            className="w-full text-sm rounded-md border border-input bg-background px-3 py-2 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
          />
          <p className="text-[11px] text-muted-foreground mt-1.5 whitespace-pre-line">{t("models.custom.promptHint" as any)}</p>
        </div>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor="num-models" className="text-xs font-medium text-muted-foreground">
              {t("models.custom.numLabel" as any)}
            </label>
            <select
              id="num-models"
              data-testid="select-num-models"
              value={numModels}
              onChange={(e) => setNumModels(parseInt(e.target.value, 10))}
              className="text-sm rounded-md border border-input bg-background px-3 py-1.5"
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <button
            data-testid="button-generate-models"
            onClick={() => handleGenerate()}
            disabled={generateModels.isPending || hasNoVariables || generationBlocked}
            title={
              hasNoVariables
                ? t("models.guard.noVars.body" as any)
                : isExtracting
                  ? t("models.guard.extracting.body" as any)
                  : hasPendingPapers
                    ? t("models.guard.pending.body" as any)
                    : undefined
            }
            className="inline-flex items-center gap-2 rounded-md text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-5 disabled:opacity-50 disabled:pointer-events-none transition-colors"
          >
            {generateModels.isPending ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> {t("models.generating" as any)}</>
            ) : (
              <><Sparkles className="w-4 h-4" /> {models && models.length > 0 ? t("models.regenerate" as any) : t("models.generate" as any)}</>
            )}
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
      ) : !models || models.length === 0 ? (
        <div className="bg-card border border-dashed border-border rounded-lg p-12 text-center">
          <Share2 className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
          <h3 className="font-semibold text-foreground mb-1">{t("models.empty.title" as any)}</h3>
          {/* Context-aware empty state. The previous copy unconditionally told
              users to "go extract variables", which contradicted reality when
              the user already had hundreds of variables and was just one click
              away from generation. Now we branch on the actual blocker: no
              vars / extraction in progress / pending papers / ready-to-go. */}
          <p className="text-sm text-muted-foreground">
            {hasNoVariables
              ? t("models.empty.body" as any)
              : isExtracting
                ? t("models.empty.bodyExtracting" as any, {
                    done: extractionProgress!.done,
                    total: extractionProgress!.total,
                  })
                : hasPendingPapers
                  ? t("models.empty.bodyPending" as any, { count: pendingPapersCount })
                  : t("models.empty.bodyReady" as any)}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6">
          {models.map((model) => {
            const isCompareSelected = compareSelected.includes(model.id);
            return (
            <div
              key={model.id}
              data-testid={`card-model-${model.id}`}
              className={`bg-card border rounded-xl p-6 transition-all ${
                isCompareSelected
                  ? "border-primary ring-2 ring-primary/40 shadow-md"
                  : model.selected
                    ? "border-primary shadow-md"
                    : "border-border hover:border-primary/40"
              }`}
            >
              <div className="flex items-start justify-between gap-4 mb-4">
                {compareMode && (
                  <label className="shrink-0 inline-flex items-center gap-2 cursor-pointer pt-1" title={t("models.compare.checkbox" as any) as string}>
                    <input
                      type="checkbox"
                      data-testid={`checkbox-compare-${model.id}`}
                      checked={isCompareSelected}
                      onChange={() => toggleCompareSelected(model.id)}
                      className="w-4 h-4 accent-primary"
                    />
                  </label>
                )}
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    {model.selected && <CheckCircle className="w-4 h-4 text-primary shrink-0" />}
                    <h3 className="text-base font-semibold text-foreground">{model.name}</h3>
                    {model.partialPassMeta?.allowPartial && (
                      <span
                        data-testid={`badge-partial-${model.id}`}
                        title={t("models.partial.badgeTip" as any, { n: model.partialPassMeta.missingPapers.length }) as string}
                        className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-800 bg-amber-50 border border-amber-300 px-1.5 py-0.5 rounded"
                      >
                        <AlertTriangle className="w-3 h-3" />
                        {t("models.partial.badge" as any)}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">{model.description}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Link href={`/sessions/${sessionId}/models/${model.id}`}
                    className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium h-8 px-3 bg-secondary text-secondary-foreground hover:bg-accent transition-colors">
                    {t("common.viewDetails" as any)} <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                  <button
                    data-testid={`button-use-as-base-${model.id}`}
                    onClick={() => handleUseAsBase(model.id, model.name)}
                    disabled={importLiveModel.isPending}
                    title={t("models.useAsBase.tip" as any)}
                    className="inline-flex items-center gap-1.5 rounded-md text-xs font-semibold h-8 px-3 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    <GitBranch className="w-3.5 h-3.5" />
                    {t("models.useAsBase" as any)}
                  </button>
                  {!model.selected && (
                    <button
                      data-testid={`button-select-model-${model.id}`}
                      onClick={() => handleSelect(model.id, model.name)}
                      disabled={selectModel.isPending}
                      className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium h-8 px-3 bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
                    >
                      {t("common.select" as any)}
                    </button>
                  )}
                </div>
              </div>

              {(() => {
                const nodes = model.nodes ?? [];
                const edges = model.edges ?? [];
                // Build paper tags scoped to this model: P1, P2, … by first appearance.
                const paperOrder: number[] = [];
                const seen = new Set<number>();
                for (const n of nodes) {
                  if (!seen.has(n.paperId)) { seen.add(n.paperId); paperOrder.push(n.paperId); }
                }
                for (const e of edges) {
                  if (!seen.has(e.evidencePaperId)) { seen.add(e.evidencePaperId); paperOrder.push(e.evidencePaperId); }
                }
                const paperTagById = buildPaperTagMap(nodes, edges);
                const paperLabelById = new Map<number, string>();
                for (const n of nodes) {
                  if (!paperLabelById.has(n.paperId)) {
                    const author = (n.paperAuthors ?? [])[0] ?? "Unknown";
                    paperLabelById.set(n.paperId, `${author}${n.paperYear ? ` (${n.paperYear})` : ""} — ${n.paperTitle}`);
                  }
                }
                for (const e of edges) {
                  if (!paperLabelById.has(e.evidencePaperId)) {
                    const author = (e.evidencePaperAuthors ?? [])[0] ?? "Unknown";
                    paperLabelById.set(e.evidencePaperId, `${author}${e.evidencePaperYear ? ` (${e.evidencePaperYear})` : ""} — ${e.evidencePaperTitle}`);
                  }
                }
                const refs = paperOrder.map((pid) => ({ tag: paperTagById.get(pid)!, label: paperLabelById.get(pid) ?? `Paper ${pid}` }));
                const edgeHTagByKey = buildEdgeHTagMap(edges);
                const hLegend = edges.map((e, i) => ({
                  tag: `H${i + 1}`,
                  from: nodes.find((n) => n.variableId === e.fromVariableId)?.variableName ?? `#${e.fromVariableId}`,
                  to: nodes.find((n) => n.variableId === e.toVariableId)?.variableName ?? `#${e.toVariableId}`,
                  rel: e.relationship,
                  paperTag: paperTagById.get(e.evidencePaperId) ?? "",
                }));
                return (
                  <div className="mb-4 bg-background/50 rounded-lg p-4 border border-border overflow-hidden">
                    <ModelGraph nodes={nodes} edges={edges} paperTagById={paperTagById} edgeHTagByKey={edgeHTagByKey} />
                    <HypothesisLegend items={hLegend} />
                    <PaperLegend refs={refs} />
                  </div>
                );
              })()}

              <div className="border-t border-border pt-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">{t("common.rationale" as any)}</p>
                <p className="text-sm text-muted-foreground leading-relaxed">{model.rationale}</p>
              </div>

              {(model.edges ?? []).length > 0 && (
                <div className="border-t border-border pt-4 mt-4">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">{t("models.evidence.title" as any)}</p>
                  <div className="space-y-2">
                    {(model.edges ?? []).slice(0, 3).map((edge, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                        <BookOpen className="w-3.5 h-3.5 shrink-0 mt-0.5 text-primary/60" />
                        <span>
                          <span className="font-medium text-foreground">{edge.fromVariableName}</span>
                          {" → "}
                          <span className="font-medium text-foreground">{edge.toVariableName}</span>
                          {" — "}
                          {edge.evidencePaperTitle} ({(edge.evidencePaperAuthors ?? []).slice(0, 1).join(", ")}{edge.evidencePaperYear ? `, ${edge.evidencePaperYear}` : ""})
                        </span>
                      </div>
                    ))}
                    {(model.edges ?? []).length > 3 && (
                      <Link href={`/sessions/${sessionId}/models/${model.id}`} className="text-xs text-primary hover:underline">
                        {t("models.evidence.more" as any, { n: (model.edges ?? []).length - 3 })}
                      </Link>
                    )}
                  </div>
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}

      {compareMode && (
        <div
          data-testid="compare-footer"
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-card border border-primary shadow-xl rounded-full px-4 py-2 flex items-center gap-3"
        >
          <span className="text-xs text-muted-foreground">
            {t("models.compare.selectN" as any, { n: compareSelected.length })}
          </span>
          <button
            type="button"
            data-testid="button-go-compare"
            disabled={compareSelected.length !== 2}
            onClick={() => navigate(`/sessions/${sessionId}/models/compare?a=${compareSelected[0]}&b=${compareSelected[1]}`)}
            className="inline-flex items-center gap-1.5 rounded-full text-xs font-semibold h-8 px-4 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:pointer-events-none"
          >
            <Columns2 className="w-3.5 h-3.5" />
            {t("models.compare.cta" as any)}
          </button>
          <button
            type="button"
            onClick={exitCompareMode}
            className="text-xs text-muted-foreground hover:text-foreground px-2"
          >
            {t("common.cancel" as any)}
          </button>
        </div>
      )}

      <AlertDialog open={confirmPartialOpen} onOpenChange={setConfirmPartialOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("models.partial.confirm.title" as any)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("models.partial.confirm.body" as any, { count: missingPapersList.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {missingPapersList.length > 0 && (
            <div className="text-xs text-muted-foreground border border-border rounded-md bg-muted/30 p-3 max-h-40 overflow-y-auto">
              <p className="font-medium mb-1.5 text-foreground">{t("models.partial.confirm.list" as any)}</p>
              <ul className="list-disc list-inside space-y-0.5">
                {missingPapersList.slice(0, 12).map((p) => (
                  <li key={p.id} className="truncate" title={p.title}>{p.title}</li>
                ))}
                {missingPapersList.length > 12 && (
                  <li className="text-muted-foreground/70">… +{missingPapersList.length - 12}</li>
                )}
              </ul>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel" as any)}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-partial"
              onClick={() => { setConfirmPartialOpen(false); handleGenerate({ allowPartial: true }); }}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {t("models.partial.confirm.ok" as any)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!pendingSelect} onOpenChange={(open) => { if (!open) setPendingSelect(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("models.confirm.overwriteTitle" as any, { n: manualEdgeCount })}</AlertDialogTitle>
            <AlertDialogDescription>{t("models.confirm.overwriteBody" as any)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel" as any)}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const p = pendingSelect;
                setPendingSelect(null);
                if (p) doSelect(p.modelId, p.name);
              }}
            >
              {t("models.confirm.overwriteOk" as any)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

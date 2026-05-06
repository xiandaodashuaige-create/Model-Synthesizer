import React, { useMemo, useState } from "react";
import { Loader2, Sparkles, Globe, BookOpen, Plus, History, Undo2, X, ExternalLink } from "lucide-react";
import {
  useSearchModelEvidence,
  useApplyModelEvidence,
  useListModelVersions,
  useRevertModelToVersion,
  useSearchLiveModelEvidence,
  useApplyLiveModelEvidence,
  useListLiveModelVersions,
  useRevertLiveModelToVersion,
  getGetModelQueryKey,
  getGetLiveModelQueryKey,
  getListSessionPapersQueryKey,
  getListSessionVariablesQueryKey,
  getListModelVersionsQueryKey,
  getListLiveModelVersionsQueryKey,
} from "@workspace/api-client-react";
import type {
  EvidenceSearchResult,
  EvidencePaperHit,
  EvidenceEdgeMatch,
  ModelVersionSummary,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";

type Mode = "candidate" | "live";

type SelectionKey = string; // `${edgeKey}::${ref}`  ref = `L:${paperId}` or `W:${externalId}`

function refOfHit(h: EvidencePaperHit): string {
  if (h.source === "library" && h.paperId != null) return `L:${h.paperId}`;
  if (h.source === "web" && h.externalId) return `W:${h.externalId}`;
  return `?:${h.title.slice(0, 40)}`;
}

function HitCard({
  hit,
  selected,
  onToggle,
  showCheckbox,
}: {
  hit: EvidencePaperHit;
  selected: boolean;
  onToggle: () => void;
  showCheckbox: boolean;
}) {
  const { t } = useT();
  return (
    <div
      className={`border rounded-md p-3 text-xs space-y-1.5 ${selected ? "border-primary bg-primary/5" : "border-border bg-background"}`}
      data-testid="evidence-hit-card"
    >
      <div className="flex items-start gap-2">
        {showCheckbox && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            className="mt-1 shrink-0"
            data-testid="evidence-hit-toggle"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span
              className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded ${
                hit.source === "library" ? "bg-blue-50 text-blue-700 border border-blue-200" : "bg-emerald-50 text-emerald-700 border border-emerald-200"
              }`}
            >
              {hit.source === "library" ? <BookOpen className="w-2.5 h-2.5" /> : <Globe className="w-2.5 h-2.5" />}
              {hit.source === "library" ? t("evidence.tag.library" as any) : t("evidence.tag.web" as any)}
            </span>
            <span className="text-[10px] text-muted-foreground">★ {hit.score.toFixed(2)}</span>
            {hit.url && (
              <a href={hit.url} target="_blank" rel="noreferrer" className="text-[10px] text-muted-foreground hover:text-primary inline-flex items-center gap-0.5">
                <ExternalLink className="w-2.5 h-2.5" />
              </a>
            )}
          </div>
          <p className="font-medium text-foreground line-clamp-2">{hit.title}</p>
          <p className="text-[11px] text-muted-foreground line-clamp-1">
            {(hit.authors ?? []).slice(0, 3).join(", ")}{hit.year ? ` (${hit.year})` : ""}
          </p>
          {hit.evidenceQuote && (
            <p className="text-[11px] italic text-foreground border-l-2 border-primary/40 pl-2 mt-1.5 line-clamp-3">
              &ldquo;{hit.evidenceQuote}&rdquo;
            </p>
          )}
          <p className="text-[11px] text-muted-foreground mt-1">{hit.rationale}</p>
        </div>
      </div>
    </div>
  );
}

export function EvidenceMatchDialog({
  open,
  onClose,
  mode,
  sessionId,
  modelId,
}: {
  open: boolean;
  onClose: () => void;
  mode: Mode;
  sessionId: number;
  modelId?: number; // required for candidate
}) {
  const { t } = useT();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [scopeLib, setScopeLib] = useState(true);
  const [scopeWeb, setScopeWeb] = useState(true);
  const [grOverall, setGrOverall] = useState(true);
  const [grPerEdge, setGrPerEdge] = useState(true);
  const [instructions, setInstructions] = useState("");
  const [result, setResult] = useState<EvidenceSearchResult | null>(null);
  const [selected, setSelected] = useState<Set<SelectionKey>>(new Set());
  const [tab, setTab] = useState<"search" | "history">("search");

  const searchCand = useSearchModelEvidence();
  const applyCand = useApplyModelEvidence();
  const revertCand = useRevertModelToVersion();
  const searchLive = useSearchLiveModelEvidence();
  const applyLive = useApplyLiveModelEvidence();
  const revertLive = useRevertLiveModelToVersion();

  const versionsCandQ = useListModelVersions(sessionId, modelId ?? 0, {
    query: {
      enabled: open && mode === "candidate" && !!modelId && tab === "history",
      queryKey: getListModelVersionsQueryKey(sessionId, modelId ?? 0),
    },
  });
  const versionsLiveQ = useListLiveModelVersions(sessionId, {
    query: {
      enabled: open && mode === "live" && tab === "history",
      queryKey: getListLiveModelVersionsQueryKey(sessionId),
    },
  });

  const versions: ModelVersionSummary[] = (mode === "candidate" ? versionsCandQ.data : versionsLiveQ.data) ?? [];
  const isSearching = searchCand.isPending || searchLive.isPending;
  const isApplying = applyCand.isPending || applyLive.isPending;

  const reset = () => {
    setResult(null);
    setSelected(new Set());
  };

  const runSearch = () => {
    const scopes: Array<"library" | "web"> = [];
    if (scopeLib) scopes.push("library");
    if (scopeWeb) scopes.push("web");
    const granularity: Array<"overall" | "per-edge"> = [];
    if (grOverall) granularity.push("overall");
    if (grPerEdge) granularity.push("per-edge");
    if (scopes.length === 0 || granularity.length === 0) {
      toast({ title: t("evidence.toast.pickAtLeastOne" as any), variant: "destructive" });
      return;
    }
    const payload = { scopes, granularity, instructions: instructions.trim() || null };
    const onSuccess = (r: EvidenceSearchResult) => {
      setResult(r);
      const next = new Set<SelectionKey>();
      for (const em of r.perEdgeMatches ?? []) {
        for (const h of em.hits ?? []) {
          if (h.evidenceQuote) next.add(`${em.edgeKey}::${refOfHit(h)}`);
        }
      }
      setSelected(next);
    };
    const onError = () => toast({ title: t("evidence.toast.searchFailed" as any), variant: "destructive" });
    if (mode === "candidate" && modelId) {
      searchCand.mutate({ id: sessionId, modelId, data: payload }, { onSuccess, onError });
    } else if (mode === "live") {
      searchLive.mutate({ id: sessionId, data: payload }, { onSuccess, onError });
    }
  };

  const togglePick = (edgeKey: string, ref: string) => {
    const k = `${edgeKey}::${ref}`;
    const next = new Set(selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setSelected(next);
  };

  const selectionCount = selected.size;

  const apply = () => {
    if (!result) return;
    if (selectionCount === 0) {
      toast({ title: t("evidence.toast.nothingPicked" as any), variant: "destructive" });
      return;
    }
    // Build hit lookup by ref
    const hitByEdgeRef = new Map<string, EvidencePaperHit>();
    const webHitsByRef = new Map<string, EvidencePaperHit>();
    for (const em of result.perEdgeMatches ?? []) {
      for (const h of em.hits ?? []) {
        const r = refOfHit(h);
        hitByEdgeRef.set(`${em.edgeKey}::${r}`, h);
        if (h.source === "web" && h.externalId) webHitsByRef.set(h.externalId, h);
      }
    }
    const addPapers: Array<{ externalId: string; title: string; authors: string[]; year: number | null; abstract: string | null; url: string | null }> = [];
    const seenWeb = new Set<string>();
    const edgeAttachments: Array<{ edgeKey: string; paperId?: number | null; externalId?: string | null; evidenceQuote: string }> = [];
    for (const k of selected) {
      const h = hitByEdgeRef.get(k);
      if (!h || !h.evidenceQuote) continue;
      const [edgeKey] = k.split("::");
      if (h.source === "web" && h.externalId) {
        if (!seenWeb.has(h.externalId)) {
          seenWeb.add(h.externalId);
          addPapers.push({
            externalId: h.externalId,
            title: h.title,
            authors: h.authors ?? [],
            year: h.year ?? null,
            abstract: h.abstract ?? null,
            url: h.url ?? null,
          });
        }
        edgeAttachments.push({ edgeKey: edgeKey!, externalId: h.externalId, evidenceQuote: h.evidenceQuote });
      } else if (h.source === "library" && h.paperId) {
        edgeAttachments.push({ edgeKey: edgeKey!, paperId: h.paperId, evidenceQuote: h.evidenceQuote });
      }
    }
    const payload = { addPapers, edgeAttachments, reason: instructions.trim() || "evidence_apply" };
    const onSuccess = () => {
      toast({
        title: t("evidence.toast.applied" as any),
        description: t("evidence.toast.appliedDesc" as any, { papers: addPapers.length, edges: edgeAttachments.length }),
      });
      qc.invalidateQueries({ queryKey: getListSessionPapersQueryKey(sessionId) });
      qc.invalidateQueries({ queryKey: getListSessionVariablesQueryKey(sessionId) });
      if (mode === "candidate" && modelId) {
        qc.invalidateQueries({ queryKey: getGetModelQueryKey(modelId) });
        qc.invalidateQueries({ queryKey: getListModelVersionsQueryKey(sessionId, modelId) });
      }
      if (mode === "live") {
        qc.invalidateQueries({ queryKey: getGetLiveModelQueryKey(sessionId) });
        qc.invalidateQueries({ queryKey: getListLiveModelVersionsQueryKey(sessionId) });
      }
      reset();
      onClose();
    };
    const onError = () => toast({ title: t("evidence.toast.applyFailed" as any), variant: "destructive" });
    if (mode === "candidate" && modelId) {
      applyCand.mutate({ id: sessionId, modelId, data: payload }, { onSuccess, onError });
    } else {
      applyLive.mutate({ id: sessionId, data: payload }, { onSuccess, onError });
    }
  };

  const revert = (versionId: number) => {
    const onSuccess = () => {
      toast({ title: t("evidence.toast.reverted" as any) });
      qc.invalidateQueries({ queryKey: getListSessionPapersQueryKey(sessionId) });
      if (mode === "candidate" && modelId) {
        qc.invalidateQueries({ queryKey: getGetModelQueryKey(modelId) });
        qc.invalidateQueries({ queryKey: getListModelVersionsQueryKey(sessionId, modelId) });
      }
      if (mode === "live") {
        qc.invalidateQueries({ queryKey: getGetLiveModelQueryKey(sessionId) });
        qc.invalidateQueries({ queryKey: getListLiveModelVersionsQueryKey(sessionId) });
      }
      onClose();
    };
    const onError = () => toast({ title: t("evidence.toast.revertFailed" as any), variant: "destructive" });
    if (mode === "candidate" && modelId) {
      revertCand.mutate({ id: sessionId, modelId, versionId }, { onSuccess, onError });
    } else {
      revertLive.mutate({ id: sessionId, versionId }, { onSuccess, onError });
    }
  };

  const overall = result?.overallMatches ?? [];
  const perEdge: EvidenceEdgeMatch[] = result?.perEdgeMatches ?? [];

  const newPaperCount = useMemo(() => {
    const s = new Set<string>();
    for (const k of selected) {
      const [, ref] = k.split("::");
      if (ref?.startsWith("W:")) s.add(ref);
    }
    return s.size;
  }, [selected]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      data-testid="evidence-dialog"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            <h2 className="font-semibold text-foreground">{t("evidence.dialog.title" as any)}</h2>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label={t("common.cancel" as any) as string}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-5 pt-3 border-b border-border shrink-0">
          <button
            onClick={() => setTab("search")}
            className={`text-sm px-3 py-1.5 rounded-t-md ${tab === "search" ? "bg-background border border-border border-b-transparent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            data-testid="evidence-tab-search"
          >
            {t("evidence.dialog.tab.search" as any)}
          </button>
          <button
            onClick={() => setTab("history")}
            className={`text-sm px-3 py-1.5 rounded-t-md inline-flex items-center gap-1.5 ${tab === "history" ? "bg-background border border-border border-b-transparent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            data-testid="evidence-tab-history"
          >
            <History className="w-3.5 h-3.5" /> {t("evidence.dialog.tab.history" as any)}
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
          {tab === "search" && (
            <>
              {!result && (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">{t("evidence.dialog.intro" as any)}</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="border border-border rounded-md p-3 space-y-1.5">
                      <div className="text-[11px] font-semibold uppercase text-muted-foreground">{t("evidence.opts.scope" as any)}</div>
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={scopeLib} onChange={(e) => setScopeLib(e.target.checked)} data-testid="evidence-scope-library" />
                        <BookOpen className="w-3.5 h-3.5 text-blue-700" /> {t("evidence.opts.library" as any)}
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={scopeWeb} onChange={(e) => setScopeWeb(e.target.checked)} data-testid="evidence-scope-web" />
                        <Globe className="w-3.5 h-3.5 text-emerald-700" /> {t("evidence.opts.web" as any)}
                      </label>
                    </div>
                    <div className="border border-border rounded-md p-3 space-y-1.5">
                      <div className="text-[11px] font-semibold uppercase text-muted-foreground">{t("evidence.opts.granularity" as any)}</div>
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={grPerEdge} onChange={(e) => setGrPerEdge(e.target.checked)} data-testid="evidence-gran-peredge" />
                        {t("evidence.opts.perEdge" as any)}
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={grOverall} onChange={(e) => setGrOverall(e.target.checked)} data-testid="evidence-gran-overall" />
                        {t("evidence.opts.overall" as any)}
                      </label>
                    </div>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold uppercase text-muted-foreground mb-1">
                      {t("evidence.opts.instructions" as any)}
                    </label>
                    <textarea
                      value={instructions}
                      onChange={(e) => setInstructions(e.target.value)}
                      placeholder={t("evidence.opts.instructionsPh" as any) as string}
                      rows={2}
                      className="w-full text-sm rounded-md border border-input bg-background px-3 py-2"
                      data-testid="evidence-instructions"
                    />
                  </div>
                  <button
                    onClick={runSearch}
                    disabled={isSearching}
                    data-testid="evidence-run-search"
                    className="inline-flex items-center gap-2 rounded-md text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-5 disabled:opacity-50"
                  >
                    {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                    {isSearching ? t("evidence.searching" as any) : t("evidence.runSearch" as any)}
                  </button>
                </div>
              )}

              {result && (
                <div className="space-y-5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {t("evidence.summary" as any, {
                        edges: perEdge.length,
                        hits: perEdge.reduce((s, e) => s + (e.hits?.length ?? 0), 0),
                        overall: overall.length,
                      })}
                    </span>
                    <button
                      onClick={reset}
                      className="text-primary hover:underline"
                      data-testid="evidence-reset"
                    >
                      {t("evidence.searchAgain" as any)}
                    </button>
                  </div>

                  {grPerEdge && perEdge.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("evidence.section.perEdge" as any)}</h3>
                      {perEdge.map((em) => (
                        <div key={em.edgeKey} className="border border-border rounded-md p-3 space-y-2" data-testid="evidence-edge-block">
                          <div className="text-sm font-medium text-foreground">
                            <span>{em.fromVariableName}</span>
                            <span className="mx-2 text-muted-foreground">— {em.relationship} →</span>
                            <span>{em.toVariableName}</span>
                          </div>
                          {em.hits.length === 0 && (
                            <p className="text-[11px] italic text-muted-foreground">{t("evidence.edge.noHits" as any)}</p>
                          )}
                          <div className="space-y-2">
                            {em.hits.map((h) => {
                              const ref = refOfHit(h);
                              const k = `${em.edgeKey}::${ref}`;
                              return (
                                <HitCard
                                  key={k}
                                  hit={h}
                                  selected={selected.has(k)}
                                  onToggle={() => togglePick(em.edgeKey, ref)}
                                  showCheckbox={!!h.evidenceQuote}
                                />
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {grOverall && overall.length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("evidence.section.overall" as any)}</h3>
                      <p className="text-[11px] text-muted-foreground">{t("evidence.section.overallHint" as any)}</p>
                      <div className="space-y-2">
                        {overall.map((h) => (
                          <HitCard
                            key={refOfHit(h)}
                            hit={h}
                            selected={false}
                            onToggle={() => undefined}
                            showCheckbox={false}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {tab === "history" && (
            <div className="space-y-2">
              {versions.length === 0 && (
                <p className="text-xs text-muted-foreground italic">{t("evidence.history.empty" as any)}</p>
              )}
              {versions.map((v) => (
                <div key={v.id} className="border border-border rounded-md p-3 flex items-center justify-between gap-3" data-testid="evidence-version-row">
                  <div className="text-xs">
                    <div className="font-medium text-foreground">{new Date(v.createdAt).toLocaleString()}</div>
                    <div className="text-muted-foreground">{v.reason}</div>
                    <div className="text-muted-foreground">
                      {t("evidence.history.counts" as any, { nodes: v.nodeCount, edges: v.edgeCount })}
                    </div>
                  </div>
                  <button
                    onClick={() => revert(v.id)}
                    disabled={revertCand.isPending || revertLive.isPending}
                    className="inline-flex items-center gap-1 text-xs rounded-md border border-border bg-background hover:bg-accent h-8 px-3 disabled:opacity-50"
                    data-testid="evidence-revert-btn"
                  >
                    <Undo2 className="w-3 h-3" /> {t("evidence.history.revert" as any)}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {tab === "search" && result && (
          <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-border shrink-0">
            <div className="text-xs text-muted-foreground">
              {t("evidence.footer.summary" as any, { picks: selectionCount, papers: newPaperCount })}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="text-sm rounded-md border border-border bg-background hover:bg-accent h-9 px-3"
              >
                {t("common.cancel" as any)}
              </button>
              <button
                onClick={apply}
                disabled={isApplying || selectionCount === 0}
                data-testid="evidence-apply-btn"
                className="inline-flex items-center gap-2 rounded-md text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-4 disabled:opacity-50"
              >
                {isApplying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {isApplying ? t("evidence.applying" as any) : t("evidence.apply" as any)}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, Globe, BookOpen, Plus, History, Undo2, X, ExternalLink, GraduationCap, ImageIcon } from "lucide-react";
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
  if (h.source === "scholar" && h.externalId) return `S:${h.externalId}`;
  return `?:${h.title.slice(0, 40)}`;
}

// Wrap a paper URL through the user's institutional library proxy if they've
// configured one (single text input, persisted in localStorage). Common
// pattern: `https://login.libproxy.<school>.edu/login?url={URL}` — we just
// concatenate at the {URL} placeholder, falling back to suffix-append. Empty
// or missing template returns the raw URL.
const PROXY_KEY = "evidence.libraryProxyTemplate";
function applyLibraryProxy(url: string | null | undefined): string | null {
  if (!url) return null;
  if (typeof window === "undefined") return url;
  const tpl = (window.localStorage.getItem(PROXY_KEY) ?? "").trim();
  if (!tpl) return url;
  if (tpl.includes("{URL}")) return tpl.replace("{URL}", encodeURIComponent(url));
  return tpl + encodeURIComponent(url);
}
function scholarSearchUrl(title: string): string {
  return `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}`;
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
          <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
            <span
              className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded ${
                hit.source === "library"
                  ? "bg-blue-50 text-blue-700 border border-blue-200"
                  : hit.source === "scholar"
                    ? "bg-amber-50 text-amber-700 border border-amber-200"
                    : "bg-emerald-50 text-emerald-700 border border-emerald-200"
              }`}
            >
              {hit.source === "library" ? <BookOpen className="w-2.5 h-2.5" /> : hit.source === "scholar" ? <GraduationCap className="w-2.5 h-2.5" /> : <Globe className="w-2.5 h-2.5" />}
              {hit.source === "library"
                ? t("evidence.tag.library" as any)
                : hit.source === "scholar"
                  ? t("evidence.tag.scholar" as any)
                  : t("evidence.tag.web" as any)}
            </span>
            <span className="text-[10px] text-muted-foreground">★ {hit.score.toFixed(2)}</span>
            {hit.url && (
              <a href={hit.url} target="_blank" rel="noreferrer" className="text-[10px] text-muted-foreground hover:text-primary inline-flex items-center gap-0.5" title={hit.url}>
                <ExternalLink className="w-2.5 h-2.5" />
              </a>
            )}
            {hit.source !== "scholar" && (
              <a
                href={scholarSearchUrl(hit.title)}
                target="_blank"
                rel="noreferrer"
                className="text-[10px] text-amber-700 hover:text-amber-900 inline-flex items-center gap-0.5"
                title={t("evidence.openInScholar" as any) as string}
              >
                <GraduationCap className="w-2.5 h-2.5" />
              </a>
            )}
            {hit.url && applyLibraryProxy(hit.url) !== hit.url && (
              <a
                href={applyLibraryProxy(hit.url) ?? "#"}
                target="_blank"
                rel="noreferrer"
                className="text-[10px] text-violet-700 hover:text-violet-900 inline-flex items-center gap-0.5"
                title={t("evidence.openViaProxy" as any) as string}
              >
                {t("evidence.proxyShort" as any)}
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
  autoSearch = false,
  focusEdgeKey,
  focusEdgeLabel,
}: {
  open: boolean;
  onClose: () => void;
  mode: Mode;
  sessionId: number;
  modelId?: number; // required for candidate
  // When true, the dialog auto-runs the search the first time it opens.
  // Used by the per-edge "Find sources" entry point in the live-model page.
  autoSearch?: boolean;
  // When provided, the matching per-edge result block is auto-scrolled into
  // view and visually highlighted so the user finds it immediately.
  focusEdgeKey?: string;
  focusEdgeLabel?: { from: string; to: string };
}) {
  const { t } = useT();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [scopeLib, setScopeLib] = useState(true);
  const [scopeWeb, setScopeWeb] = useState(true);
  const [scopeScholar, setScopeScholar] = useState(true);
  const [grOverall, setGrOverall] = useState(true);
  const [grPerEdge, setGrPerEdge] = useState(true);
  const [instructions, setInstructions] = useState("");
  const [proxyTemplate, setProxyTemplate] = useState<string>(() =>
    typeof window === "undefined" ? "" : (window.localStorage.getItem(PROXY_KEY) ?? ""),
  );
  const [showProxyEditor, setShowProxyEditor] = useState(false);
  const isFocused = !!focusEdgeKey;
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
    const scopes: Array<"library" | "web" | "scholar"> = [];
    if (scopeLib) scopes.push("library");
    if (scopeWeb) scopes.push("web");
    if (scopeScholar) scopes.push("scholar");
    // Focused mode: backend forces per-edge + skips overall, so the
    // granularity panel doesn't apply. Send per-edge so we don't fail the
    // server's "at least one" guard.
    const granularity: Array<"overall" | "per-edge"> = isFocused ? ["per-edge"] : [];
    if (!isFocused) {
      if (grOverall) granularity.push("overall");
      if (grPerEdge) granularity.push("per-edge");
    }
    if (scopes.length === 0 || granularity.length === 0) {
      toast({ title: t("evidence.toast.pickAtLeastOne" as any), variant: "destructive" });
      return;
    }
    const payload = {
      scopes,
      granularity,
      instructions: instructions.trim() || null,
      // Send focusEdgeKey so the backend filters its edge list BEFORE any
      // OpenAlex / Scholar fetch or AI scoring — saves tokens AND eliminates
      // cross-edge dilution. Image hits auto-enable in focused mode.
      focusEdgeKey: focusEdgeKey ?? null,
      includeImages: isFocused ? true : null,
    };
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
    for (const em of result.perEdgeMatches ?? []) {
      for (const h of em.hits ?? []) {
        const r = refOfHit(h);
        hitByEdgeRef.set(`${em.edgeKey}::${r}`, h);
      }
    }
    const addPapers: Array<{ externalId: string; title: string; authors: string[]; year: number | null; abstract: string | null; url: string | null }> = [];
    const seenExt = new Set<string>();
    const edgeAttachments: Array<{ edgeKey: string; paperId?: number | null; externalId?: string | null; evidenceQuote: string }> = [];
    for (const k of selected) {
      const h = hitByEdgeRef.get(k);
      if (!h || !h.evidenceQuote) continue;
      const [edgeKey] = k.split("::");
      // Web (OpenAlex) AND scholar (SerpAPI Google Scholar) hits both flow
      // through the same import path: we add them to the session library
      // by externalId. The server's importer is idempotent on (sessionId,
      // externalId), so re-attaching a scholar paper later is safe.
      if ((h.source === "web" || h.source === "scholar") && h.externalId) {
        if (!seenExt.has(h.externalId)) {
          seenExt.add(h.externalId);
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

  // Auto-run a search the first time the dialog opens with autoSearch.
  // Reset state on close so each open is a fresh cycle (no stale results
  // from a previous focused-edge search bleeding into the next open).
  const autoFiredRef = useRef(false);
  useEffect(() => {
    if (!open) {
      autoFiredRef.current = false;
      setResult(null);
      setSelected(new Set());
      return;
    }
    if (autoSearch && !autoFiredRef.current && !isSearching) {
      autoFiredRef.current = true;
      runSearch();
    }
    // We intentionally only react to open/autoSearch toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, autoSearch]);

  // Scroll the focused edge block into view + highlight it briefly when
  // results land.
  const focusBlockRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!focusEdgeKey || !result) return;
    const el = focusBlockRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusEdgeKey, result]);

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
                  {isFocused && focusEdgeLabel ? (
                    <div className="text-xs bg-primary/5 border border-primary/30 text-foreground rounded-md px-3 py-2" data-testid="evidence-focus-banner">
                      {t("evidence.dialog.focusedIntro" as any, { from: focusEdgeLabel.from, to: focusEdgeLabel.to })}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t("evidence.dialog.intro" as any)}</p>
                  )}
                  <div className={isFocused ? "" : "grid grid-cols-2 gap-3"}>
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
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={scopeScholar} onChange={(e) => setScopeScholar(e.target.checked)} data-testid="evidence-scope-scholar" />
                        <GraduationCap className="w-3.5 h-3.5 text-amber-700" /> {t("evidence.opts.scholar" as any)}
                      </label>
                    </div>
                    {/* Granularity panel only matters when searching the WHOLE
                        model. In focused mode the backend forces per-edge and
                        skips overall (single edge → overall is meaningless). */}
                    {!isFocused && (
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
                    )}
                  </div>
                  {/* Institutional library proxy template — single field stored
                      in localStorage. Once set, every paper hit gets an extra
                      "通过学校代理打开" link that wraps the URL through the
                      campus proxy (e.g. EZproxy/OpenAthens). */}
                  <div className="text-[11px]">
                    <button
                      type="button"
                      onClick={() => setShowProxyEditor((v) => !v)}
                      className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                      data-testid="evidence-toggle-proxy"
                    >
                      {proxyTemplate ? t("evidence.proxy.configured" as any) : t("evidence.proxy.configure" as any)}
                    </button>
                    {showProxyEditor && (
                      <div className="mt-1.5 space-y-1">
                        <input
                          type="text"
                          value={proxyTemplate}
                          onChange={(e) => setProxyTemplate(e.target.value)}
                          placeholder={t("evidence.proxy.placeholder" as any) as string}
                          className="w-full text-xs rounded-md border border-input bg-background px-2 py-1.5"
                          data-testid="evidence-proxy-input"
                        />
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              const v = proxyTemplate.trim();
                              if (typeof window !== "undefined") {
                                if (v) window.localStorage.setItem(PROXY_KEY, v);
                                else window.localStorage.removeItem(PROXY_KEY);
                              }
                              setShowProxyEditor(false);
                              toast({ title: t("evidence.proxy.saved" as any) });
                            }}
                            className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground"
                            data-testid="evidence-proxy-save"
                          >
                            {t("common.save" as any)}
                          </button>
                          <span className="text-[10px] text-muted-foreground">{t("evidence.proxy.hint" as any)}</span>
                        </div>
                      </div>
                    )}
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

                  {focusEdgeKey && focusEdgeLabel && (
                    <div className="text-xs bg-primary/5 border border-primary/30 text-foreground rounded-md px-3 py-2">
                      {t("evidence.dialog.focusedHint" as any, { from: focusEdgeLabel.from, to: focusEdgeLabel.to })}
                    </div>
                  )}

                  {(grPerEdge || isFocused) && perEdge.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("evidence.section.perEdge" as any)}</h3>
                      {perEdge.map((em) => {
                        const isFocusedEdge = focusEdgeKey === em.edgeKey;
                        return (
                        <div
                          key={em.edgeKey}
                          ref={isFocusedEdge ? focusBlockRef : undefined}
                          className={`border rounded-md p-3 space-y-2 transition-colors ${isFocusedEdge ? "border-primary bg-primary/5 ring-2 ring-primary/30" : "border-border"}`}
                          data-testid="evidence-edge-block"
                        >
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
                          {/* Per-edge figure thumbnails (SerpAPI google_images).
                              Auto-fetched in focused mode — they're often the
                              clearest piece of evidence for "is this the same
                              kind of relationship?" Click opens the source
                              page so the user can verify the figure in context. */}
                          {(em.imageHits ?? []).length > 0 && (
                            <div className="pt-2 border-t border-border/60 space-y-1.5">
                              <div className="text-[10px] font-semibold uppercase text-muted-foreground inline-flex items-center gap-1">
                                <ImageIcon className="w-2.5 h-2.5" /> {t("evidence.section.figures" as any)}
                              </div>
                              <div className="grid grid-cols-3 gap-2">
                                {(em.imageHits ?? []).map((img) => (
                                  <a
                                    key={img.sourceUrl}
                                    href={img.sourceUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="block group border border-border rounded overflow-hidden bg-muted/30"
                                    title={img.title ?? img.sourceDomain}
                                    data-testid="evidence-image-hit"
                                  >
                                    <img
                                      src={img.thumbnailUrl}
                                      alt={img.title ?? "figure"}
                                      className="w-full h-24 object-cover group-hover:scale-105 transition-transform"
                                      loading="lazy"
                                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                                    />
                                    <div className="px-1.5 py-1 text-[10px] text-muted-foreground line-clamp-1">{img.sourceDomain}</div>
                                  </a>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                        );
                      })}
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

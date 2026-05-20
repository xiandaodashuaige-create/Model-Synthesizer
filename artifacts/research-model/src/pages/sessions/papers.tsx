import React, { useEffect, useRef, useState } from "react";
import { useParams } from "wouter";
import {
  useSearchPapers,
  useLookupPaper,
  useBulkImportPapers,
  useListSessionPapers,
  useAddPaperToSession,
  useRemovePaperFromSession,
  useExtractVariables,
  searchSessionPapersFullText,
  getListSessionPapersQueryKey,
  getListSessionVariablesQueryKey,
  getGetSessionSummaryQueryKey,
  getGetSessionQueryKey,
} from "@workspace/api-client-react";
import type { PaperFullTextHit } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Search, Plus, Trash2, Loader2, BookOpen, ExternalLink, CheckCircle, Clock, Info, Link2, Upload, FileText, AlertCircle, SkipForward, Building2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";
import { NextStepHint, BigNextStep } from "@/components/onboarding-stepper";
import { beginExtraction, updateExtraction, endExtraction, useExtractionProgress } from "@/lib/extraction-progress";
import { AddExternalPaperDialog } from "@/components/add-external-paper-dialog";

export default function SessionPapers({ params: routeParams }: { params?: { id?: string } }) {
  const { t } = useT();
  const params = useParams<{ id: string }>();
  const sessionId = parseInt(routeParams?.id ?? params.id ?? "0", 10);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const initialQ = (() => {
    if (typeof window === "undefined") return "";
    try { return new URLSearchParams(window.location.search).get("q") ?? ""; } catch { return ""; }
  })();
  const [searchQuery, setSearchQuery] = useState(initialQ);
  const autoSearchedRef = useRef(false);
  const [searchResults, setSearchResults] = useState<Array<{
    externalId: string; title: string; abstract?: string | null; authors: string[];
    year?: number | null; venue?: string | null; citationCount?: number | null;
    openAccessUrl?: string | null; url: string;
  }>>([]);
  type SortMode = "relevance" | "year" | "citations";
  const [searchSort, setSearchSort] = useState<SortMode>("relevance");
  const [searchPage, setSearchPage] = useState(1);
  const SEARCH_PAGE_SIZE = 15;
  // Whether the latest result page was full → assume there's a next batch.
  const hasMoreResults = searchResults.length >= SEARCH_PAGE_SIZE;

  const searchPapers = useSearchPapers();
  const lookupPaper = useLookupPaper();
  const bulkImport = useBulkImportPapers();
  const addPaper = useAddPaperToSession();
  const removePaper = useRemovePaperFromSession();
  const extractVariables = useExtractVariables();
  const [lookupQuery, setLookupQuery] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [bulkResult, setBulkResult] = useState<null | {
    importedCount: number; skippedCount: number; failedCount: number; totalDois: number;
    failures: Array<{ identifier: string; reason: string }>;
  }>(null);
  const [pdfUploading, setPdfUploading] = useState<string | null>(null);
  // Queue model so the user can keep clicking "选择 PDF" while one is parsing —
  // newly picked files append to the queue instead of being blocked. Refs (not
  // state) so synchronous appends from rapid clicks don't race with React's
  // batching. The worker drains the queue and exits when empty; the next
  // click that arrives while empty restarts it.
  const pdfQueueRef = useRef<File[]>([]);
  const pdfWorkerRunningRef = useRef(false);
  // Persistent list of upload failures so the user can decide later whether to
  // retry or dismiss each one. Without this the user only sees a transient
  // toast and the file disappears — if 3 of 10 fail in a batch, by the time
  // the run is done the 3 failure toasts have scrolled past and the user has
  // no record of which files need attention. We keep the actual `File`
  // reference so "retry" can re-upload without a fresh file picker.
  type FailedUpload = { id: string; file: File; reason: string };
  const [failedPdfs, setFailedPdfs] = useState<FailedUpload[]>([]);
  // Track WHICH paper is currently being extracted so a single click only
  // spins that one button. Without this, every card shares
  // `extractVariables.isPending` and lights up together — visually it looks
  // like every paper is being processed.
  const [extractingPaperId, setExtractingPaperId] = useState<number | null>(null);
  const [pdfQueueProgress, setPdfQueueProgress] = useState<{ done: number; total: number } | null>(null);
  const [pdfDragOver, setPdfDragOver] = useState(false);
  const [externalDialogOpen, setExternalDialogOpen] = useState(false);
  // Per-paper "expand abstract" toggle. We render abstracts collapsed (~2
  // lines) by default to keep the saved-papers list scannable. Pre-fix the
  // tailwind `line-clamp-2` utility was getting overridden somewhere in the
  // cascade (likely the @tailwindcss/typography plugin's prose styles
  // resetting `display`), so abstracts rendered full-height and pushed the
  // page to ~25 lines per row. Now we ALSO enforce the clamp via inline
  // style as a defense-in-depth fallback no parent CSS can override.
  const [expandedAbstracts, setExpandedAbstracts] = useState<Set<number>>(new Set());
  const toggleAbstract = (id: number) => setExpandedAbstracts((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const { data: sessionPapers, isLoading: papersLoading } = useListSessionPapers(sessionId, {
    query: { enabled: !!sessionId, queryKey: getListSessionPapersQueryKey(sessionId) },
  });

  const addedIds = new Set((sessionPapers ?? []).map((p) => p.externalId));
  // "allExtracted" treats relevance-skipped papers as "processed" so the
  // next-step CTA is not permanently blocked by intentionally skipped papers.
  const allExtracted = (sessionPapers?.length ?? 0) > 0 && (sessionPapers ?? []).every((p) => p.extracted || p.relevanceSkipped);
  const someExtracted = (sessionPapers ?? []).some((p) => p.extracted);

  // Monotonic request id — only the latest in-flight search is allowed to
  // overwrite results / page / sort state, so a slow earlier response can
  // never clobber a faster later one.
  const searchSeqRef = useRef(0);
  const runSearch = (opts?: { sort?: SortMode; page?: number; resetPage?: boolean }) => {
    if (!searchQuery.trim()) return;
    if (searchPapers.isPending) return; // guard against double-fire from Enter key
    const sort = opts?.sort ?? searchSort;
    const page = opts?.resetPage ? 1 : (opts?.page ?? searchPage);
    const mySeq = ++searchSeqRef.current;
    // Persist the query in the URL so browser back/refresh keeps the search context.
    if (typeof window !== "undefined") {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("q", searchQuery);
        window.history.replaceState(null, "", url.toString());
      } catch { /* ignore */ }
    }
    searchPapers.mutate(
      { data: { query: searchQuery, limit: SEARCH_PAGE_SIZE, sort, page } },
      {
        onSuccess: (results) => {
          if (mySeq !== searchSeqRef.current) return; // stale response, drop
          setSearchResults(results);
          // Commit page/sort only on success so a failed Next click doesn't
          // leave the indicator out of sync with the visible results.
          setSearchSort(sort);
          setSearchPage(page);
          // Scroll the results region into view so the user sees fresh content.
          if (typeof window !== "undefined") {
            requestAnimationFrame(() => {
              document.querySelector('[data-testid="search-results-anchor"]')
                ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
            });
          }
        },
        onError: (err: any) => {
          // Surface the actual server-side reason (timeout / rate-limited /
          // upstream / network) rather than a one-size-fits-all message.
          const description = err?.data?.error
            ?? err?.response?.data?.error
            ?? t("papers.toast.searchFailedDesc" as any);
          toast({
            title: t("papers.toast.searchFailed" as any),
            description,
            variant: "destructive",
          });
        },
      },
    );
  };
  const handleSearch = () => runSearch({ resetPage: true });

  useEffect(() => {
    if (autoSearchedRef.current) return;
    if (initialQ.trim()) {
      autoSearchedRef.current = true;
      handleSearch();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQ]);

  const handleAdd = (paper: typeof searchResults[0]) => {
    addPaper.mutate(
      {
        id: sessionId,
        data: {
          externalId: paper.externalId,
          title: paper.title,
          abstract: paper.abstract ?? null,
          authors: paper.authors,
          year: paper.year ?? null,
          venue: paper.venue ?? null,
          citationCount: paper.citationCount ?? null,
          openAccessUrl: paper.openAccessUrl ?? null,
          url: paper.url,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSessionPapersQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
          toast({ title: t("papers.toast.added" as any), description: paper.title.slice(0, 80) });
        },
        onError: () =>
          toast({
            title: t("papers.toast.addFailed" as any),
            description: t("common.tryAgain" as any),
            variant: "destructive",
          }),
      },
    );
  };

  const handleLookup = () => {
    const id = lookupQuery.trim();
    if (!id) return;
    lookupPaper.mutate(
      { data: { identifier: id } },
      {
        onSuccess: (paper) => {
          if (addedIds.has(paper.externalId)) {
            toast({ title: t("papers.lookup.toast.added" as any), description: paper.title.slice(0, 80) });
            setLookupQuery("");
            return;
          }
          // handleAdd already toasts on success/failure — don't double-toast here.
          handleAdd(paper);
          setLookupQuery("");
        },
        onError: (err: any) => {
          // Orval ApiError carries the parsed body on err.data
          const status = err?.status ?? err?.response?.status;
          const description = err?.data?.error ?? err?.response?.data?.error ?? t("common.tryAgain" as any);
          if (status === 404) {
            toast({
              title: t("papers.lookup.toast.notFound" as any),
              description,
              variant: "destructive",
            });
          } else {
            toast({
              title: t("papers.lookup.toast.failed" as any),
              description,
              variant: "destructive",
            });
          }
        },
      },
    );
  };

  const handleBulkImport = (content: string) => {
    if (!content.trim()) return;
    setBulkResult(null);
    bulkImport.mutate(
      { id: sessionId, data: { content } },
      {
        onSuccess: (result) => {
          setBulkResult(result);
          setBulkText("");
          queryClient.invalidateQueries({ queryKey: getListSessionPapersQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
          toast({
            title: t("papers.bulk.toast.done" as any),
            description: t("papers.bulk.toast.summary" as any, {
              imported: result.importedCount,
              skipped: result.skippedCount,
              failed: result.failedCount,
            }),
          });
        },
        onError: () => {
          toast({ title: t("papers.bulk.toast.failed" as any), variant: "destructive" });
        },
      },
    );
  };

  // Record a failure so it shows up in the persistent failed-uploads panel.
  // Also fires the same destructive toast the user is used to. We dedupe by
  // file name so retrying the same file doesn't stack two failure rows.
  const recordPdfFailure = (file: File, reason: string) => {
    toast({
      title: t("papers.pdf.toast.failed" as any, { name: file.name }),
      description: reason,
      variant: "destructive",
    });
    setFailedPdfs((prev) => {
      const without = prev.filter((f) => f.file.name !== file.name);
      return [...without, { id: `${file.name}-${Date.now()}`, file, reason }];
    });
  };

  const uploadOnePdf = async (file: File): Promise<boolean> => {
    if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
      recordPdfFailure(file, t("papers.pdf.toast.notPdf" as any, { name: file.name }));
      return false;
    }
    if (file.size > 25 * 1024 * 1024) {
      recordPdfFailure(file, t("papers.pdf.toast.tooLarge" as any, { name: file.name }));
      return false;
    }
    setPdfUploading(file.name);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const resp = await fetch(`/api/sessions/${sessionId}/papers/upload-pdf`, { method: "POST", body: fd });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "" }));
        recordPdfFailure(file, err.error || `HTTP ${resp.status}`);
        return false;
      }
      const paper = await resp.json();
      // Backend returns `alreadyExisted: true` (status 200, not 201) when this
      // PDF's externalId matched an existing paper in the session — it just
      // refreshed the stored full text. Tell the user explicitly so they
      // know nothing got duplicated and the update was intentional.
      const key = paper.alreadyExisted ? "papers.pdf.toast.alreadyExisted" : "papers.pdf.toast.added";
      toast({ title: t(key as any, { title: paper.title }) });
      // If this same file was previously in the failed list, clear it now —
      // it's no longer "failed".
      setFailedPdfs((prev) => prev.filter((f) => f.file.name !== file.name));
      return true;
    } catch (err) {
      recordPdfFailure(file, (err as Error)?.message ?? "network error");
      return false;
    }
  };

  // Append-to-queue handler. Always non-blocking: pushes new files into the
  // ref-backed queue and starts the worker if it isn't already running. This
  // is what makes the "click again to add more" behavior work — every click
  // appends, and the in-flight worker just keeps draining.
  const handlePdfFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    pdfQueueRef.current.push(...arr);
    // Update visible total immediately so the user sees their newly-added
    // files reflected in (done/total). `done` stays where it was; `total`
    // bumps up by the number of files just queued.
    setPdfQueueProgress((prev) => prev
      ? { done: prev.done, total: prev.total + arr.length }
      : { done: 0, total: arr.length });
    if (pdfWorkerRunningRef.current) return;
    pdfWorkerRunningRef.current = true;
    let ok = 0, fail = 0;
    try {
      // Drain the queue. New files appended mid-loop are picked up because we
      // re-check `.length` every iteration.
      while (pdfQueueRef.current.length > 0) {
        const next = pdfQueueRef.current.shift()!;
        const success = await uploadOnePdf(next);
        if (success) ok++; else fail++;
        setPdfQueueProgress((prev) => prev ? { done: prev.done + 1, total: prev.total } : null);
      }
    } finally {
      pdfWorkerRunningRef.current = false;
      setPdfUploading(null);
      setPdfQueueProgress(null);
    }
    queryClient.invalidateQueries({ queryKey: getListSessionPapersQueryKey(sessionId) });
    queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
    queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
    if (ok + fail > 1) {
      toast({ title: t("papers.pdf.summary" as any, { ok, fail }) });
    }
  };

  const handleBulkFile = async (file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: t("papers.bulk.toast.tooLarge" as any), variant: "destructive" });
      return;
    }
    const text = await file.text();
    handleBulkImport(text);
  };

  const handleRemove = (paperId: number) => {
    removePaper.mutate(
      { sessionId, paperId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSessionPapersQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
          toast({ title: t("papers.toast.removed" as any) });
        },
      },
    );
  };

  // Bulk-extraction progress lives in a shared module store keyed by sessionId
  // so the page-level BigNextStep CTA can disable itself while extraction is
  // in flight (also synced with the variables page when the user navigates
  // between them). Other sessions are unaffected.
  const extractAllProgress = useExtractionProgress(sessionId);

  const handleExtractAll = async () => {
    // Exclude relevance-skipped papers from "extract all" — they were already
    // screened and the user can bypass individually via the "仍然提取" button.
    const pending = (sessionPapers ?? []).filter((p) => !p.extracted && !p.relevanceSkipped);
    if (pending.length === 0) return;
    const runId = beginExtraction(sessionId, pending.length);
    let ok = 0, fail = 0, skipped = 0, done = 0;
    const failedTitles: string[] = [];
    // Concurrency 4 — matches the backend per-variable extraction limit and
    // is a safe ceiling for the OpenAI proxy + Postgres connection pool. With
    // 19 papers this drops wall-clock from ~9 min (serial) to ~2.5 min.
    const CONCURRENCY = 4;
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= pending.length) return;
        const p = pending[i];
        try {
          const result = await extractVariables.mutateAsync({ id: sessionId, paperId: p.id });
          if (result.skipped) { skipped++; } else { ok++; }
        } catch (err) {
          fail++;
          failedTitles.push(p.title);
          // Surface a per-paper toast immediately — without this the user
          // only sees the aggregate "成功 X 失败 Y" at the end and can't
          // tell which paper to retry. Body shows the server's actual error.
          const e = err as { data?: { error?: string; code?: string }; message?: string };
          const code = e?.data?.code;
          const friendly = code ? t(`papers.toast.err.${code}` as any) : "";
          // Use the i18n string if we recognise the code; otherwise fall back
          // to the server's raw error text. Either way the user never sees
          // bare English server strings like "AI returned no variables".
          const desc = (friendly && !friendly.startsWith("papers.toast.err.")) ? friendly : (e?.data?.error ?? e?.message ?? "");
          toast({
            title: t("papers.toast.extractOneFailed" as any, { title: p.title.slice(0, 60) }),
            description: desc,
            variant: code === "no_variables" ? "warning" : "destructive",
          });
        }
        done++;
        updateExtraction(sessionId, runId, done, pending.length);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()));
    } finally {
      endExtraction(sessionId, runId);
    }
    // Await invalidations BEFORE the summary toast so the "1 篇未提取" warning
    // banner refreshes in lockstep with the toast — pre-fix the toast could
    // claim "成功 1 失败 0" while the stale banner still said "1 篇未提取",
    // looking like a contradiction to the user.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListSessionPapersQueryKey(sessionId) }),
      queryClient.invalidateQueries({ queryKey: getListSessionVariablesQueryKey(sessionId) }),
      queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) }),
      queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) }),
    ]);
    const failedDesc = failedTitles.length > 0
      ? failedTitles.slice(0, 3).map((title) => `• ${title.slice(0, 60)}`).join("\n") + (failedTitles.length > 3 ? `\n…（其余 ${failedTitles.length - 3} 篇）` : "")
      : "";
    const skippedDesc = skipped > 0 ? `跳过 ${skipped} 篇（主题不相关）` : "";
    const description = [failedDesc, skippedDesc].filter(Boolean).join("\n") || undefined;
    toast({
      title: t("papers.toast.extractAllDone" as any, { ok, fail }),
      description,
      variant: failedTitles.length > 0 ? "destructive" : undefined,
    });
  };

  const handleExtract = (paperId: number, title: string, opts?: { bypassPreflight?: boolean }) => {
    setExtractingPaperId(paperId);
    extractVariables.mutate(
      { id: sessionId, paperId, params: opts?.bypassPreflight ? { bypassPreflight: true } : undefined },
      {
        onSettled: () => setExtractingPaperId(null),
        onSuccess: (result) => {
          queryClient.invalidateQueries({ queryKey: getListSessionPapersQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getListSessionVariablesQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
          if (result.skipped) {
            toast({
              title: t("papers.extract.skipped" as any),
              description: `「${title.slice(0, 40)}」${t("papers.extract.skipped.reason" as any)}`,
            });
          } else {
            toast({
              title: t("papers.toast.extracted" as any),
              description: t("papers.toast.extractedDesc" as any, { count: result.variables.length, title: title.slice(0, 40) }),
            });
          }
        },
        onError: (err) => {
          const errCode = (err as { data?: { code?: string } })?.data?.code;
          toast({
            title: t("papers.toast.extractFailed" as any),
            description: t("papers.toast.extractFailedDesc" as any),
            variant: errCode === "no_variables" ? "warning" : "destructive",
          });
        },
      },
    );
  };

  return (
    <div className="space-y-8">
      {/* Search Panel */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h2 className="text-lg font-semibold text-foreground mb-1 flex items-center gap-2">
          <Search className="w-5 h-5 text-primary" /> {t("papers.search.title" as any)}
        </h2>
        <p className="text-xs text-muted-foreground mb-4 flex items-start gap-1.5">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{t("papers.search.hint" as any)}</span>
        </p>
        <div className="flex gap-3">
          <input
            data-testid="input-search-papers"
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder={t("papers.search.ph" as any)}
            className="flex-1 h-10 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            data-testid="button-search"
            onClick={handleSearch}
            disabled={searchPapers.isPending || !searchQuery.trim()}
            className="inline-flex items-center justify-center rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-5 disabled:opacity-50 disabled:pointer-events-none gap-2"
          >
            {searchPapers.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            {t("papers.search.button" as any)}
          </button>
        </div>

        {(searchResults.length > 0 || searchPage > 1) && (
          <>
            <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="search-results-anchor">
              <span className="text-xs text-muted-foreground font-medium">
                {t("papers.sort.label" as any)}：
              </span>
              {(["relevance", "year", "citations"] as SortMode[]).map((mode) => {
                const active = searchSort === mode;
                return (
                  <button
                    key={mode}
                    data-testid={`button-sort-${mode}`}
                    onClick={() => runSearch({ sort: mode, resetPage: true })}
                    disabled={searchPapers.isPending}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors disabled:opacity-50 ${
                      active
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-border hover:border-primary/40 hover:text-foreground"
                    }`}
                  >
                    {t(`papers.sort.${mode}` as any)}
                  </button>
                );
              })}
              <span className="ml-auto text-xs text-muted-foreground">
                {t("papers.page.indicator" as any, { page: searchPage })}
              </span>
            </div>
            <div className="mt-3 space-y-3 max-h-[420px] overflow-y-auto pr-1">
            <p className="text-xs text-muted-foreground font-medium">
              {t("papers.results.count" as any, { count: searchResults.length })} · {t("papers.results.from" as any)}
            </p>
            {searchResults.map((paper) => {
              const isAdded = addedIds.has(paper.externalId);
              return (
                <div
                  key={paper.externalId}
                  data-testid={`card-search-result-${paper.externalId}`}
                  className="flex items-start gap-4 p-4 rounded-md border border-border bg-background/50 hover:border-primary/30 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-medium text-foreground line-clamp-2 leading-snug">{paper.title}</h3>
                      <a
                        href={paper.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {paper.authors.slice(0, 3).join(", ")}
                      {paper.authors.length > 3 ? " et al." : ""} {paper.year ? `· ${paper.year}` : ""}{" "}
                      {paper.venue ? `· ${paper.venue}` : ""}{" "}
                      {paper.citationCount != null ? `· ${paper.citationCount} ${t("common.citations" as any)}` : ""}
                    </p>
                    {paper.abstract && (
                      <p
                        className="text-xs text-muted-foreground mt-1 leading-relaxed"
                        style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
                      >
                        {paper.abstract}
                      </p>
                    )}
                  </div>
                  <button
                    data-testid={`button-add-paper-${paper.externalId}`}
                    onClick={() => !isAdded && handleAdd(paper)}
                    disabled={isAdded || addPaper.isPending}
                    className={`shrink-0 inline-flex items-center gap-1.5 rounded-md text-xs font-medium h-8 px-3 transition-colors ${
                      isAdded
                        ? "bg-muted text-muted-foreground cursor-default"
                        : "bg-primary/10 text-primary hover:bg-primary/20"
                    }`}
                  >
                    {isAdded ? (
                      <>
                        <CheckCircle className="w-3.5 h-3.5" /> {t("common.added" as any)}
                      </>
                    ) : (
                      <>
                        <Plus className="w-3.5 h-3.5" /> {t("common.add" as any)}
                      </>
                    )}
                  </button>
                </div>
              );
            })}
            </div>
            <div className="mt-4 flex items-center justify-between gap-3">
              <button
                data-testid="button-page-prev"
                onClick={() => runSearch({ page: Math.max(1, searchPage - 1) })}
                disabled={searchPapers.isPending || searchPage <= 1}
                className="text-xs px-3 py-1.5 rounded-md border border-border bg-background hover:border-primary/40 disabled:opacity-40 disabled:pointer-events-none"
              >
                ← {t("papers.page.prev" as any)}
              </button>
              {!hasMoreResults && searchPage > 1 && (
                <span className="text-xs text-muted-foreground">{t("papers.page.noMore" as any)}</span>
              )}
              <button
                data-testid="button-page-next"
                onClick={() => runSearch({ page: searchPage + 1 })}
                disabled={searchPapers.isPending || !hasMoreResults}
                className="text-xs px-3 py-1.5 rounded-md border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40 disabled:pointer-events-none inline-flex items-center gap-1.5"
              >
                {searchPapers.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                {t("papers.page.next" as any)} →
              </button>
            </div>
          </>
        )}
      </div>

      {/* Lookup by DOI / URL */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h2 className="text-lg font-semibold text-foreground mb-1 flex items-center gap-2">
          <Link2 className="w-5 h-5 text-primary" /> {t("papers.lookup.title" as any)}
        </h2>
        <p className="text-xs text-muted-foreground mb-4">{t("papers.lookup.hint" as any)}</p>
        <div className="flex gap-3">
          <input
            data-testid="input-lookup-paper"
            type="text"
            value={lookupQuery}
            onChange={(e) => setLookupQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLookup()}
            placeholder={t("papers.lookup.ph" as any)}
            className="flex-1 h-10 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            data-testid="button-lookup"
            onClick={handleLookup}
            disabled={lookupPaper.isPending || addPaper.isPending || !lookupQuery.trim()}
            className="inline-flex items-center justify-center rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-5 disabled:opacity-50 disabled:pointer-events-none gap-2"
          >
            {lookupPaper.isPending || addPaper.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            {t("papers.lookup.button" as any)}
          </button>
        </div>
        <div className="mt-3 flex items-start gap-2 p-3 rounded-md bg-muted/50 border border-border">
          <Info className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
          <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">{t("papers.lookup.uniNote" as any)}</p>
        </div>
      </div>

      {/* Upload PDF papers — primary (most natural) way to add */}
      <div
        className={`bg-card border rounded-lg p-6 transition-colors ${
          pdfDragOver ? "border-primary bg-primary/5" : "border-border"
        }`}
        onDragOver={(e) => { e.preventDefault(); setPdfDragOver(true); }}
        onDragLeave={() => setPdfDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setPdfDragOver(false);
          if (e.dataTransfer.files?.length) handlePdfFiles(e.dataTransfer.files);
        }}
        data-testid="dropzone-pdf"
      >
        <h2 className="text-lg font-semibold text-foreground mb-1 flex items-center gap-2">
          <FileText className="w-5 h-5 text-primary" /> {t("papers.pdf.title" as any)}
        </h2>
        <p className="text-xs text-muted-foreground mb-4 leading-relaxed whitespace-pre-line">
          {t("papers.pdf.hint" as any)}
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <label
            className="inline-flex items-center gap-2 cursor-pointer rounded-md bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-5 text-sm font-medium"
            data-testid="label-pdf-upload"
          >
            <Upload className="w-4 h-4" />
            {t("papers.pdf.uploadFile" as any)}
            <input
              type="file"
              accept="application/pdf,.pdf"
              multiple
              className="hidden"
              data-testid="input-pdf-file"
              onChange={(e) => {
                if (e.target.files?.length) handlePdfFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <span className="text-xs text-muted-foreground">{t("papers.pdf.dragHint" as any)}</span>
        </div>

        {pdfUploading && (
          <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>
              {t("papers.pdf.working" as any, { name: pdfUploading })}
              {pdfQueueProgress && pdfQueueProgress.total > 1 ? ` (${pdfQueueProgress.done}/${pdfQueueProgress.total})` : ""}
            </span>
          </div>
        )}

        {failedPdfs.length > 0 && (
          <div className="mt-4 border border-destructive/30 bg-destructive/5 rounded-md p-3" data-testid="panel-failed-pdfs">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="text-xs font-semibold text-destructive">
                {t("papers.pdf.failed.title" as any, { count: failedPdfs.length })}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const files = failedPdfs.map((f) => f.file);
                    setFailedPdfs([]);
                    handlePdfFiles(files);
                  }}
                  className="text-[11px] rounded-md border border-input bg-background px-2 py-1 hover:bg-accent"
                  data-testid="button-retry-all-failed-pdfs"
                >
                  {t("papers.pdf.failed.retryAll" as any)}
                </button>
                <button
                  type="button"
                  onClick={() => setFailedPdfs([])}
                  className="text-[11px] rounded-md border border-input bg-background px-2 py-1 hover:bg-accent"
                  data-testid="button-dismiss-all-failed-pdfs"
                >
                  {t("papers.pdf.failed.dismissAll" as any)}
                </button>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mb-2">{t("papers.pdf.failed.hint" as any)}</p>
            <ul className="space-y-1.5">
              {failedPdfs.map((f) => (
                <li key={f.id} className="flex items-start justify-between gap-2 text-xs">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-foreground truncate" title={f.file.name}>{f.file.name}</div>
                    <div className="text-[11px] text-muted-foreground line-clamp-2" title={f.reason}>{f.reason}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setFailedPdfs((prev) => prev.filter((x) => x.id !== f.id));
                        handlePdfFiles([f.file]);
                      }}
                      className="text-[11px] rounded-md bg-primary text-primary-foreground hover:bg-primary/90 px-2 py-1"
                      data-testid={`button-retry-failed-${f.id}`}
                    >
                      {t("papers.pdf.failed.retry" as any)}
                    </button>
                    <button
                      type="button"
                      onClick={() => setFailedPdfs((prev) => prev.filter((x) => x.id !== f.id))}
                      className="text-[11px] rounded-md border border-input bg-background hover:bg-accent px-2 py-1"
                      data-testid={`button-dismiss-failed-${f.id}`}
                    >
                      {t("papers.pdf.failed.dismiss" as any)}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Bulk import (BibTeX / RIS) — advanced/secondary */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h2 className="text-lg font-semibold text-foreground mb-1 flex items-center gap-2">
          <Upload className="w-5 h-5 text-primary" /> {t("papers.bulk.title" as any)}
        </h2>
        <p className="text-xs text-muted-foreground mb-4 leading-relaxed whitespace-pre-line">{t("papers.bulk.hint" as any)}</p>

        <div className="flex flex-wrap items-center gap-3 mb-3">
          <label
            className="inline-flex items-center gap-2 cursor-pointer rounded-md border border-input bg-background hover:bg-accent h-10 px-4 text-sm font-medium"
            data-testid="label-bulk-upload"
          >
            <FileText className="w-4 h-4" />
            {t("papers.bulk.uploadFile" as any)}
            <input
              type="file"
              accept=".bib,.ris,.txt,.enw,.nbib"
              className="hidden"
              data-testid="input-bulk-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleBulkFile(f);
                e.target.value = "";
              }}
            />
          </label>
          <span className="text-xs text-muted-foreground">{t("papers.bulk.or" as any)}</span>
        </div>

        <textarea
          data-testid="input-bulk-text"
          value={bulkText}
          onChange={(e) => setBulkText(e.target.value)}
          placeholder={t("papers.bulk.ph" as any)}
          rows={5}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-muted-foreground">{t("papers.bulk.limit" as any)}</p>
          <button
            data-testid="button-bulk-import"
            onClick={() => handleBulkImport(bulkText)}
            disabled={bulkImport.isPending || !bulkText.trim()}
            className="inline-flex items-center gap-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-5 disabled:opacity-50 disabled:pointer-events-none"
          >
            {bulkImport.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {t("papers.bulk.button" as any)}
          </button>
        </div>

        {bulkImport.isPending && (
          <p className="mt-3 text-xs text-muted-foreground">{t("papers.bulk.working" as any)}</p>
        )}

        {bulkResult && (
          <div className="mt-4 p-4 rounded-md bg-muted/50 border border-border space-y-2">
            <p className="text-sm font-medium text-foreground">
              {t("papers.bulk.result.title" as any, {
                total: bulkResult.totalDois,
                imported: bulkResult.importedCount,
                skipped: bulkResult.skippedCount,
                failed: bulkResult.failedCount,
              })}
            </p>
            {bulkResult.totalDois === 0 && (
              <p className="text-xs text-muted-foreground">{t("papers.bulk.result.noDois" as any)}</p>
            )}
            {bulkResult.failures.length > 0 && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer hover:text-foreground">
                  {t("papers.bulk.result.failuresLabel" as any, { count: bulkResult.failures.length })}
                </summary>
                <ul className="mt-2 space-y-0.5 font-mono text-[11px]">
                  {bulkResult.failures.slice(0, 20).map((f, i) => (
                    <li key={i}>
                      <span className="text-foreground/70">{f.identifier}</span> — {f.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>

      {/* Next-step hint. Show "extract all" whenever there are still pending
          papers (even after some have been extracted) — previously this
          collapsed to the "go to variables" hint after the first single
          extraction, hiding the bulk button. */}
      {(sessionPapers?.length ?? 0) > 0 && !allExtracted && (
        <NextStepHint
          title={t("papers.tip.extractAll.title" as any)}
          body={
            extractAllProgress
              ? t("papers.tip.extractAll.progress" as any, { done: extractAllProgress.done, total: extractAllProgress.total })
              : t("papers.tip.extractAll.body" as any, { count: (sessionPapers ?? []).filter((p) => !p.extracted && !p.relevanceSkipped).length })
          }
          cta={extractAllProgress ? t("papers.extract.btn.working" as any) : t("papers.extract.btn.all" as any)}
          ctaNote={!extractAllProgress && (sessionPapers ?? []).filter((p) => !p.extracted).length > 0 ? `≈ ${(sessionPapers ?? []).filter((p) => !p.extracted).length} 积分` : undefined}
          onClick={handleExtractAll}
          loading={extractAllProgress !== null}
          disabled={extractAllProgress !== null || extractingPaperId !== null}
        />
      )}
      {/* When some-but-not-all are extracted we deliberately do NOT show a
          "go to models" / "go to variables" hint here — it would invite the
          user to skip ahead while extraction is incomplete and the
          generation-time guardrail would just block them with a confusing
          error. The /variables and /models pages already show the right
          forward CTA (with proper disabled state + reason). */}
      {allExtracted && (sessionPapers?.length ?? 0) > 0 && (
        <NextStepHint
          title={t("vars.tip.next.title" as any)}
          body={t("vars.tip.next.body" as any)}
          href={`/sessions/${sessionId}/models`}
          cta={t("vars.goModels" as any)}
        />
      )}

      {/* Full-text search across imported papers */}
      {(sessionPapers?.length ?? 0) > 0 && (
        <FullTextSearchBox sessionId={sessionId} />
      )}

      {/* Session Papers */}
      <div id="session-papers">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-primary" />
            {t("papers.session.title" as any)}
            {sessionPapers && (
              <span className="text-sm font-normal text-muted-foreground">({sessionPapers.length})</span>
            )}
          </h2>
          <button
            type="button"
            onClick={() => setExternalDialogOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium border border-input bg-background text-foreground hover:bg-muted h-8 px-3 transition-colors"
          >
            <Building2 className="w-3.5 h-3.5" />
            {t("externalPaper.btn" as any)}
          </button>
        </div>

        {papersLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : !sessionPapers || sessionPapers.length === 0 ? (
          <div className="bg-card border border-dashed border-border rounded-lg p-10 text-center">
            <BookOpen className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <h3 className="font-semibold text-foreground mb-1">{t("papers.session.empty.title" as any)}</h3>
            <p className="text-sm text-muted-foreground">{t("papers.session.empty.body" as any)}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {sessionPapers.map((paper) => (
              <div
                key={paper.id}
                data-testid={`card-paper-${paper.id}`}
                className="bg-card border border-border rounded-lg p-5 flex items-start gap-4 hover:border-primary/30 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-foreground leading-snug mb-1">{paper.title}</h3>
                      <p className="text-xs text-muted-foreground">
                        {paper.authors.slice(0, 3).join(", ")}
                        {paper.authors.length > 3 ? " et al." : ""} {paper.year ? `· ${paper.year}` : ""}{" "}
                        {paper.venue ? `· ${paper.venue}` : ""}
                      </p>
                    </div>
                    <div className="shrink-0 flex items-center gap-2 mt-0.5">
                      {paper.openAccessUrl && (
                        <a
                          href={paper.openAccessUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid={`link-oa-${paper.id}`}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded px-1.5 py-0.5 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors"
                          title={paper.openAccessUrl}
                        >
                          <FileText className="w-3 h-3" /> {t("papers.oa.badge" as any)}
                        </a>
                      )}
                      {paper.externalId.startsWith("report:") ? (
                        <span
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-violet-700 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/40 border border-violet-200 dark:border-violet-900 rounded px-1.5 py-0.5"
                          title={t("externalPaper.dialog.subtitle" as any) as string}
                        >
                          <Building2 className="w-3 h-3" />
                          {t(`externalPaper.badge.${(paper as any).sourceType ?? "other"}` as any)}
                        </span>
                      ) : (
                        <a
                          href={paper.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-primary transition-colors"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      )}
                    </div>
                  </div>
                  {paper.abstract && (
                    <div className="mt-2">
                      <p
                        className="text-xs text-muted-foreground leading-relaxed cursor-pointer"
                        onClick={() => toggleAbstract(paper.id)}
                        title={expandedAbstracts.has(paper.id) ? t("common.collapse" as any) as string : t("common.expand" as any) as string}
                        style={
                          expandedAbstracts.has(paper.id)
                            ? undefined
                            : { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }
                        }
                      >
                        {paper.abstract}
                      </p>
                      {paper.abstract.length > 220 && (
                        <button
                          type="button"
                          onClick={() => toggleAbstract(paper.id)}
                          className="mt-1 text-[11px] font-medium text-primary hover:underline"
                        >
                          {expandedAbstracts.has(paper.id)
                            ? (t("common.collapse" as any) as string)
                            : (t("common.expand" as any) as string)}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {paper.extracted ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-900 rounded-md px-2.5 py-1">
                      <CheckCircle className="w-3.5 h-3.5" /> {t("papers.extract.done" as any)}
                    </span>
                  ) : paper.relevanceSkipped ? (
                    <div className="flex flex-col items-end gap-1.5">
                      <span
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-md px-2.5 py-1"
                        title={t("papers.extract.skipped.reason" as any) as string}
                      >
                        <SkipForward className="w-3.5 h-3.5" /> {t("papers.extract.skipped" as any)}
                      </span>
                      <button
                        data-testid={`button-bypass-extract-${paper.id}`}
                        onClick={() => handleExtract(paper.id, paper.title, { bypassPreflight: true })}
                        disabled={extractingPaperId === paper.id || extractAllProgress !== null}
                        className="inline-flex items-center gap-1.5 rounded-md text-[11px] font-medium h-7 px-2.5 border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors disabled:opacity-50"
                        title={t("papers.extract.bypass.tip" as any) as string}
                      >
                        {extractingPaperId === paper.id ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <AlertCircle className="w-3 h-3" />
                        )}
                        {t("papers.extract.bypass" as any)}
                      </button>
                    </div>
                  ) : (
                    <button
                      data-testid={`button-extract-${paper.id}`}
                      onClick={() => handleExtract(paper.id, paper.title)}
                      disabled={extractingPaperId === paper.id || extractAllProgress !== null}
                      className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium h-8 px-3 bg-secondary text-secondary-foreground hover:bg-accent transition-colors disabled:opacity-50"
                    >
                      {extractingPaperId === paper.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Clock className="w-3.5 h-3.5" />
                      )}
                      {t("papers.extract.btn" as any)}
                    </button>
                  )}
                  <button
                    data-testid={`button-remove-paper-${paper.id}`}
                    onClick={() => handleRemove(paper.id)}
                    className="inline-flex items-center justify-center rounded-md h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Prominent bottom CTA — appears once at least one paper is extracted.
          Disabled only while bulk extraction is actively running. When some
          papers stayed pending (e.g. AI returned no variables for a non-
          empirical paper), we let the user proceed and surface a warning;
          the /models page has its own partial-generation confirm dialog as
          the safety net. Previously this hard-blocked navigation, leaving
          users stuck whenever a single paper failed extraction. */}
      <AddExternalPaperDialog
        sessionId={sessionId}
        open={externalDialogOpen}
        onClose={() => setExternalDialogOpen(false)}
      />

      {someExtracted && (() => {
        // Skipped papers are intentionally excluded from the pending count —
        // they were pre-screened as off-topic; only truly un-processed papers count.
        const pendingCount = (sessionPapers ?? []).filter((p) => !p.extracted && !p.relevanceSkipped).length;
        const isExtracting = !!extractAllProgress;
        // Only block navigation while bulk extraction is actively running.
        // When extraction is idle but some papers stayed pending (e.g. AI
        // returned no variables for a non-empirical paper), let the user
        // proceed — /variables and /models surface their own warnings and the
        // models page already supports a "partial generation" confirm flow.
        // Forcing the user to either retry forever or hand-delete every
        // stuck paper to advance is what was getting them stuck.
        const disabled = isExtracting;
        const disabledReason = isExtracting
          ? t("nextstep.disabled.extracting" as any, { done: extractAllProgress!.done, total: extractAllProgress!.total })
          : undefined;
        const warning = !isExtracting && pendingCount > 0
          ? t("nextstep.warn.pending" as any, { count: pendingCount })
          : undefined;
        return (
          <BigNextStep
            eyebrow={t("nextstep.eyebrow" as any)}
            title={t("nextstep.papers.title" as any)}
            body={t("nextstep.papers.body" as any)}
            href={`/sessions/${sessionId}/variables`}
            cta={t("nextstep.papers.cta" as any)}
            disabled={disabled}
            disabledReason={disabledReason}
            warning={warning}
          />
        );
      })()}
    </div>
  );
}

function FullTextSearchBox({ sessionId }: { sessionId: number }) {
  const { t } = useT();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PaperFullTextHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);
  const inputId = `paper-fts-input-${sessionId}`;

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    const trimmed = q.trim();
    if (!trimmed) {
      setHits(null);
      return;
    }
    const myId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const r = await searchSessionPapersFullText(sessionId, { q: trimmed });
      if (reqIdRef.current !== myId) return;
      setHits(r);
    } catch (err) {
      if (reqIdRef.current !== myId) return;
      setError(err instanceof Error ? err.message : String(err));
      setHits([]);
    } finally {
      if (reqIdRef.current === myId) setLoading(false);
    }
  }

  return (
    <div className="bg-card border border-border rounded-lg p-4 shadow-sm" data-testid="paper-fts">
      <form onSubmit={run} className="flex gap-2">
        <label htmlFor={inputId} className="sr-only">
          {t("papers.fts.button" as any)}
        </label>
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            id={inputId}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("papers.fts.placeholder" as any)}
            aria-label={t("papers.fts.button" as any)}
            className="w-full pl-9 pr-3 py-2 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
            data-testid="paper-fts-input"
          />
        </div>
        <button
          type="submit"
          disabled={loading || !q.trim()}
          className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
          data-testid="paper-fts-submit"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          {t("papers.fts.button" as any)}
        </button>
      </form>

      {error && (
        <div className="mt-3 text-xs text-destructive">{error}</div>
      )}

      {hits !== null && !loading && (
        <div className="mt-4">
          {hits.length === 0 ? (
            <div className="text-sm text-muted-foreground py-2">{t("papers.fts.empty" as any)}</div>
          ) : (
            <div>
              <div className="text-xs text-muted-foreground mb-2">
                {t("papers.fts.heading" as any)} ({hits.length})
              </div>
              <ul className="space-y-2">
                {hits.map((h) => (
                  <li
                    key={h.id}
                    className="border border-border rounded-md p-3 bg-background"
                    data-testid={`paper-fts-hit-${h.id}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-sm font-medium text-foreground">
                        {h.title}
                        {h.year ? <span className="ml-2 text-xs text-muted-foreground">({h.year})</span> : null}
                      </div>
                      <span
                        className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground bg-muted/60 rounded px-1.5 py-0.5"
                        title={t("papers.fts.rank" as any)}
                        data-testid={`paper-fts-rank-${h.id}`}
                      >
                        {t("papers.fts.rank" as any)} {h.rank}
                      </span>
                    </div>
                    {h.authors && h.authors.length > 0 && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {h.authors.slice(0, 4).join(", ")}
                        {h.authors.length > 4 ? " …" : ""}
                      </div>
                    )}
                    {h.snippet && (
                      <div className="mt-2 text-xs text-muted-foreground italic border-l-2 border-border pl-2">
                        <span className="not-italic font-medium text-foreground/70 mr-1">{t("papers.fts.snippet" as any)}:</span>
                        {h.snippet}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

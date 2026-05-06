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
  getListSessionPapersQueryKey,
  getListSessionVariablesQueryKey,
  getGetSessionSummaryQueryKey,
  getGetSessionQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Search, Plus, Trash2, Loader2, BookOpen, ExternalLink, CheckCircle, Clock, Info, Link2, Upload, FileText } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";
import { NextStepHint, BigNextStep } from "@/components/onboarding-stepper";
import { beginExtraction, updateExtraction, endExtraction, useExtractionProgress } from "@/lib/extraction-progress";

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
  const [pdfQueueProgress, setPdfQueueProgress] = useState<{ done: number; total: number } | null>(null);
  const [pdfDragOver, setPdfDragOver] = useState(false);

  const { data: sessionPapers, isLoading: papersLoading } = useListSessionPapers(sessionId, {
    query: { enabled: !!sessionId, queryKey: getListSessionPapersQueryKey(sessionId) },
  });

  const addedIds = new Set((sessionPapers ?? []).map((p) => p.externalId));
  const allExtracted = (sessionPapers?.length ?? 0) > 0 && (sessionPapers ?? []).every((p) => p.extracted);
  const someExtracted = (sessionPapers ?? []).some((p) => p.extracted);

  const handleSearch = () => {
    if (!searchQuery.trim()) return;
    // Persist the query in the URL so browser back/refresh keeps the search context.
    if (typeof window !== "undefined") {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("q", searchQuery);
        window.history.replaceState(null, "", url.toString());
      } catch { /* ignore */ }
    }
    searchPapers.mutate(
      { data: { query: searchQuery, limit: 15 } },
      {
        onSuccess: (results) => setSearchResults(results),
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

  const uploadOnePdf = async (file: File): Promise<boolean> => {
    if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
      toast({ title: t("papers.pdf.toast.notPdf" as any, { name: file.name }), variant: "destructive" });
      return false;
    }
    if (file.size > 25 * 1024 * 1024) {
      toast({ title: t("papers.pdf.toast.tooLarge" as any, { name: file.name }), variant: "destructive" });
      return false;
    }
    setPdfUploading(file.name);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const resp = await fetch(`/api/sessions/${sessionId}/papers/upload-pdf`, { method: "POST", body: fd });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "" }));
        toast({
          title: t("papers.pdf.toast.failed" as any, { name: file.name }),
          description: err.error || `HTTP ${resp.status}`,
          variant: "destructive",
        });
        return false;
      }
      const paper = await resp.json();
      toast({ title: t("papers.pdf.toast.added" as any, { title: paper.title }) });
      return true;
    } catch {
      toast({ title: t("papers.pdf.toast.failed" as any, { name: file.name }), variant: "destructive" });
      return false;
    }
  };

  const handlePdfFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    let ok = 0, fail = 0;
    setPdfQueueProgress({ done: 0, total: arr.length });
    for (let i = 0; i < arr.length; i++) {
      const success = await uploadOnePdf(arr[i]);
      if (success) ok++; else fail++;
      setPdfQueueProgress({ done: i + 1, total: arr.length });
    }
    setPdfUploading(null);
    setPdfQueueProgress(null);
    queryClient.invalidateQueries({ queryKey: getListSessionPapersQueryKey(sessionId) });
    queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
    queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
    if (arr.length > 1) {
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
    const pending = (sessionPapers ?? []).filter((p) => !p.extracted);
    if (pending.length === 0) return;
    const runId = beginExtraction(sessionId, pending.length);
    let ok = 0, fail = 0;
    try {
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i];
        try {
          await extractVariables.mutateAsync({ id: sessionId, paperId: p.id });
          ok++;
        } catch {
          fail++;
        }
        updateExtraction(sessionId, runId, i + 1, pending.length);
      }
    } finally {
      endExtraction(sessionId, runId);
    }
    queryClient.invalidateQueries({ queryKey: getListSessionPapersQueryKey(sessionId) });
    queryClient.invalidateQueries({ queryKey: getListSessionVariablesQueryKey(sessionId) });
    queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
    queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
    toast({
      title: t("papers.toast.extractAllDone" as any, { ok, fail }),
    });
  };

  const handleExtract = (paperId: number, title: string) => {
    extractVariables.mutate(
      { id: sessionId, paperId },
      {
        onSuccess: (vars) => {
          queryClient.invalidateQueries({ queryKey: getListSessionPapersQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getListSessionVariablesQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
          toast({
            title: t("papers.toast.extracted" as any),
            description: t("papers.toast.extractedDesc" as any, { count: vars.length, title: title.slice(0, 40) }),
          });
        },
        onError: () =>
          toast({
            title: t("papers.toast.extractFailed" as any),
            description: t("papers.toast.extractFailedDesc" as any),
            variant: "destructive",
          }),
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

        {searchResults.length > 0 && (
          <div className="mt-5 space-y-3 max-h-[420px] overflow-y-auto pr-1">
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
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">{paper.abstract}</p>
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
              disabled={pdfUploading !== null}
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

      {/* Next-step hint */}
      {(sessionPapers?.length ?? 0) > 0 && !allExtracted && (
        someExtracted ? (
          <NextStepHint
            title={t("papers.tip.next.title" as any)}
            body={t("papers.tip.next.body" as any)}
            href={`/sessions/${sessionId}/variables`}
            cta={t("vars.goModels" as any)}
          />
        ) : (
          <NextStepHint
            title={t("papers.tip.extractAll.title" as any)}
            body={
              extractAllProgress
                ? t("papers.tip.extractAll.progress" as any, { done: extractAllProgress.done, total: extractAllProgress.total })
                : t("papers.tip.extractAll.body" as any, { count: (sessionPapers ?? []).filter((p) => !p.extracted).length })
            }
            cta={extractAllProgress ? t("papers.extract.btn.working" as any) : t("papers.extract.btn.all" as any)}
            onClick={handleExtractAll}
            loading={extractAllProgress !== null || extractVariables.isPending}
            disabled={extractAllProgress !== null}
          />
        )
      )}
      {allExtracted && (sessionPapers?.length ?? 0) > 0 && (
        <NextStepHint
          title={t("vars.tip.next.title" as any)}
          body={t("vars.tip.next.body" as any)}
          href={`/sessions/${sessionId}/models`}
          cta={t("vars.goModels" as any)}
        />
      )}

      {/* Session Papers */}
      <div id="session-papers">
        <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-primary" />
          {t("papers.session.title" as any)}
          {sessionPapers && (
            <span className="text-sm font-normal text-muted-foreground">({sessionPapers.length})</span>
          )}
        </h2>

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
                      <a
                        href={paper.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-primary transition-colors"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </div>
                  </div>
                  {paper.abstract && (
                    <p className="text-xs text-muted-foreground mt-2 line-clamp-2 leading-relaxed">{paper.abstract}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {paper.extracted ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-900 rounded-md px-2.5 py-1">
                      <CheckCircle className="w-3.5 h-3.5" /> {t("papers.extract.done" as any)}
                    </span>
                  ) : (
                    <button
                      data-testid={`button-extract-${paper.id}`}
                      onClick={() => handleExtract(paper.id, paper.title)}
                      disabled={extractVariables.isPending}
                      className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium h-8 px-3 bg-secondary text-secondary-foreground hover:bg-accent transition-colors disabled:opacity-50"
                    >
                      {extractVariables.isPending ? (
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
          Disabled while bulk extraction is running OR while any paper is still
          unextracted, so users don't accidentally generate models on a partial
          variable set and silently miss evidence from the remaining papers. */}
      {someExtracted && (() => {
        const pendingCount = (sessionPapers ?? []).filter((p) => !p.extracted).length;
        const isExtracting = !!extractAllProgress;
        const hasPending = pendingCount > 0;
        const disabled = isExtracting || hasPending;
        const disabledReason = isExtracting
          ? t("nextstep.disabled.extracting" as any, { done: extractAllProgress!.done, total: extractAllProgress!.total })
          : hasPending
            ? t("nextstep.disabled.pending" as any, { count: pendingCount })
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
          />
        );
      })()}
    </div>
  );
}

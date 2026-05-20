import React, { useState, useRef } from "react";
import {
  Loader2,
  X,
  Search,
  Globe,
  CheckSquare,
  Square,
  AlertCircle,
  ExternalLink,
  Download,
} from "lucide-react";
import {
  useIndustrySearchPapers,
  industrySearchPapers,
  useAddExternalPaper,
  getListSessionPapersQueryKey,
  getGetSessionSummaryQueryKey,
  getGetSessionQueryKey,
} from "@workspace/api-client-react";

import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";

type IndustrySearchResponse = Awaited<ReturnType<typeof industrySearchPapers>>;
type SourceFilter = "all" | "gov" | "org" | "think_tank";
type SearchResult = IndustrySearchResponse["results"][number];

const SOURCE_FILTERS: SourceFilter[] = ["all", "gov", "org", "think_tank"];

function scoreColor(score: number): string {
  if (score >= 70) return "bg-emerald-500";
  if (score >= 40) return "bg-amber-400";
  return "bg-muted-foreground/40";
}

function sourceTypeForFilter(filter: SourceFilter, domain: string): "gov_report" | "industry_report" | "other" {
  if (filter === "gov" || domain.includes(".gov")) return "gov_report";
  if (filter === "org" || filter === "think_tank") return "industry_report";
  if (domain.includes(".gov")) return "gov_report";
  if (domain.includes(".org")) return "industry_report";
  return "other";
}

interface Props {
  sessionId: number;
  open: boolean;
  onClose: () => void;
}

export function IndustrySearchPanel({ sessionId, open, onClose }: Props) {
  const { t } = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const industrySearch = useIndustrySearchPapers();
  const addExternal = useAddExternalPaper();

  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [cached, setCached] = useState(false);
  const [queryError, setQueryError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importingIds, setImportingIds] = useState<Set<string>>(new Set());
  const reqRef = useRef(0);

  if (!open) return null;

  const handleClose = () => {
    setQuery("");
    setSourceFilter("all");
    setResults(null);
    setCached(false);
    setQueryError(false);
    setSelected(new Set());
    onClose();
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) { setQueryError(true); return; }
    setQueryError(false);
    setSelected(new Set());
    const myReq = ++reqRef.current;

    industrySearch.mutate(
      { id: sessionId, data: { query: q, sourceFilter } },
      {
        onSuccess: (data) => {
          if (reqRef.current !== myReq) return;
          setResults(data.results);
          setCached(data.cached);
        },
        onError: () => {
          if (reqRef.current !== myReq) return;
          setResults([]);
          setCached(false);
          toast({ title: t("common.error" as any), description: t("common.tryAgain" as any), variant: "destructive" });
        },
      },
    );
  };

  const toggleAll = () => {
    if (!results) return;
    if (selected.size === results.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(results.map((r) => r.id)));
    }
  };

  const toggleItem = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleImport = async () => {
    if (!results) return;
    const toImport = results.filter((r) => selected.has(r.id));
    if (toImport.length === 0) {
      toast({ title: t("industrySearch.toast.noneSelected" as any), variant: "destructive" });
      return;
    }

    setImportingIds(new Set(toImport.map((r) => r.id)));

    let successCount = 0;
    await Promise.all(
      toImport.map(
        (r) =>
          new Promise<void>((resolve) => {
            addExternal.mutate(
              {
                id: sessionId,
                data: {
                  title: r.title,
                  sourceOrg: r.domain,
                  year: null,
                  sourceType: sourceTypeForFilter(sourceFilter, r.domain),
                  abstract: r.snippet ?? null,
                  fullText: r.summary ?? null,
                },
              },
              {
                onSuccess: () => { successCount++; resolve(); },
                onError: () => resolve(),
              },
            );
          }),
      ),
    );

    setImportingIds(new Set());

    if (successCount > 0) {
      queryClient.invalidateQueries({ queryKey: getListSessionPapersQueryKey(sessionId) });
      queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
      queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
      toast({
        title: (t("industrySearch.toast.imported" as any) as string).replace("{{count}}", String(successCount)),
        description: t("industrySearch.hint.extract" as any) as string,
      });
      setSelected(new Set());
    } else {
      toast({ title: t("industrySearch.toast.importFailed" as any), variant: "destructive" });
    }
  };

  const isSearching = industrySearch.isPending;
  const isImporting = importingIds.size > 0;
  const allSelected = results !== null && results.length > 0 && selected.size === results.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative bg-background border border-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Globe className="w-5 h-5 text-primary" />
            <h2 className="text-base font-semibold text-foreground">
              {t("industrySearch.dialog.title" as any)}
            </h2>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="text-muted-foreground hover:text-foreground transition-colors rounded-md p-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Subtitle */}
        <div className="px-5 pt-3 pb-1 shrink-0">
          <p className="text-sm text-muted-foreground">
            {t("industrySearch.dialog.subtitle" as any)}
          </p>
        </div>

        {/* Search form */}
        <form onSubmit={handleSearch} className="px-5 py-4 space-y-3 shrink-0">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t("industrySearch.field.query" as any)} <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              value={query}
              onChange={(e) => { setQuery(e.target.value); if (e.target.value.trim()) setQueryError(false); }}
              placeholder={t("industrySearch.field.query.ph" as any) as string}
              className={`w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${queryError ? "border-destructive" : "border-input"}`}
            />
            {queryError && (
              <p className="mt-1 text-xs text-destructive">
                {t("industrySearch.field.query.required" as any)}
              </p>
            )}
          </div>

          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-sm font-medium text-foreground mb-1">
                {t("industrySearch.filter.label" as any)}
              </label>
              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {SOURCE_FILTERS.map((f) => (
                  <option key={f} value={f}>
                    {t(`industrySearch.filter.${f}` as any)}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={isSearching}
              className="inline-flex items-center gap-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-5 disabled:opacity-50 disabled:pointer-events-none transition-colors shrink-0"
            >
              {isSearching
                ? <><Loader2 className="w-4 h-4 animate-spin" />{t("industrySearch.btn.searching" as any)}</>
                : <><Search className="w-4 h-4" />{t("industrySearch.btn.search" as any)}</>}
            </button>
          </div>
        </form>

        {/* Results */}
        {results !== null && (
          <div className="flex-1 overflow-y-auto border-t border-border">
            {results.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
                <AlertCircle className="w-8 h-8 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">
                  {t("industrySearch.empty" as any)}
                </p>
              </div>
            ) : (
              <>
                {/* Toolbar */}
                <div className="flex items-center justify-between px-5 py-2 bg-muted/30 border-b border-border">
                  <button
                    type="button"
                    onClick={toggleAll}
                    className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {allSelected
                      ? <CheckSquare className="w-3.5 h-3.5 text-primary" />
                      : <Square className="w-3.5 h-3.5" />}
                    {allSelected ? "取消全选" : "全选"}
                  </button>
                  <div className="flex items-center gap-3">
                    {cached && (
                      <span className="text-xs text-muted-foreground">
                        {t("industrySearch.result.cached" as any)}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {results.length} 条结果，已选 {selected.size} 条
                    </span>
                  </div>
                </div>

                {/* Result cards */}
                <div className="divide-y divide-border">
                  {results.map((result) => (
                    <div
                      key={result.id}
                      className={`px-5 py-4 flex gap-3 transition-colors cursor-pointer hover:bg-muted/30 ${selected.has(result.id) ? "bg-primary/5" : ""}`}
                      onClick={() => toggleItem(result.id)}
                    >
                      {/* Checkbox */}
                      <div className="shrink-0 mt-0.5">
                        {selected.has(result.id)
                          ? <CheckSquare className="w-4 h-4 text-primary" />
                          : <Square className="w-4 h-4 text-muted-foreground" />}
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="text-sm font-semibold text-foreground leading-snug line-clamp-2">
                            {result.title}
                          </h3>
                          <a
                            href={result.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
                            title={result.url}
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        </div>

                        <p className="text-xs text-muted-foreground">
                          {result.domain}
                          {result.publishDate ? ` · ${result.publishDate}` : ""}
                        </p>

                        {/* Relevance score */}
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground shrink-0">
                            {t("industrySearch.result.score" as any)}
                          </span>
                          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${scoreColor(result.relevanceScore)}`}
                              style={{ width: `${result.relevanceScore}%` }}
                            />
                          </div>
                          <span className="text-xs font-medium text-foreground shrink-0 w-8 text-right">
                            {result.relevanceScore}
                          </span>
                        </div>

                        {/* Key variables */}
                        {result.keyVariables.length > 0 && (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-xs text-muted-foreground shrink-0">
                              {t("industrySearch.result.variables" as any)}：
                            </span>
                            {result.keyVariables.map((v: string, i: number) => (
                              <span
                                key={i}
                                className="inline-flex items-center text-[11px] font-medium text-violet-700 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/40 border border-violet-200 dark:border-violet-900 rounded px-1.5 py-0.5"
                              >
                                {v}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* AI summary */}
                        {result.summary && (
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            {result.summary}
                          </p>
                        )}

                        {/* Body fetch failed warning */}
                        {result.bodyFetchFailed && (
                          <p className="text-[11px] text-amber-600 dark:text-amber-400">
                            {t("industrySearch.result.bodyFailed" as any)}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Footer */}
        {results !== null && results.length > 0 && (
          <div className="flex items-center justify-between px-5 py-4 border-t border-border bg-background shrink-0">
            <p className="text-xs text-muted-foreground">
              {t("industrySearch.hint.extract" as any)}
            </p>
            <button
              type="button"
              onClick={handleImport}
              disabled={isImporting || selected.size === 0}
              className="inline-flex items-center gap-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-5 disabled:opacity-50 disabled:pointer-events-none transition-colors"
            >
              {isImporting
                ? <><Loader2 className="w-4 h-4 animate-spin" />{t("industrySearch.btn.importing" as any)}</>
                : <><Download className="w-4 h-4" />{t("industrySearch.btn.import" as any)}{selected.size > 0 ? `（${selected.size}）` : ""}</>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

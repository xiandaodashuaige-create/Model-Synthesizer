import React, { useState } from "react";
import { useParams } from "wouter";
import {
  useSearchPapers,
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
import { Search, Plus, Trash2, Loader2, BookOpen, ExternalLink, CheckCircle, Clock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function SessionPapers({ params: routeParams }: { params?: { id?: string } }) {
  const params = useParams<{ id: string }>();
  const sessionId = parseInt(routeParams?.id ?? params.id ?? "0", 10);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{
    externalId: string; title: string; abstract?: string | null; authors: string[];
    year?: number | null; venue?: string | null; citationCount?: number | null;
    openAccessUrl?: string | null; url: string;
  }>>([]);

  const searchPapers = useSearchPapers();
  const addPaper = useAddPaperToSession();
  const removePaper = useRemovePaperFromSession();
  const extractVariables = useExtractVariables();

  const { data: sessionPapers, isLoading: papersLoading } = useListSessionPapers(sessionId, {
    query: { enabled: !!sessionId, queryKey: getListSessionPapersQueryKey(sessionId) }
  });

  const addedIds = new Set((sessionPapers ?? []).map((p) => p.externalId));

  const handleSearch = () => {
    if (!searchQuery.trim()) return;
    searchPapers.mutate({ data: { query: searchQuery, limit: 15 } }, {
      onSuccess: (results) => setSearchResults(results),
      onError: () => toast({ title: "Search failed", description: "Could not reach paper database.", variant: "destructive" }),
    });
  };

  const handleAdd = (paper: typeof searchResults[0]) => {
    addPaper.mutate(
      { id: sessionId, data: { externalId: paper.externalId, title: paper.title, abstract: paper.abstract ?? null, authors: paper.authors, year: paper.year ?? null, venue: paper.venue ?? null, citationCount: paper.citationCount ?? null, openAccessUrl: paper.openAccessUrl ?? null, url: paper.url } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSessionPapersQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
          toast({ title: "Paper added", description: `"${paper.title.slice(0, 60)}..." added to session.` });
        },
        onError: () => toast({ title: "Error", description: "Failed to add paper.", variant: "destructive" }),
      }
    );
  };

  const handleRemove = (paperId: number, title: string) => {
    removePaper.mutate({ sessionId, paperId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSessionPapersQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
        toast({ title: "Paper removed" });
      },
    });
  };

  const handleExtract = (paperId: number, title: string) => {
    extractVariables.mutate({ id: sessionId, paperId }, {
      onSuccess: (vars) => {
        queryClient.invalidateQueries({ queryKey: getListSessionPapersQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getListSessionVariablesQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
        toast({ title: "Variables extracted", description: `Found ${vars.length} variables in "${title.slice(0, 40)}..."` });
      },
      onError: () => toast({ title: "Extraction failed", description: "AI could not extract variables from this paper.", variant: "destructive" }),
    });
  };

  return (
    <div className="space-y-8">
      {/* Search Panel */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
          <Search className="w-5 h-5 text-primary" /> Search Papers
        </h2>
        <div className="flex gap-3">
          <input
            data-testid="input-search-papers"
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="e.g., technology acceptance model healthcare..."
            className="flex-1 h-10 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            data-testid="button-search"
            onClick={handleSearch}
            disabled={searchPapers.isPending || !searchQuery.trim()}
            className="inline-flex items-center justify-center rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-5 disabled:opacity-50 disabled:pointer-events-none gap-2"
          >
            {searchPapers.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            Search
          </button>
        </div>

        {searchResults.length > 0 && (
          <div className="mt-5 space-y-3 max-h-[420px] overflow-y-auto pr-1">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{searchResults.length} results from Semantic Scholar</p>
            {searchResults.map((paper) => {
              const isAdded = addedIds.has(paper.externalId);
              return (
                <div key={paper.externalId} data-testid={`card-search-result-${paper.externalId}`} className="flex items-start gap-4 p-4 rounded-md border border-border bg-background/50 hover:border-primary/30 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-medium text-foreground line-clamp-2 leading-snug">{paper.title}</h3>
                      <a href={paper.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-muted-foreground hover:text-primary transition-colors">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{paper.authors.slice(0, 3).join(", ")}{paper.authors.length > 3 ? " et al." : ""} {paper.year ? `· ${paper.year}` : ""} {paper.venue ? `· ${paper.venue}` : ""} {paper.citationCount != null ? `· ${paper.citationCount} citations` : ""}</p>
                    {paper.abstract && <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">{paper.abstract}</p>}
                  </div>
                  <button
                    data-testid={`button-add-paper-${paper.externalId}`}
                    onClick={() => !isAdded && handleAdd(paper)}
                    disabled={isAdded || addPaper.isPending}
                    className={`shrink-0 inline-flex items-center gap-1.5 rounded-md text-xs font-medium h-8 px-3 transition-colors ${isAdded ? "bg-muted text-muted-foreground cursor-default" : "bg-primary/10 text-primary hover:bg-primary/20"}`}
                  >
                    {isAdded ? <><CheckCircle className="w-3.5 h-3.5" /> Added</> : <><Plus className="w-3.5 h-3.5" /> Add</>}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Session Papers */}
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-primary" />
          Session Papers
          {sessionPapers && <span className="text-sm font-normal text-muted-foreground">({sessionPapers.length})</span>}
        </h2>

        {papersLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
        ) : !sessionPapers || sessionPapers.length === 0 ? (
          <div className="bg-card border border-dashed border-border rounded-lg p-10 text-center">
            <BookOpen className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No papers added yet. Search above and add papers to this session.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {sessionPapers.map((paper) => (
              <div key={paper.id} data-testid={`card-paper-${paper.id}`} className="bg-card border border-border rounded-lg p-5 flex items-start gap-4 hover:border-primary/30 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-foreground leading-snug mb-1">{paper.title}</h3>
                      <p className="text-xs text-muted-foreground">{paper.authors.slice(0, 3).join(", ")}{paper.authors.length > 3 ? " et al." : ""} {paper.year ? `· ${paper.year}` : ""} {paper.venue ? `· ${paper.venue}` : ""}</p>
                    </div>
                    <a href={paper.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-muted-foreground hover:text-primary transition-colors mt-0.5">
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </div>
                  {paper.abstract && <p className="text-xs text-muted-foreground mt-2 line-clamp-2 leading-relaxed">{paper.abstract}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {paper.extracted ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-900 rounded-md px-2.5 py-1">
                      <CheckCircle className="w-3.5 h-3.5" /> Extracted
                    </span>
                  ) : (
                    <button
                      data-testid={`button-extract-${paper.id}`}
                      onClick={() => handleExtract(paper.id, paper.title)}
                      disabled={extractVariables.isPending}
                      className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium h-8 px-3 bg-secondary text-secondary-foreground hover:bg-accent transition-colors disabled:opacity-50"
                    >
                      {extractVariables.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Clock className="w-3.5 h-3.5" />}
                      Extract Variables
                    </button>
                  )}
                  <button
                    data-testid={`button-remove-paper-${paper.id}`}
                    onClick={() => handleRemove(paper.id, paper.title)}
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
    </div>
  );
}

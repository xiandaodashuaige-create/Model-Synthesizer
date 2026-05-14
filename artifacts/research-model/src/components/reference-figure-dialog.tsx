import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSearchModelImages } from "@workspace/api-client-react";
import { ExternalLink, ImageIcon as ImgIcon, Loader2, RotateCcw, Search, X } from "lucide-react";
import { useT } from "@/lib/i18n";

type ImageHit = {
  title: string;
  thumbnailUrl: string;
  imageUrl?: string;
  sourceUrl: string;
  sourceDomain: string;
  width?: number;
  height?: number;
  category?: "conceptual_model" | "sem_path" | "framework";
  why?: string;
  verified?: boolean;
};

const REL_WORD: Record<string, string> = {
  positive: "positive effect",
  negative: "negative effect",
  moderates: "moderating effect",
  mediates: "mediating effect",
};

export function ReferenceFigureDialog({
  open,
  onClose,
  sessionId,
  edge,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: number;
  edge: { from: string; to: string; relationship: string } | null;
}) {
  const { t } = useT();
  const imageSearch = useSearchModelImages();

  const buildQuery = (e: { from: string; to: string; relationship: string }) =>
    `${e.from} ${REL_WORD[e.relationship] ?? "effect on"} ${e.to} conceptual model`;

  const [query, setQuery] = useState("");
  const [rawMode, setRawMode] = useState(false);
  const [expandMode, setExpandMode] = useState(false);
  const [results, setResults] = useState<ImageHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actualQuery, setActualQuery] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [lightbox, setLightbox] = useState<ImageHit | null>(null);
  const reqRef = useRef(0);
  const lastEdgeKeyRef = useRef<string | null>(null);

  const run = (q: string, opts?: { raw?: boolean; expand?: boolean }) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setQuery(trimmed);
    setResults(null);
    setError(null);
    setActualQuery(null);
    setExpanded([]);
    const useRaw = opts?.raw ?? rawMode;
    const useExpand = opts?.expand ?? expandMode;
    const reqId = ++reqRef.current;
    imageSearch.mutate(
      { id: sessionId, data: { query: trimmed, count: 12, raw: useRaw, expand: useExpand, page: 1 } },
      {
        onSuccess: (resp) => {
          if (reqId !== reqRef.current) return;
          setResults((resp.results ?? []) as ImageHit[]);
          setActualQuery((resp as { query?: string }).query ?? null);
          setExpanded(((resp as { expandedQueries?: string[] }).expandedQueries ?? []));
        },
        onError: () => {
          if (reqId !== reqRef.current) return;
          setError(t("live.figureDialog.failed" as any));
        },
      },
    );
  };

  // Auto-search when the dialog opens with a fresh edge.
  useEffect(() => {
    if (!open || !edge) return;
    const key = `${edge.from}__${edge.to}__${edge.relationship}`;
    if (lastEdgeKeyRef.current === key) return;
    lastEdgeKeyRef.current = key;
    const q = buildQuery(edge);
    setRawMode(false);
    run(q, { raw: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, edge?.from, edge?.to, edge?.relationship]);

  // Reset memoized edge key when dialog closes so re-opening on the same edge re-runs.
  useEffect(() => {
    if (!open) lastEdgeKeyRef.current = null;
  }, [open]);

  const edgeLabel = useMemo(() => (edge ? `${edge.from} → ${edge.to}` : ""), [edge]);

  // Close on Escape (only when no lightbox is shown — Esc on lightbox closes
  // it, not the whole dialog).
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      if (lightbox) { setLightbox(null); return; }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, lightbox, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="dialog-reference-figure"
      role="dialog"
      aria-modal="true"
      aria-label={t("live.figureDialog.title" as any) as string}
      onClick={onClose}
    >
      <div
        className="bg-card w-full max-w-4xl max-h-[88vh] overflow-hidden rounded-lg border border-border shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2 min-w-0">
            <ImgIcon className="w-4 h-4 text-sky-700 shrink-0" />
            <h3 className="text-sm font-semibold truncate">{t("live.figureDialog.title" as any)}</h3>
            {edge && (
              <span className="ml-2 text-xs text-muted-foreground truncate">
                {t("live.figureDialog.edgeLabel" as any)}: <span className="font-medium text-foreground">{edgeLabel}</span>
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground p-1"
            aria-label={t("live.figureDialog.close" as any) as string}
            data-testid="button-close-figure-dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-border bg-sky-50/40 space-y-2">
          <label className="text-[11px] font-medium text-sky-900 block">
            {t("live.figureDialog.queryLabel" as any)}
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); run(query); } }}
              data-testid="input-figure-query"
              className="flex-1 text-sm bg-white border border-sky-300 rounded px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
            <button
              type="button"
              onClick={() => run(query)}
              disabled={!query.trim() || imageSearch.isPending}
              data-testid="button-figure-search"
              className="inline-flex items-center gap-1.5 rounded-md bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5"
            >
              {imageSearch.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
              {t("live.figureDialog.searchBtn" as any)}
            </button>
          </div>
          <div className="flex items-center gap-4">
            <label className="inline-flex items-center gap-1.5 text-[11px] text-sky-800 cursor-pointer">
              <input
                type="checkbox"
                checked={rawMode}
                onChange={(e) => setRawMode(e.target.checked)}
                data-testid="checkbox-figure-raw-mode"
                className="rounded"
              />
              {t("live.figureDialog.rawMode" as any)}
            </label>
            <label className="inline-flex items-center gap-1.5 text-[11px] text-sky-800 cursor-pointer" title="同时搜索学术出版商网站（ResearchGate、ScienceDirect 等），覆盖更广但会增加一次额外搜索调用">
              <input
                type="checkbox"
                checked={expandMode}
                onChange={(e) => {
                  setExpandMode(e.target.checked);
                  if (query.trim()) run(query, { expand: e.target.checked });
                }}
                data-testid="checkbox-figure-expand-mode"
                className="rounded"
              />
              {t("live.figureDialog.expandSearch" as any)}
            </label>
          </div>
          {expanded.length > 0 && !rawMode && (
            <div className="rounded-md border border-sky-200 bg-white p-2 space-y-1">
              <div className="text-[10px] font-medium text-sky-800">{t("live.figureDialog.expandedTitle" as any)}</div>
              <ul className="text-[11px] text-sky-900 space-y-0.5">
                {expanded.map((q, i) => (
                  <li key={i} className="font-mono break-all">· {q}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="text-[11px] text-sky-700">{t("live.figureDialog.hint" as any)}</div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {imageSearch.isPending && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> {t("live.figureDialog.loading" as any)}
            </div>
          )}
          {!imageSearch.isPending && error && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-rose-700">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => run(query)}
                className="inline-flex items-center gap-1 rounded border border-rose-300 bg-white hover:bg-rose-50 px-2 py-0.5 text-xs"
                data-testid="button-figure-retry"
              >
                <RotateCcw className="w-3 h-3" /> {t("models.assistant.searchImages.retry" as any)}
              </button>
            </div>
          )}
          {!imageSearch.isPending && !error && results && results.length === 0 && (
            <div className="text-center text-sm text-muted-foreground py-12">{t("live.figureDialog.empty" as any)}</div>
          )}
          {!imageSearch.isPending && !error && results && results.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {results.map((r, i) => (
                <div
                  key={`${r.sourceUrl}-${i}`}
                  data-testid={`figure-result-${i}`}
                  className="border border-border rounded-md overflow-hidden bg-white flex flex-col"
                >
                  <button
                    type="button"
                    onClick={() => setLightbox(r)}
                    className="block w-full aspect-[4/3] bg-muted overflow-hidden"
                    title={r.title}
                  >
                    <img
                      src={r.thumbnailUrl}
                      alt={r.title}
                      className="w-full h-full object-contain"
                      loading="lazy"
                    />
                  </button>
                  <div className="p-2 space-y-1.5">
                    {r.category && (
                      <span
                        className={
                          "inline-block text-[10px] font-medium px-1.5 py-0.5 rounded border " +
                          (r.category === "conceptual_model"
                            ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                            : r.category === "sem_path"
                            ? "bg-violet-50 text-violet-800 border-violet-200"
                            : "bg-amber-50 text-amber-800 border-amber-200")
                        }
                        title={t(`models.assistant.searchImages.category.${r.category}.tip` as any) as string}
                      >
                        ✓ {t(`models.assistant.searchImages.category.${r.category}.label` as any)}
                      </span>
                    )}
                    <div className="text-[11px] line-clamp-2 text-foreground" title={r.title}>{r.title}</div>
                    <div className="text-[10px] text-muted-foreground truncate">{r.sourceDomain}</div>
                    <a
                      href={r.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      data-testid={`link-figure-source-${i}`}
                      className="inline-flex items-center gap-1 text-[11px] text-sky-700 hover:text-sky-900"
                    >
                      {t("live.figureDialog.openSource" as any)} <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
          {actualQuery && results && results.length > 0 && (
            <div className="mt-3 text-[10px] text-muted-foreground">
              {t("models.assistant.searchImages.actualQuery" as any)}: <code className="bg-muted rounded px-1 py-0.5 font-mono">{actualQuery}</code>
            </div>
          )}
        </div>
      </div>

      {lightbox && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
          data-testid="figure-lightbox"
          onClick={(e) => { e.stopPropagation(); setLightbox(null); }}
        >
          <img
            src={lightbox.imageUrl || lightbox.thumbnailUrl}
            alt={lightbox.title}
            className="max-w-full max-h-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

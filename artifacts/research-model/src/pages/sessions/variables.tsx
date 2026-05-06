import React, { useState, useEffect } from "react";
import { useParams, Link } from "wouter";
import {
  useListSessionVariables,
  useGetVariableGraph,
  useListSessionPapers,
  useExtractVariables,
  useUpdateSessionVariable,
  useDeleteSessionVariable,
  getListSessionVariablesQueryKey,
  getGetVariableGraphQueryKey,
  getListSessionPapersQueryKey,
  getGetSessionSummaryQueryKey,
  getGetSessionQueryKey,
  getListSessionModelsQueryKey,
  getGetLiveModelQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Database, ArrowRight, Quote, BookOpen, ChevronDown, ChevronRight as ChevronRightIcon, Layers, RotateCcw, Pencil, Trash2, Check, X as XIcon, ZoomIn, ZoomOut, Maximize2, Star, Pin } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useToast } from "@/hooks/use-toast";
import { NextStepHint, BigNextStep } from "@/components/onboarding-stepper";
import { beginExtraction, updateExtraction, endExtraction, useExtractionProgress } from "@/lib/extraction-progress";
import { clusterKey, loadFocusedClusterKeys, saveFocusedClusterKeys, countByType } from "@/lib/focus-selection";

function useTypeMeta() {
  const { t } = useT();
  return {
    independent: { label: t("vars.type.independent" as any), color: "text-blue-700 dark:text-blue-300", bg: "bg-blue-50 dark:bg-blue-950/40", border: "border-blue-200 dark:border-blue-800" },
    mediator: { label: t("vars.type.mediator" as any), color: "text-amber-700 dark:text-amber-300", bg: "bg-amber-50 dark:bg-amber-950/40", border: "border-amber-200 dark:border-amber-800" },
    moderator: { label: t("vars.type.moderator" as any), color: "text-purple-700 dark:text-purple-300", bg: "bg-purple-50 dark:bg-purple-950/40", border: "border-purple-200 dark:border-purple-800" },
    dependent: { label: t("vars.type.dependent" as any), color: "text-green-700 dark:text-green-300", bg: "bg-green-50 dark:bg-green-950/40", border: "border-green-200 dark:border-green-800" },
  } as Record<string, { label: string; color: string; bg: string; border: string }>;
}

function ReExtractAllButton({ sessionId }: { sessionId: number }) {
  const { t } = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: papers } = useListSessionPapers(sessionId, {
    query: { enabled: !!sessionId, queryKey: getListSessionPapersQueryKey(sessionId) },
  });
  const extractVariables = useExtractVariables();
  // Subscribe to the per-session shared extraction-progress store so the
  // BigNextStep at the page level can disable itself while bulk extraction
  // is in flight (regardless of whether it was kicked off here or from the
  // papers page).
  const progress = useExtractionProgress(sessionId);

  // Block accidental tab close / refresh / navigation while extraction is in
  // flight. The browser shows a generic "Leave site?" dialog (the custom
  // message string is ignored by modern browsers for security reasons) and
  // gives the user a chance to cancel. Note: backend AI calls already in
  // flight will complete and persist regardless — the dialog is purely a UX
  // safeguard to keep the progress UI alive so users see what finished.
  useEffect(() => {
    if (!progress) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [progress]);

  const handleClick = async () => {
    const all = papers ?? [];
    if (all.length === 0) return;
    const runId = beginExtraction(sessionId, all.length);
    let ok = 0, fail = 0, completed = 0, failToastsShown = 0;

    // Concurrency-limited pool: process up to CONCURRENCY papers in flight at
    // once instead of strictly serial. Each AI call is ~10s wall-clock and
    // mostly waits on the OpenAI proxy, so parallelism gives a near-linear
    // speedup up to the proxy's rate limit. 4 is a safe ceiling that
    // empirically avoids 429s while delivering ~3-4x throughput on typical
    // sessions (5-20 papers).
    const CONCURRENCY = 4;
    let cursor = 0;

    const runOne = async (paper: typeof all[0]) => {
      try {
        await extractVariables.mutateAsync({ id: sessionId, paperId: paper.id });
        ok++;
      } catch (err: any) {
        fail++;
        // Cap per-paper toasts so a wholesale outage doesn't flood the screen;
        // the summary toast at the end still reports total failures.
        if (failToastsShown < 3) {
          failToastsShown++;
          const title = (paper as any).title ?? `#${paper.id}`;
          const reason = err?.data?.error ?? err?.response?.data?.error ?? err?.message ?? "";
          toast({
            title: t("papers.toast.extractOneFailed" as any, { title: String(title).slice(0, 60) }),
            description: reason ? String(reason).slice(0, 200) : undefined,
            variant: "destructive",
          });
        }
      } finally {
        completed++;
        updateExtraction(sessionId, runId, completed, all.length);
      }
    };

    const worker = async () => {
      while (cursor < all.length) {
        const idx = cursor++;
        await runOne(all[idx]);
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, all.length) }, () => worker()),
      );
    } finally {
      endExtraction(sessionId, runId);
    }
    queryClient.invalidateQueries({ queryKey: getListSessionPapersQueryKey(sessionId) });
    queryClient.invalidateQueries({ queryKey: getListSessionVariablesQueryKey(sessionId) });
    queryClient.invalidateQueries({ queryKey: getGetVariableGraphQueryKey(sessionId) });
    queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
    queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
    toast({ title: t("papers.toast.extractAllDone" as any, { ok, fail }) });
  };

  const label = progress
    ? t("vars.graph.empty.reextractProgress" as any, { done: progress.done, total: progress.total })
    : t("vars.graph.empty.reextractAll" as any);

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={progress !== null || !papers || papers.length === 0}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-900 text-amber-50 hover:bg-amber-800 dark:bg-amber-100 dark:text-amber-950 dark:hover:bg-amber-200 text-sm font-medium disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {progress ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
      {label}
    </button>
  );
}

function VariableGraph({ sessionId }: { sessionId: number }) {
  const { t } = useT();
  const TYPE_META = useTypeMeta();
  // Multi-focus: clicking a node adds it to the focused set; clicking it
  // again removes it. Edges/neighbors are the UNION across all focused nodes,
  // so users can visually compare or chain together multiple variables.
  const [focusedIds, setFocusedIds] = useState<Set<string>>(() => new Set());
  const clearFocus = () => setFocusedIds(new Set());
  // Zoom state for the SVG. We scale by changing the rendered width/height
  // while keeping the viewBox fixed, so the inner overflow-auto container
  // gives us scrollbars at higher zoom levels.
  const [zoom, setZoom] = useState(1);
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 3;
  const ZOOM_STEP = 0.25;
  const zoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100));
  const zoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100));
  const zoomReset = () => setZoom(1);
  const { data: graph, isLoading } = useGetVariableGraph(sessionId, {
    query: { enabled: !!sessionId, queryKey: getGetVariableGraphQueryKey(sessionId) },
  });

  if (isLoading) return <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  if (!graph || graph.nodes.length === 0) return null;

  // Honest empty state: when variables exist but the paper_hypotheses
  // table has nothing for this session, we render NO synthetic edges
  // (the previous behavior fabricated cartesian-product edges, which
  // misled users). Tell them how to populate real relationships.
  if (graph.edges.length === 0) {
    return (
      <div className="bg-card border border-border rounded-lg p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">{t("vars.graph.title" as any)}</h3>
        <div className="rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30 p-4">
          <div className="text-sm font-semibold text-amber-900 dark:text-amber-200 mb-1">
            {t("vars.graph.empty.title" as any)}
          </div>
          <p className="text-sm text-amber-900/80 dark:text-amber-200/80 leading-relaxed">
            {t("vars.graph.empty.body" as any)}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <ReExtractAllButton sessionId={sessionId} />
            <Link
              href={`/sessions/${sessionId}/papers`}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-900 dark:text-amber-100 hover:underline"
            >
              {t("vars.graph.empty.cta" as any)} <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const NODE_W = 170;
  const NODE_H = 52;
  const ROW_GAP = 14;
  const COL_GAP = 60;
  const PAD_X = 24;
  const PAD_Y = 24;
  const groups: Record<string, typeof graph.nodes> = {};
  for (const n of graph.nodes) {
    if (!groups[n.type]) groups[n.type] = [];
    groups[n.type].push(n);
  }
  const typeOrder = ["independent", "mediator", "moderator", "dependent"];
  const cols = typeOrder.filter((t) => (groups[t]?.length ?? 0) > 0);
  const maxRows = Math.max(1, ...cols.map((t) => groups[t]!.length));
  const WIDTH = PAD_X * 2 + cols.length * NODE_W + (cols.length - 1) * COL_GAP;
  const HEIGHT = PAD_Y * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP;
  const positions = new Map<string, { x: number; y: number }>();
  cols.forEach((type, colIdx) => {
    const nodes = groups[type] ?? [];
    const colX = PAD_X + colIdx * (NODE_W + COL_GAP) + NODE_W / 2;
    const totalH = nodes.length * NODE_H + (nodes.length - 1) * ROW_GAP;
    const startY = PAD_Y + (HEIGHT - PAD_Y * 2 - totalH) / 2;
    nodes.forEach((node, rowIdx) => {
      positions.set(node.id, { x: colX, y: startY + rowIdx * (NODE_H + ROW_GAP) + NODE_H / 2 });
    });
  });

  const colorMap: Record<string, string> = {
    independent: "#2563eb", mediator: "#d97706", moderator: "#7c3aed", dependent: "#16a34a",
  };

  // Wrap label across up to 2 lines so longer names stay readable.
  const wrapLabel = (label: string, maxPerLine = 22): string[] => {
    if (label.length <= maxPerLine) return [label];
    const words = label.split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      if ((cur + " " + w).trim().length > maxPerLine) {
        if (cur) lines.push(cur.trim());
        cur = w;
      } else {
        cur = (cur + " " + w).trim();
      }
      if (lines.length >= 2) break;
    }
    if (lines.length < 2 && cur) lines.push(cur.trim());
    if (lines.length === 0) lines.push(label.slice(0, maxPerLine));
    // If still overflowing the second line, ellipsize.
    if (lines[1] && lines[1].length > maxPerLine) lines[1] = lines[1].slice(0, maxPerLine - 1) + "…";
    return lines.slice(0, 2);
  };

  // Aggregate edges across papers: same (source,target,relationship) → one edge with paper count.
  type AggEdge = { source: string; target: string; relationship: string; paperCount: number; statements: string[] };
  const edgeAgg = new Map<string, AggEdge>();
  for (const e of graph.edges) {
    const k = `${e.source}->${e.target}|${e.relationship}`;
    const cur = edgeAgg.get(k);
    if (cur) {
      cur.paperCount++;
      if (cur.statements.length < 3) cur.statements.push(`${e.paperTitle}: ${e.statement}`);
    } else {
      edgeAgg.set(k, { source: e.source, target: e.target, relationship: e.relationship, paperCount: 1, statements: [`${e.paperTitle}: ${e.statement}`] });
    }
  }
  const aggEdges = [...edgeAgg.values()];

  const REL_STYLE: Record<string, { color: string; dash?: string; symbol: string; labelKey: string }> = {
    positive:  { color: "#16a34a", symbol: "+", labelKey: "vars.graph.rel.positive" },
    negative:  { color: "#dc2626", symbol: "−", labelKey: "vars.graph.rel.negative" },
    moderates: { color: "#7c3aed", symbol: "M", labelKey: "vars.graph.rel.moderates", dash: "5,4" },
    mediates:  { color: "#d97706", symbol: "Med", labelKey: "vars.graph.rel.mediates" },
  };

  // Focus mode: when one or more nodes are selected, only edges touching ANY
  // of them stay visible; the focused nodes plus their union of neighbors
  // stay full opacity, everything else dims.
  const hasFocus = focusedIds.size > 0;
  const focusedNodes = hasFocus
    ? graph.nodes.filter((n) => focusedIds.has(n.id))
    : [];
  const focusedEdges = hasFocus
    ? aggEdges.filter((e) => focusedIds.has(e.source) || focusedIds.has(e.target))
    : aggEdges;
  const neighborIds = new Set<string>();
  if (hasFocus) {
    for (const id of focusedIds) neighborIds.add(id);
    for (const e of focusedEdges) {
      neighborIds.add(e.source);
      neighborIds.add(e.target);
    }
  }
  const isNodeDim = (nodeId: string) => hasFocus && !neighborIds.has(nodeId);
  const isEdgeFocused = (edge: AggEdge) =>
    !hasFocus || focusedIds.has(edge.source) || focusedIds.has(edge.target);
  const handleNodeClick = (nodeId: string) => {
    setFocusedIds((cur) => {
      const next = new Set(cur);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };
  // Comma-joined list of focused names, truncated for the header pill.
  const focusedLabel = (() => {
    if (focusedNodes.length === 0) return "";
    if (focusedNodes.length <= 3) return focusedNodes.map((n) => n.label).join("、");
    return focusedNodes.slice(0, 3).map((n) => n.label).join("、") + ` +${focusedNodes.length - 3}`;
  })();
  // Pick a representative color for the pill — first focused node's type color.
  const focusedPillColor = focusedNodes[0] ? (colorMap[focusedNodes[0].type] ?? "#666") : "#666";

  return (
    <div className="bg-card border border-border rounded-lg p-5">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <h3 className="text-sm font-semibold text-foreground">{t("vars.graph.title" as any)}</h3>
        {hasFocus ? (
          <div className="inline-flex items-center gap-2 text-xs">
            <span
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full font-medium border"
              style={{ color: focusedPillColor, borderColor: focusedPillColor + "66", backgroundColor: focusedPillColor + "14" }}
              title={focusedNodes.map((n) => n.label).join("、")}
            >
              {focusedNodes.length === 1
                ? t("vars.graph.focus.label" as any, { name: focusedLabel })
                : t("vars.graph.focus.labelMulti" as any, { count: focusedNodes.length, names: focusedLabel })}
              <span className="text-muted-foreground font-normal">· {t("vars.graph.focus.count" as any, { n: focusedEdges.length })}</span>
            </span>
            <button
              type="button"
              onClick={clearFocus}
              className="text-xs text-primary hover:underline font-medium"
              data-testid="btn-clear-focus"
            >
              {t("vars.graph.focus.clear" as any)}
            </button>
          </div>
        ) : (
          <span className="text-[11px] text-muted-foreground">{t("vars.graph.focus.hint" as any)}</span>
        )}
      </div>
      <div className="flex items-center gap-1 mb-2">
        <button
          type="button"
          onClick={zoomOut}
          disabled={zoom <= ZOOM_MIN + 1e-6}
          className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-border hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
          title={t("vars.graph.zoom.out" as any)}
          data-testid="btn-zoom-out"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={zoomReset}
          className="inline-flex items-center justify-center h-7 px-2 rounded-md border border-border hover:bg-muted text-[11px] font-medium tabular-nums min-w-[3.5rem]"
          title={t("vars.graph.zoom.reset" as any)}
          data-testid="btn-zoom-reset"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          onClick={zoomIn}
          disabled={zoom >= ZOOM_MAX - 1e-6}
          className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-border hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
          title={t("vars.graph.zoom.in" as any)}
          data-testid="btn-zoom-in"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        <span className="text-[11px] text-muted-foreground ml-2 inline-flex items-center gap-1">
          <Maximize2 className="w-3 h-3" />
          {t("vars.graph.zoom.hint" as any)}
        </span>
      </div>
      {hasFocus && focusedEdges.length === 0 && (
        <div className="mb-3 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          {t("vars.graph.focus.empty" as any)}
        </div>
      )}
      <div
        className="overflow-auto max-h-[640px]"
        onWheel={(e) => {
          // Ctrl/Cmd + wheel zooms; plain wheel scrolls normally.
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            if (e.deltaY < 0) zoomIn();
            else zoomOut();
          }
        }}
      >
        <svg
          width={WIDTH * zoom}
          height={HEIGHT * zoom}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="text-foreground"
          style={{ minWidth: WIDTH * zoom, minHeight: HEIGHT * zoom }}
          onClick={(e) => {
            // Click on blank SVG area (not on a node/edge group) clears focus.
            if (e.target === e.currentTarget) clearFocus();
          }}
        >
          <rect
            x={0}
            y={0}
            width={WIDTH}
            height={HEIGHT}
            fill="transparent"
            onClick={clearFocus}
          />
          <defs>
            {Object.entries(REL_STYLE).map(([rel, s]) => (
              <marker key={rel} id={`arrow-${rel}`} markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">
                <path d="M0,0 L0,6 L8,3 z" fill={s.color} opacity={0.85} />
              </marker>
            ))}
          </defs>
          {aggEdges.map((edge, i) => {
            const from = positions.get(edge.source);
            const to = positions.get(edge.target);
            if (!from || !to) return null;
            const isFocusedEdge = isEdgeFocused(edge);
            const dimEdge = hasFocus && !isFocusedEdge;
            const safeRel = REL_STYLE[edge.relationship] ? edge.relationship : "positive";
            const style = REL_STYLE[safeRel];
            const fromX = from.x + NODE_W / 2;
            const toX = to.x - NODE_W / 2;
            const dx = Math.max(40, (toX - fromX) * 0.5);
            const c1x = fromX + dx;
            const c2x = toX - dx;
            // Approximate midpoint for the relationship label.
            const rawMidX = (fromX + toX) / 2;
            const midY = (from.y + to.y) / 2;
            const labelText = edge.paperCount > 1 ? `${style.symbol} ×${edge.paperCount}` : style.symbol;
            const labelW = labelText.length * 8 + 8;
            // Clamp the label box so it never bleeds past the SVG horizontal edges.
            const midX = Math.min(WIDTH - labelW / 2 - 2, Math.max(labelW / 2 + 2, rawMidX));
            const tooltip = edge.statements.join("\n\n");
            return (
              <g key={i} opacity={dimEdge ? 0.08 : 1} style={{ transition: "opacity 150ms" }}>
                <title>{tooltip}</title>
                <path
                  d={`M ${fromX} ${from.y} C ${c1x} ${from.y}, ${c2x} ${to.y}, ${toX} ${to.y}`}
                  fill="none"
                  stroke={style.color}
                  strokeOpacity={0.7}
                  strokeWidth={isFocusedEdge && hasFocus ? 2.4 : 1.8}
                  strokeDasharray={style.dash}
                  markerEnd={`url(#arrow-${safeRel})`}
                />
                <rect
                  x={midX - labelW / 2}
                  y={midY - 9}
                  width={labelW}
                  height={18}
                  rx={4}
                  fill="white"
                  fillOpacity={0.95}
                  stroke={style.color}
                  strokeOpacity={0.5}
                  strokeWidth={1}
                />
                <text
                  x={midX}
                  y={midY + 4}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight={700}
                  fill={style.color}
                >
                  {labelText}
                </text>
              </g>
            );
          })}
          {graph.nodes.map((node) => {
            const pos = positions.get(node.id);
            if (!pos) return null;
            const color = colorMap[node.type] ?? "#888";
            const lines = wrapLabel(node.label);
            const isFocused = focusedIds.has(node.id);
            const dim = isNodeDim(node.id);
            return (
              <g
                key={node.id}
                transform={`translate(${pos.x - NODE_W / 2}, ${pos.y - NODE_H / 2})`}
                onClick={(e) => { e.stopPropagation(); handleNodeClick(node.id); }}
                style={{ cursor: "pointer", transition: "opacity 150ms" }}
                opacity={dim ? 0.25 : 1}
                data-testid={`graph-node-${node.id}`}
              >
                <title>{node.label}</title>
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  fill={color}
                  fillOpacity={isFocused ? 0.22 : 0.12}
                  stroke={color}
                  strokeOpacity={isFocused ? 0.95 : 0.4}
                  strokeWidth={isFocused ? 2.5 : 1.5}
                />
                {lines.length === 1 ? (
                  <text x={NODE_W / 2} y={NODE_H / 2 - 2} textAnchor="middle" fontSize={11} fontWeight={600} fill={color}>
                    {lines[0]}
                  </text>
                ) : (
                  <>
                    <text x={NODE_W / 2} y={NODE_H / 2 - 6} textAnchor="middle" fontSize={10.5} fontWeight={600} fill={color}>
                      {lines[0]}
                    </text>
                    <text x={NODE_W / 2} y={NODE_H / 2 + 6} textAnchor="middle" fontSize={10.5} fontWeight={600} fill={color}>
                      {lines[1]}
                    </text>
                  </>
                )}
                <text x={NODE_W / 2} y={NODE_H - 6} textAnchor="middle" fontSize={9} fill={color} opacity={0.7}>
                  {node.paperCount}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2 mt-3 items-center">
        <div className="flex flex-wrap gap-3">
          {Object.entries(colorMap).map(([type, color]) =>
            groups[type]?.length ? (
              <div key={type} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: color }} />
                {TYPE_META[type]?.label}
              </div>
            ) : null
          )}
        </div>
        {aggEdges.length > 0 && (
          <>
            <span className="text-xs text-muted-foreground/60">|</span>
            <div className="flex flex-wrap gap-3">
              {Object.entries(REL_STYLE).map(([rel, s]) =>
                aggEdges.some((e) => e.relationship === rel) ? (
                  <div key={rel} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span
                      className="inline-flex items-center justify-center w-5 h-4 text-[10px] font-bold rounded border"
                      style={{ color: s.color, borderColor: s.color, borderStyle: s.dash ? "dashed" : "solid" }}
                    >
                      {s.symbol}
                    </span>
                    {t(s.labelKey as any)}
                  </div>
                ) : null
              )}
            </div>
          </>
        )}
      </div>
      {aggEdges.length > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t("vars.graph.edgesSummary" as any, { edges: aggEdges.length, raw: graph.edges.length })}
        </p>
      )}
    </div>
  );
}

export default function SessionVariables({ params: routeParams }: { params?: { id?: string } }) {
  const { t } = useT();
  const TYPE_META = useTypeMeta();
  const params = useParams<{ id: string }>();
  const sessionId = parseInt(routeParams?.id ?? params.id ?? "0", 10);
  const extractionProgress = useExtractionProgress(sessionId);

  const { data: variables, isLoading } = useListSessionVariables(sessionId, {
    query: { enabled: !!sessionId, queryKey: getListSessionVariablesQueryKey(sessionId) },
  });
  // Pull papers list to detect papers whose variables haven't been extracted
  // yet — generating models on a partial variable set silently drops the
  // remaining papers' evidence, which is the bug users reported. Treat the
  // loading state as "pending" too, so there is no transient window where
  // the CTA is enabled before guard data arrives.
  const { data: papersForGuard, isLoading: papersForGuardLoading } = useListSessionPapers(sessionId, {
    query: { enabled: !!sessionId, queryKey: getListSessionPapersQueryKey(sessionId) },
  });
  const pendingPapersCount = (papersForGuard ?? []).filter((p) => !p.extracted).length;
  const papersGuardBusy = papersForGuardLoading || papersForGuard === undefined;

  // ── Focus-variable selection (optional) ──────────────────────────────
  // The user can pin any cluster card to mark it as a "must use" variable
  // for the next model-generation step. Selection is keyed by cluster key
  // (type|normalizedName), persisted in localStorage per session, and
  // hydrated on /models so the AI builds candidates around the picks.
  const [focusedKeys, setFocusedKeys] = useState<string[]>(() => loadFocusedClusterKeys(sessionId));
  useEffect(() => {
    // Re-hydrate when navigating between sessions (sessionId may flip).
    setFocusedKeys(loadFocusedClusterKeys(sessionId));
  }, [sessionId]);
  const focusedSet = React.useMemo(() => new Set(focusedKeys), [focusedKeys]);
  const toggleFocus = (key: string) => {
    setFocusedKeys((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      saveFocusedClusterKeys(sessionId, next);
      return next;
    });
  };
  const clearFocus = () => {
    setFocusedKeys([]);
    saveFocusedClusterKeys(sessionId, []);
  };
  const focusCounts = React.useMemo(
    () => countByType(focusedKeys, variables ?? []),
    [focusedKeys, variables],
  );

  if (isLoading) return <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;

  if (!variables || variables.length === 0) {
    return (
      <div className="bg-card border border-dashed border-border rounded-lg p-12 text-center">
        <Database className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
        <h3 className="font-semibold text-foreground mb-1">{t("vars.empty.title" as any)}</h3>
        <p className="text-sm text-muted-foreground mb-4">{t("vars.empty.body" as any)}</p>
        <Link href={`/sessions/${sessionId}/papers`} className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline font-medium">
          {t("vars.empty.cta" as any)} <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
    );
  }

  // Cluster variables by canonical name (case-insensitive, whitespace-normalized)
  // so the same concept extracted from multiple papers shows as ONE entry with all sources.
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  type V = (typeof variables)[number];
  type Cluster = { key: string; type: string; name: string; sources: V[] };
  const clusterMap = new Map<string, Cluster>();
  for (const v of variables) {
    const key = `${v.type}|${norm(v.name)}`;
    if (!clusterMap.has(key)) {
      clusterMap.set(key, { key, type: v.type, name: v.name, sources: [] });
    }
    clusterMap.get(key)!.sources.push(v);
  }
  const clusters = [...clusterMap.values()].sort((a, b) => b.sources.length - a.sources.length);

  const grouped: Record<string, Cluster[]> = {};
  for (const c of clusters) {
    (grouped[c.type] ??= []).push(c);
  }

  const typeOrder = ["independent", "mediator", "moderator", "dependent"];
  const PRIMARY_THRESHOLD = 2;

  return (
    <div className="space-y-8">
      <BigNextStep
        eyebrow={t("nextstep.eyebrow" as any)}
        title={t("nextstep.vars.title" as any)}
        body={t("nextstep.vars.body" as any)}
        href={`/sessions/${sessionId}/models`}
        cta={t("nextstep.vars.cta" as any)}
        disabled={!!extractionProgress || pendingPapersCount > 0 || papersGuardBusy}
        disabledReason={
          extractionProgress
            ? t("nextstep.disabled.extracting" as any, { done: extractionProgress.done, total: extractionProgress.total })
            : pendingPapersCount > 0
              ? t("nextstep.disabled.pending" as any, { count: pendingPapersCount })
              : undefined
        }
      />

      <VariableGraph sessionId={sessionId} />

      <div className="rounded-md border border-border bg-muted/30 p-4 text-xs text-muted-foreground flex items-start gap-2">
        <Layers className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
        <span>{t("vars.cluster.hint" as any, { clusterCount: clusters.length, totalCount: variables.length })}</span>
      </div>

      {/* Optional focus-selection guidance. Pinning is entirely optional — if
          the user does nothing the next step generates models freely; if they
          pin a few clusters those become the spine of every candidate model. */}
      <div
        data-testid="focus-selection-banner"
        className={`rounded-lg border p-4 flex items-start gap-3 ${
          focusCounts.total > 0
            ? "border-amber-300 bg-amber-50/60 dark:border-amber-800/60 dark:bg-amber-950/30"
            : "border-dashed border-border bg-muted/20"
        }`}
      >
        <Star className={`w-4 h-4 mt-0.5 shrink-0 ${focusCounts.total > 0 ? "text-amber-600 fill-amber-400" : "text-muted-foreground"}`} />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-foreground mb-0.5">
            {t("vars.focus.title" as any)}
          </h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t("vars.focus.body" as any)}
          </p>
          {focusCounts.total > 0 && (
            <div className="mt-2 flex items-center gap-3 flex-wrap text-xs">
              <span data-testid="focus-counts-summary" className="font-medium text-amber-800 dark:text-amber-200">
                {t("vars.focus.summary" as any, {
                  total: focusCounts.total,
                  iv: focusCounts.independent,
                  med: focusCounts.mediator,
                  mod: focusCounts.moderator,
                  dv: focusCounts.dependent,
                })}
              </span>
              <button
                type="button"
                data-testid="button-clear-focus"
                onClick={clearFocus}
                className="text-primary hover:underline"
              >
                {t("vars.focus.clear" as any)}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-8">
        {typeOrder.filter((tp) => grouped[tp]?.length).map((type) => {
          const meta = TYPE_META[type]!;
          const list = grouped[type] ?? [];
          const primary = list.filter((c) => c.sources.length >= PRIMARY_THRESHOLD);
          const secondary = list.filter((c) => c.sources.length < PRIMARY_THRESHOLD);
          return (
            <div key={type}>
              <h2 className={`text-sm font-semibold uppercase tracking-wider mb-3 flex items-center gap-2 ${meta.color}`}>
                <span className={`w-2 h-2 rounded-full inline-block ${meta.bg} border ${meta.border}`} />
                {meta.label}
                <span className="font-normal text-muted-foreground normal-case tracking-normal">
                  {t("vars.cluster.suffix" as any, { unique: list.length, total: list.reduce((s, c) => s + c.sources.length, 0) })}
                </span>
              </h2>

              {primary.length > 0 && (
                <div className="space-y-3 mb-3">
                  {primary.map((c) => (
                    <ClusterCard
                      key={c.key}
                      cluster={c}
                      meta={meta}
                      primary
                      pinned={focusedSet.has(c.key)}
                      onTogglePin={() => toggleFocus(c.key)}
                    />
                  ))}
                </div>
              )}

              {secondary.length > 0 && (
                <SecondaryGroup
                  clusters={secondary}
                  meta={meta}
                  focusedSet={focusedSet}
                  onTogglePin={toggleFocus}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ClusterCard({
  cluster,
  meta,
  primary,
  pinned = false,
  onTogglePin,
}: {
  cluster: { key: string; type: string; name: string; sources: any[] };
  meta: { label: string; color: string; bg: string; border: string };
  primary?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const top = cluster.sources[0];
  return (
    <div
      data-testid={`cluster-${cluster.key}`}
      className={`bg-card border rounded-lg p-5 transition-colors ${
        pinned ? "border-amber-400 ring-1 ring-amber-300/60 dark:border-amber-700 dark:ring-amber-800/60" : meta.border
      }`}
    >
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-foreground">{cluster.name}</h3>
            {primary && cluster.sources.length >= 2 && (
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${meta.bg} ${meta.color} border ${meta.border}`}>
                {t("vars.cluster.fromN" as any, { n: cluster.sources.length })}
              </span>
            )}
            {pinned && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-900/40 dark:text-amber-200 dark:border-amber-700 inline-flex items-center gap-1">
                <Pin className="w-2.5 h-2.5 fill-current" />
                {t("vars.focus.pinned" as any)}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{top.definition}</p>
        </div>
        <div className="shrink-0 flex items-center gap-1.5">
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${meta.bg} ${meta.color} border ${meta.border}`}>
            {meta.label}
          </span>
          {onTogglePin && (
            <button
              type="button"
              data-testid={`button-toggle-focus-${cluster.key}`}
              onClick={onTogglePin}
              title={pinned ? t("vars.focus.unpinTip" as any) as string : t("vars.focus.pinTip" as any) as string}
              className={`inline-flex items-center gap-1 text-xs font-medium h-7 px-2 rounded border transition-colors ${
                pinned
                  ? "bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-200 dark:bg-amber-900/50 dark:text-amber-200 dark:border-amber-700"
                  : "bg-background text-muted-foreground border-border hover:text-foreground hover:border-amber-300"
              }`}
            >
              <Star className={`w-3.5 h-3.5 ${pinned ? "fill-amber-500 text-amber-600" : ""}`} />
              {pinned ? t("vars.focus.pinnedShort" as any) : t("vars.focus.pinShort" as any)}
            </button>
          )}
        </div>
      </div>

      {/* Source paper chips */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {cluster.sources.map((s) => (
          <span
            key={s.id}
            title={s.paperTitle}
            className="inline-flex items-center gap-1 max-w-[260px] text-[11px] bg-muted text-muted-foreground border border-border rounded-full px-2 py-0.5"
          >
            <BookOpen className="w-3 h-3 shrink-0" />
            <span className="truncate">
              {(s.paperAuthors?.[0] ?? "Unknown")}
              {s.paperYear ? ` (${s.paperYear})` : ""}
            </span>
          </span>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRightIcon className="w-3.5 h-3.5" />}
        {expanded ? t("vars.cluster.hide" as any) : t("vars.cluster.show" as any, { n: cluster.sources.length })}
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">
          {cluster.sources.map((s) => (
            <SourceRow key={s.id} source={s} meta={meta} />
          ))}
        </div>
      )}
    </div>
  );
}

// Per-paper extraction row, with inline rename + delete. Lets the user fix
// individual extractions without re-running the whole paper.
function SourceRow({
  source,
  meta,
}: {
  source: any;
  meta: { label: string; color: string; bg: string; border: string };
}) {
  const { t } = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateVar = useUpdateSessionVariable();
  const deleteVar = useDeleteSessionVariable();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState<string>(source.name);

  const invalidate = () => {
    // Variable name changes ripple into generated models and the live model
    // — invalidate those query keys too so a rename doesn't leave stale names
    // on already-rendered model cards.
    queryClient.invalidateQueries({ queryKey: getListSessionVariablesQueryKey(source.sessionId) });
    queryClient.invalidateQueries({ queryKey: getGetVariableGraphQueryKey(source.sessionId) });
    queryClient.invalidateQueries({ queryKey: getListSessionModelsQueryKey(source.sessionId) });
    queryClient.invalidateQueries({ queryKey: getGetLiveModelQueryKey(source.sessionId) });
  };

  const saveRename = () => {
    const name = draftName.trim();
    if (!name || name === source.name) { setEditing(false); return; }
    updateVar.mutate(
      { id: source.sessionId, variableId: source.id, data: { name } },
      {
        onSuccess: () => { setEditing(false); invalidate(); toast({ title: "已更新变量名称" }); },
        onError: () => toast({ title: "更新失败", variant: "destructive" }),
      },
    );
  };

  const handleDelete = () => {
    if (!window.confirm(`确定删除「${source.name}」?(仅删除该论文的这一条提取,不影响其他论文)`)) return;
    deleteVar.mutate(
      { id: source.sessionId, variableId: source.id },
      {
        onSuccess: () => { invalidate(); toast({ title: "已删除变量" }); },
        onError: () => toast({ title: "删除失败", variant: "destructive" }),
      },
    );
  };

  return (
    <div className={`rounded-md border ${meta.border} ${meta.bg} p-3`}>
      <div className="flex items-start gap-2 mb-2">
        <Quote className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${meta.color}`} />
        <p className={`text-xs leading-relaxed ${meta.color} italic flex-1`}>{source.citationText}</p>
        {!editing ? (
          <div className="shrink-0 flex items-center gap-1">
            <button
              type="button"
              data-testid={`button-rename-variable-${source.id}`}
              onClick={() => { setDraftName(source.name); setEditing(true); }}
              title="重命名"
              className="text-muted-foreground hover:text-foreground"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              data-testid={`button-delete-variable-${source.id}`}
              onClick={handleDelete}
              disabled={deleteVar.isPending}
              title="删除"
              className="text-muted-foreground hover:text-red-600 disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <div className="shrink-0 flex items-center gap-1">
            <input
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setEditing(false); }}
              data-testid={`input-rename-variable-${source.id}`}
              autoFocus
              className="text-xs rounded border border-input bg-background px-2 py-0.5 w-40"
            />
            <button
              type="button"
              data-testid={`button-confirm-rename-${source.id}`}
              onClick={saveRename}
              disabled={updateVar.isPending}
              className="text-emerald-700 hover:text-emerald-900 disabled:opacity-50"
            >
              {updateVar.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              <XIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <BookOpen className="w-3.5 h-3.5 shrink-0" />
        <span className="font-medium">{source.paperTitle}</span>
        {source.paperAuthors?.length > 0 && (
          <span>· {source.paperAuthors.slice(0, 2).join(", ")}{source.paperAuthors.length > 2 ? " et al." : ""}</span>
        )}
        {source.paperYear && <span>· {source.paperYear}</span>}
      </div>
    </div>
  );
}

function SecondaryGroup({
  clusters,
  meta,
  focusedSet,
  onTogglePin,
}: {
  clusters: Array<{ key: string; type: string; name: string; sources: any[] }>;
  meta: { label: string; color: string; bg: string; border: string };
  focusedSet?: Set<string>;
  onTogglePin?: (key: string) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <details
      className="bg-muted/20 border border-dashed border-border rounded-lg"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer select-none text-xs text-muted-foreground p-3 flex items-center gap-2 hover:text-foreground">
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRightIcon className="w-3.5 h-3.5" />}
        {t("vars.cluster.secondary" as any, { n: clusters.length })}
      </summary>
      <div className="space-y-3 p-3 pt-0">
        {clusters.map((c) => (
          <ClusterCard
            key={c.key}
            cluster={c}
            meta={meta}
            pinned={focusedSet?.has(c.key) ?? false}
            onTogglePin={onTogglePin ? () => onTogglePin(c.key) : undefined}
          />
        ))}
      </div>
    </details>
  );
}

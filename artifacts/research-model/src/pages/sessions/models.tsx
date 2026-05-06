import React, { useMemo, useState } from "react";
import { useParams, Link } from "wouter";
import dagre from "@dagrejs/dagre";
import {
  useListSessionModels,
  useGenerateModels,
  useSelectModel,
  useGetSessionLearningStats,
  useListSessionVariables,
  useImportLiveModelFromModel,
  getListSessionModelsQueryKey,
  getGetSessionSummaryQueryKey,
  getGetSessionQueryKey,
  getGetSessionLearningStatsQueryKey,
  getListSessionVariablesQueryKey,
  getGetLiveModelQueryKey,
} from "@workspace/api-client-react";
import { ModelAssistantChat } from "@/components/model-assistant-chat";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Share2, Sparkles, CheckCircle, ArrowRight, BookOpen, Wand2, GitBranch } from "lucide-react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";

const TYPE_COLORS: Record<string, string> = {
  independent: "#2563eb",
  mediator: "#d97706",
  moderator: "#7c3aed",
  dependent: "#16a34a",
};

const REL_STYLE: Record<string, { dash?: string; color?: string }> = {
  positive: {},
  negative: { color: "#dc2626" },
  moderates: { dash: "5 4", color: "#7c3aed" },
  mediates: {},
};

function ModelGraph({ nodes, edges, paperTagById, edgeHTagByKey }: {
  nodes: Array<{ variableId: number; variableName: string; type: string; paperId: number }>;
  edges: Array<{ fromVariableId: number; toVariableId: number; relationship: string; evidencePaperId: number }>;
  paperTagById: Map<number, string>;
  edgeHTagByKey: Map<string, string>;
}) {
  const layout = useMemo(() => {
    if (!nodes.length) return null;
    const NODE_W = 160;
    const NODE_H = 56;
    const PAD = 24;

    // Group multiple edges between the same (from,to) so dagre treats them as one path.
    const edgeGroups = new Map<string, typeof edges>();
    edges.forEach((e) => {
      const k = `${e.fromVariableId}->${e.toVariableId}`;
      if (!edgeGroups.has(k)) edgeGroups.set(k, []);
      edgeGroups.get(k)!.push(e);
    });

    const typeRank: Record<string, number> = { independent: 0, mediator: 1, moderator: 2, dependent: 3 };
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 36, ranksep: 90, marginx: PAD, marginy: PAD, ranker: "network-simplex" });
    g.setDefaultEdgeLabel(() => ({}));

    for (const n of nodes) {
      g.setNode(String(n.variableId), { width: NODE_W, height: NODE_H, _node: n, rank: typeRank[n.type] });
    }
    for (const [k, group] of edgeGroups) {
      const [from, to] = k.split("->");
      g.setEdge(from, to, { _group: group, weight: group[0].relationship === "moderates" ? 1 : 3 });
    }

    dagre.layout(g);

    const { width, height } = g.graph() as { width: number; height: number };
    const positionedNodes = nodes.map((n) => {
      const dn = g.node(String(n.variableId)) as { x: number; y: number } | undefined;
      return dn ? { ...n, x: dn.x, y: dn.y, w: NODE_W, h: NODE_H } : null;
    }).filter((x): x is NonNullable<typeof x> => !!x);

    const positionedEdges = [...edgeGroups.entries()].map(([k, group]) => {
      const [from, to] = k.split("->");
      const de = g.edge(from, to) as { points: Array<{ x: number; y: number }> } | undefined;
      if (!de || !de.points || de.points.length < 2) return null;
      return { key: k, group, points: de.points };
    }).filter((x): x is NonNullable<typeof x> => !!x);

    return { width, height, nodes: positionedNodes, edges: positionedEdges };
  }, [nodes, edges]);

  if (!layout) return null;
  const { width, height } = layout;

  // Build a smooth Catmull-Rom-ish path through the dagre points (curve avoids straight overlaps).
  const pathFromPoints = (pts: Array<{ x: number; y: number }>) => {
    if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const c = pts[i];
      const n = pts[i + 1];
      const midX = (c.x + n.x) / 2;
      const midY = (c.y + n.y) / 2;
      d += ` Q ${c.x} ${c.y} ${midX} ${midY}`;
    }
    const last = pts[pts.length - 1];
    d += ` T ${last.x} ${last.y}`;
    return d;
  };

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} className="overflow-visible" style={{ minHeight: height }} preserveAspectRatio="xMidYMid meet">
      <defs>
        <marker id="arr-default" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0,0 L0,6 L8,3 z" fill="#444" opacity={0.7} />
        </marker>
        <marker id="arr-neg" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0,0 L0,6 L8,3 z" fill="#dc2626" opacity={0.85} />
        </marker>
        <marker id="arr-mod" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0,0 L0,6 L8,3 z" fill="#7c3aed" opacity={0.85} />
        </marker>
      </defs>

      {layout.edges.map(({ key, group, points }) => {
        const rel = group[0].relationship;
        const style = REL_STYLE[rel] ?? {};
        const stroke = style.color ?? "#444";
        const dash = style.dash;
        const marker = rel === "negative" ? "url(#arr-neg)" : rel === "moderates" ? "url(#arr-mod)" : "url(#arr-default)";
        const d = pathFromPoints(points);

        // Midpoint for label placement (use middle dagre point or interpolated).
        const midIdx = Math.floor(points.length / 2);
        const mid = points[midIdx];
        const before = points[Math.max(0, midIdx - 1)];
        const dxL = mid.x - before.x;
        const dyL = mid.y - before.y;
        const lenL = Math.max(1, Math.hypot(dxL, dyL));
        const perpX = -dyL / lenL;
        const perpY = dxL / lenL;

        return (
          <g key={key}>
            <path d={d} fill="none" stroke={stroke} strokeOpacity={0.55} strokeWidth={1.8} strokeDasharray={dash} markerEnd={marker} />
            {group.map((edge, gi) => {
              const hTag = edgeHTagByKey.get(`${edge.fromVariableId}->${edge.toVariableId}#${gi}`);
              if (!hTag) return null;
              // Stack labels perpendicular to the curve at its midpoint.
              const offset = 14 + gi * 18;
              const lx = mid.x + perpX * offset;
              const ly = mid.y + perpY * offset;
              return (
                <g key={gi} transform={`translate(${lx - 16}, ${ly - 8})`}>
                  <rect width={32} height={16} rx={3} fill="white" stroke="#7c3aed" strokeOpacity={0.55} strokeWidth={0.9} />
                  <text x={16} y={11.5} textAnchor="middle" fontSize={10} fontWeight={700} fill="#6d28d9">{hTag}</text>
                </g>
              );
            })}
          </g>
        );
      })}

      {layout.nodes.map((node) => {
        const color = TYPE_COLORS[node.type] ?? "#888";
        const tag = paperTagById.get(node.paperId);
        const maxChars = 20;
        const label = node.variableName.length > maxChars ? node.variableName.slice(0, maxChars - 1) + "…" : node.variableName;
        return (
          <g key={node.variableId} transform={`translate(${node.x - node.w / 2}, ${node.y - node.h / 2})`}>
            <rect width={node.w} height={node.h} rx={8} fill={color} fillOpacity={0.12} stroke={color} strokeOpacity={0.55} strokeWidth={1.6} />
            <text x={node.w / 2} y={node.h / 2 - 1} textAnchor="middle" fontSize={11} fontWeight={600} fill={color}>
              {label}
            </text>
            {tag && (
              <g transform={`translate(${node.w / 2 - 16}, ${node.h - 14})`}>
                <rect width={32} height={12} rx={2} fill={color} fillOpacity={0.95} />
                <text x={16} y={9} textAnchor="middle" fontSize={8} fontWeight={700} fill="white">{tag}</text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

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

  const [userPrompt, setUserPrompt] = useState("");
  const [numModels, setNumModels] = useState(3);
  const [focusVariableIds, setFocusVariableIds] = useState<number[]>([]);

  const variableNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const v of variables ?? []) m.set(v.id, v.name);
    return m;
  }, [variables]);

  const handleApplySuggestion = (s: { userPrompt: string; focusVariableIds: number[] }) => {
    setUserPrompt(s.userPrompt);
    setFocusVariableIds(s.focusVariableIds);
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
      onError: () => {
        toast({ title: t("models.toast.failed" as any), description: t("models.toast.failedDesc" as any), variant: "destructive" });
      },
    });
  };

  const handleGenerate = () => {
    generateModels.mutate({
      id: sessionId,
      data: {
        userPrompt: userPrompt.trim() || undefined,
        numModels,
        focusVariableIds: focusVariableIds.length ? focusVariableIds : undefined,
      },
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
      onError: () => {
        toast({
          title: t("models.toast.failed" as any),
          description: t("models.toast.failedDesc" as any),
          variant: "destructive",
        });
      },
    });
  };

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
    selectModel.mutate({ id: modelId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSessionModelsQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
        toast({
          title: t("models.toast.selected" as any),
          description: t("models.toast.selectedDesc" as any, { name }),
        });
      },
    });
  };

  const learnedRounds = (learningStats?.withSelections ?? 0) + (learningStats?.withEdits ?? 0);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <p className="text-sm text-muted-foreground max-w-2xl">{t("models.intro" as any)}</p>
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
      </div>

      {/* AI assistant chat */}
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
            onClick={handleGenerate}
            disabled={generateModels.isPending}
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
          <p className="text-sm text-muted-foreground">{t("models.empty.body" as any)}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6">
          {models.map((model) => (
            <div key={model.id} data-testid={`card-model-${model.id}`} className={`bg-card border rounded-xl p-6 transition-all ${model.selected ? "border-primary shadow-md" : "border-border hover:border-primary/40"}`}>
              <div className="flex items-start justify-between gap-4 mb-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    {model.selected && <CheckCircle className="w-4 h-4 text-primary shrink-0" />}
                    <h3 className="text-base font-semibold text-foreground">{model.name}</h3>
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
                const paperTagById = new Map<number, string>();
                paperOrder.forEach((pid, i) => paperTagById.set(pid, `P${i + 1}`));
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
                // Build H-tags for edges (H1, H2, …) in declared order, keyed by
                // `${from}->${to}#${gi}` so multiple parallel edges each get their own H#.
                const edgeHTagByKey = new Map<string, string>();
                const groupCounter = new Map<string, number>();
                const hLegend: Array<{ tag: string; from: string; to: string; rel: string; paperTag: string }> = [];
                edges.forEach((e, i) => {
                  const k = `${e.fromVariableId}->${e.toVariableId}`;
                  const gi = groupCounter.get(k) ?? 0;
                  groupCounter.set(k, gi + 1);
                  const tag = `H${i + 1}`;
                  edgeHTagByKey.set(`${k}#${gi}`, tag);
                  const fromName = nodes.find((n) => n.variableId === e.fromVariableId)?.variableName ?? `#${e.fromVariableId}`;
                  const toName = nodes.find((n) => n.variableId === e.toVariableId)?.variableName ?? `#${e.toVariableId}`;
                  hLegend.push({ tag, from: fromName, to: toName, rel: e.relationship, paperTag: paperTagById.get(e.evidencePaperId) ?? "" });
                });
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
          ))}
        </div>
      )}
    </div>
  );
}

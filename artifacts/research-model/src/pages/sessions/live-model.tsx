import React, { useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import dagre from "@dagrejs/dagre";
import {
  useGetLiveModel,
  useAddLiveModelNode,
  useRemoveLiveModelNode,
  useAddLiveModelEdge,
  useRemoveLiveModelEdge,
  useListSessionVariables,
  getGetLiveModelQueryKey,
  getListSessionVariablesQueryKey,
  type LiveModelDetail,
  type LiveModelNodeOut,
  type LiveModelEdgeOut,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X, AlertTriangle, BookOpen, ArrowRight, Sparkles, GitBranch } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";

const TYPE_COLORS: Record<string, string> = {
  independent: "#2563eb",
  mediator: "#d97706",
  moderator: "#7c3aed",
  dependent: "#16a34a",
};

const REL_STYLE: Record<string, { dash?: string; color?: string; label: string }> = {
  positive: { label: "+" },
  negative: { color: "#dc2626", label: "−" },
  moderates: { dash: "5 4", color: "#7c3aed", label: "M" },
  mediates: { label: "→" },
};

function LiveGraph({ nodes, edges }: { nodes: LiveModelNodeOut[]; edges: LiveModelEdgeOut[] }) {
  const layout = useMemo(() => {
    if (!nodes.length) return null;
    const NODE_W = 160;
    const NODE_H = 56;
    const PAD = 24;

    const edgeGroups = new Map<string, LiveModelEdgeOut[]>();
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
      g.setNode(String(n.variableId), { width: NODE_W, height: NODE_H, _node: n, rank: typeRank[n.variableType] ?? 0 });
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

    return { width: width || 600, height: height || 200, positionedNodes, positionedEdges };
  }, [nodes, edges]);

  if (!layout) return null;

  return (
    <svg viewBox={`0 0 ${layout.width} ${layout.height}`} className="w-full h-auto" style={{ maxHeight: 480 }}>
      <defs>
        <marker id="lm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#475569" />
        </marker>
        <marker id="lm-arrow-warn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#f59e0b" />
        </marker>
      </defs>
      {layout.positionedEdges.map(({ key, group, points }) => {
        const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
        return group.map((e, i) => {
          const style = REL_STYLE[e.relationship] ?? { label: "?" };
          const color = e.hasProvenance ? (style.color ?? "#475569") : "#f59e0b";
          const offset = (i - (group.length - 1) / 2) * 4;
          return (
            <g key={`${key}-${e.id}`}>
              <path d={path} fill="none" stroke={color} strokeWidth={2} strokeDasharray={style.dash}
                markerEnd={`url(#${e.hasProvenance ? "lm-arrow" : "lm-arrow-warn"})`}
                transform={`translate(0,${offset})`} opacity={0.85} />
            </g>
          );
        });
      })}
      {layout.positionedNodes.map((n) => (
        <g key={n.variableId} transform={`translate(${n.x - n.w / 2},${n.y - n.h / 2})`}>
          <rect width={n.w} height={n.h} rx={8} fill="white" stroke={TYPE_COLORS[n.variableType] ?? "#64748b"} strokeWidth={2} />
          <text x={n.w / 2} y={n.h / 2 + 4} textAnchor="middle" fontSize={12} fontWeight={600} fill="#0f172a">
            {n.variableName.length > 20 ? `${n.variableName.slice(0, 18)}…` : n.variableName}
          </text>
        </g>
      ))}
    </svg>
  );
}

export default function LiveModelPage({ params }: { params?: { id: string } }) {
  const { t } = useT();
  const routeParams = useParams<{ id: string }>();
  const sessionId = parseInt(params?.id ?? routeParams?.id ?? "0", 10);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: detail, isLoading, isError } = useGetLiveModel(sessionId, {
    query: { enabled: !!sessionId, queryKey: getGetLiveModelQueryKey(sessionId) },
  });
  const { data: variables } = useListSessionVariables(sessionId, {
    query: { enabled: !!sessionId, queryKey: getListSessionVariablesQueryKey(sessionId) },
  });

  const addNode = useAddLiveModelNode();
  const removeNode = useRemoveLiveModelNode();
  const addEdge = useAddLiveModelEdge();
  const removeEdge = useRemoveLiveModelEdge();

  const [isAddingEdge, setIsAddingEdge] = useState(false);
  const [edgeFrom, setEdgeFrom] = useState<number | "">("");
  const [edgeTo, setEdgeTo] = useState<number | "">("");
  const [edgeRel, setEdgeRel] = useState<"positive" | "negative" | "mediates" | "moderates">("positive");

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getGetLiveModelQueryKey(sessionId) });

  const includedVariableIds = useMemo(
    () => new Set((detail?.nodes ?? []).map((n) => n.variableId)),
    [detail?.nodes],
  );

  const handleAddVar = (variableId: number) => {
    addNode.mutate(
      { id: sessionId, data: { variableId, userAdded: true } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: t("live.toast.added" as any) });
        },
        onError: () => toast({ title: t("live.toast.failed" as any), variant: "destructive" }),
      },
    );
  };

  const handleRemoveNode = (nodeId: number, name: string) => {
    removeNode.mutate(
      { id: sessionId, nodeId },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: t("live.toast.removed" as any, { name }) });
        },
        onError: () => toast({ title: t("live.toast.failed" as any), variant: "destructive" }),
      },
    );
  };

  const handleRemoveEdge = (edgeId: number) => {
    removeEdge.mutate(
      { id: sessionId, edgeId },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: t("live.toast.edgeRemoved" as any) });
        },
        onError: () => toast({ title: t("live.toast.failed" as any), variant: "destructive" }),
      },
    );
  };

  const handleSubmitEdge = () => {
    if (edgeFrom === "" || edgeTo === "" || edgeFrom === edgeTo) return;
    addEdge.mutate(
      {
        id: sessionId,
        data: {
          fromVariableId: Number(edgeFrom),
          toVariableId: Number(edgeTo),
          relationship: edgeRel,
          userAdded: true, // manual edges flagged for ⚠️ until user adds provenance later (P2)
        },
      },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: t("live.toast.edgeAdded" as any) });
          setIsAddingEdge(false);
          setEdgeFrom(""); setEdgeTo(""); setEdgeRel("positive");
        },
        onError: () => toast({ title: t("live.toast.failed" as any), variant: "destructive" }),
      },
    );
  };

  if (isError) {
    return (
      <div className="bg-destructive/10 text-destructive p-6 rounded-md border border-destructive/20 text-center py-12">
        <p className="text-sm">{t("live.toast.failed" as any)}</p>
      </div>
    );
  }
  if (isLoading || !detail) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const nodes = detail.nodes;
  const edges = detail.edges;
  const isEmpty = nodes.length === 0 && edges.length === 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-serif font-bold text-foreground flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-primary" />
            {t("live.title" as any)}
          </h2>
          <p className="text-sm text-muted-foreground max-w-2xl mt-1">{t("live.intro" as any)}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground bg-secondary px-2.5 py-1 rounded-full">
            {t("live.stats" as any, { vars: nodes.length, edges: edges.length })}
          </span>
          {detail.unsupportedEdgeCount > 0 && (
            <span
              data-testid="badge-unsupported-edges"
              title={t("live.unsupported.tip" as any)}
              className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-full"
            >
              <AlertTriangle className="w-3 h-3" />
              {t("live.unsupported.badge" as any, { n: detail.unsupportedEdgeCount })}
            </span>
          )}
        </div>
      </div>

      {/* Empty state */}
      {isEmpty && (
        <div data-testid="live-empty" className="bg-card border border-dashed border-border rounded-lg p-12 text-center">
          <Sparkles className="w-10 h-10 text-primary/60 mx-auto mb-3" />
          <h3 className="font-semibold text-foreground mb-2">{t("live.empty.title" as any)}</h3>
          <p className="text-sm text-muted-foreground mb-5 max-w-md mx-auto">{t("live.empty.body" as any)}</p>
          <Link
            href={`/sessions/${sessionId}/models`}
            className="inline-flex items-center gap-2 rounded-md text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-5 transition-colors"
          >
            {t("live.empty.cta" as any)} <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      )}

      {/* Main layout */}
      {!isEmpty && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6">
          {/* Graph + edges */}
          <div className="space-y-4 min-w-0">
            <div className="bg-card border border-border rounded-lg p-4">
              <LiveGraph nodes={nodes} edges={edges} />
            </div>

            {/* Edge list */}
            <div className="bg-card border border-border rounded-lg">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-foreground">{t("live.edges.title" as any)}</h3>
                <button
                  data-testid="button-add-edge"
                  onClick={() => setIsAddingEdge((v) => !v)}
                  className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium h-7 px-2.5 bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {t("live.edges.add" as any)}
                </button>
              </div>

              {isAddingEdge && (
                <div data-testid="edge-form" className="px-4 py-3 border-b border-border bg-muted/30 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      data-testid="select-edge-from"
                      value={edgeFrom}
                      onChange={(e) => setEdgeFrom(e.target.value === "" ? "" : Number(e.target.value))}
                      className="text-xs rounded-md border border-input bg-background px-2 py-1.5 max-w-[180px]"
                    >
                      <option value="">{t("live.edges.fromPlaceholder" as any)}</option>
                      {nodes.map((n) => (
                        <option key={n.variableId} value={n.variableId}>{n.variableName}</option>
                      ))}
                    </select>
                    <select
                      data-testid="select-edge-rel"
                      value={edgeRel}
                      onChange={(e) => setEdgeRel(e.target.value as typeof edgeRel)}
                      className="text-xs rounded-md border border-input bg-background px-2 py-1.5"
                    >
                      <option value="positive">+ positive</option>
                      <option value="negative">− negative</option>
                      <option value="mediates">→ mediates</option>
                      <option value="moderates">M moderates</option>
                    </select>
                    <select
                      data-testid="select-edge-to"
                      value={edgeTo}
                      onChange={(e) => setEdgeTo(e.target.value === "" ? "" : Number(e.target.value))}
                      className="text-xs rounded-md border border-input bg-background px-2 py-1.5 max-w-[180px]"
                    >
                      <option value="">{t("live.edges.toPlaceholder" as any)}</option>
                      {nodes.filter((n) => n.variableId !== edgeFrom).map((n) => (
                        <option key={n.variableId} value={n.variableId}>{n.variableName}</option>
                      ))}
                    </select>
                    <button
                      data-testid="button-submit-edge"
                      onClick={handleSubmitEdge}
                      disabled={addEdge.isPending || edgeFrom === "" || edgeTo === "" || edgeFrom === edgeTo}
                      className="inline-flex items-center gap-1 rounded-md text-xs font-semibold h-7 px-3 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      {addEdge.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                      {t("common.add" as any)}
                    </button>
                    <button
                      onClick={() => setIsAddingEdge(false)}
                      className="text-xs text-muted-foreground hover:text-foreground px-2"
                    >
                      {t("common.cancel" as any)}
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground flex items-start gap-1">
                    <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5 text-amber-600" />
                    {t("live.edges.userAddedHint" as any)}
                  </p>
                </div>
              )}

              {edges.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">{t("live.edges.empty" as any)}</div>
              ) : (
                <ul className="divide-y divide-border">
                  {edges.map((e) => (
                    <li key={e.id} data-testid={`edge-row-${e.id}`} className="flex items-start gap-3 px-4 py-3 group">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="font-medium text-foreground">{e.fromVariableName}</span>
                          <span className="text-muted-foreground">{REL_STYLE[e.relationship]?.label ?? e.relationship}</span>
                          <span className="font-medium text-foreground">{e.toVariableName}</span>
                          {!e.hasProvenance && (
                            <span
                              title={t("live.edge.unsupported.tip" as any)}
                              className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded"
                            >
                              <AlertTriangle className="w-2.5 h-2.5" />
                              {t("live.edge.unsupported.badge" as any)}
                            </span>
                          )}
                        </div>
                        {e.hasProvenance && e.provenanceCitationText && (
                          <div className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
                            <BookOpen className="w-3 h-3 shrink-0 mt-0.5 text-primary/60" />
                            <span className="line-clamp-2">
                              {e.provenancePaperTitle ? <span className="font-medium">{e.provenancePaperTitle}: </span> : null}
                              "{e.provenanceCitationText}"
                            </span>
                          </div>
                        )}
                      </div>
                      <button
                        data-testid={`button-remove-edge-${e.id}`}
                        onClick={() => handleRemoveEdge(e.id)}
                        disabled={removeEdge.isPending}
                        className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
                        aria-label={t("common.remove" as any)}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Variable pool sidebar */}
          <aside className="bg-card border border-border rounded-lg flex flex-col self-start">
            <div className="px-4 py-3 border-b border-border">
              <h3 className="text-sm font-semibold text-foreground">{t("live.pool.title" as any)}</h3>
              <p className="text-[11px] text-muted-foreground mt-0.5">{t("live.pool.hint" as any)}</p>
            </div>
            {(!variables || variables.length === 0) ? (
              <div className="p-4 text-center text-xs text-muted-foreground">
                <Link href={`/sessions/${sessionId}/variables`} className="text-primary hover:underline">
                  {t("live.pool.noVarsLink" as any)}
                </Link>
              </div>
            ) : (
              <ul className="divide-y divide-border max-h-[480px] overflow-y-auto">
                {variables.map((v) => {
                  const included = includedVariableIds.has(v.id);
                  const node = (detail.nodes ?? []).find((n) => n.variableId === v.id);
                  return (
                    <li key={v.id} className="flex items-center gap-2 px-3 py-2.5">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ background: TYPE_COLORS[v.type] ?? "#64748b" }}
                        title={v.type}
                      />
                      <span className="flex-1 text-xs text-foreground truncate" title={v.name}>{v.name}</span>
                      {included ? (
                        <button
                          data-testid={`button-remove-var-${v.id}`}
                          onClick={() => node && handleRemoveNode(node.id, v.name)}
                          disabled={removeNode.isPending}
                          className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                          aria-label={t("common.remove" as any)}
                          title={t("live.pool.remove" as any)}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      ) : (
                        <button
                          data-testid={`button-add-var-${v.id}`}
                          onClick={() => handleAddVar(v.id)}
                          disabled={addNode.isPending}
                          className="p-1 rounded text-primary hover:bg-primary/10 transition-colors"
                          aria-label={t("common.add" as any)}
                          title={t("live.pool.add" as any)}
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import {
  useGetLiveModel,
  useAddLiveModelNode,
  useRemoveLiveModelNode,
  useUpdateLiveModelNodePosition,
  useAddLiveModelEdge,
  useRemoveLiveModelEdge,
  useListSessionVariables,
  getGetLiveModelQueryKey,
  getListSessionVariablesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X, AlertTriangle, BookOpen, ArrowRight, Sparkles, GitBranch, Search } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";
import { EditableModelGraph, type CanvasNode, type CanvasEdge, type VariablePoolEntry } from "@/components/editable-model-graph";
import { EvidenceMatchDialog } from "@/components/evidence-match-dialog";

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

  const [evidenceOpen, setEvidenceOpen] = useState(false);
  // When the user clicks "Find sources" on a specific edge row we pass these
  // hints to the dialog so it auto-runs the search and scrolls to that edge.
  const [evidenceFocus, setEvidenceFocus] = useState<{ edgeKey: string; from: string; to: string } | null>(null);
  const addNode = useAddLiveModelNode();
  const removeNode = useRemoveLiveModelNode();
  const addEdge = useAddLiveModelEdge();
  const removeEdge = useRemoveLiveModelEdge();
  const updateNodePosition = useUpdateLiveModelNodePosition();

  // Debounce per-node position saves so a fast drag fires exactly one PATCH per node.
  const posTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  useEffect(() => () => { posTimers.current.forEach((t) => clearTimeout(t)); }, []);

  // Pending edge from canvas drag-to-connect: shows a tiny relationship picker
  // before persisting (LiveModel edges must declare a relationship).
  const [pendingEdge, setPendingEdge] = useState<{ from: number; to: number; rel: "positive" | "negative" | "mediates" | "moderates" } | null>(null);

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

  // Canvas → server: drag-to-reposition node. Debounced so we only fire one
  // PATCH per node after the cursor settles (~400ms).
  const handleCanvasNodeMove = (canvasNodeId: string, _variableId: number, x: number, y: number) => {
    const nodeId = parseInt(canvasNodeId, 10);
    if (!Number.isFinite(nodeId)) return;
    const existing = posTimers.current.get(nodeId);
    if (existing) clearTimeout(existing);
    posTimers.current.set(
      nodeId,
      setTimeout(() => {
        posTimers.current.delete(nodeId);
        updateNodePosition.mutate(
          { id: sessionId, nodeId, data: { positionX: x, positionY: y } },
          {
            onSuccess: () => invalidate(),
            onError: () => toast({ title: t("canvas.toast.posSaveFailed" as any), variant: "destructive" }),
          },
        );
      }, 400),
    );
  };

  const handleCanvasNodeDelete = (canvasNodeId: string, variableId: number) => {
    const nodeId = parseInt(canvasNodeId, 10);
    const v = (variables ?? []).find((x) => x.id === variableId);
    handleRemoveNode(nodeId, v?.name ?? "");
  };

  // Drag-to-create on the canvas → open a small picker for the relationship.
  // We default to "positive" + userAdded:true (will show the amber "未引用" badge
  // until the user attaches provenance via the form below).
  const handleCanvasEdgeCreate = (fromVariableId: number, toVariableId: number) => {
    if (fromVariableId === toVariableId) return;
    setPendingEdge({ from: fromVariableId, to: toVariableId, rel: "positive" });
  };

  const confirmPendingEdge = () => {
    if (!pendingEdge) return;
    addEdge.mutate(
      {
        id: sessionId,
        data: {
          fromVariableId: pendingEdge.from,
          toVariableId: pendingEdge.to,
          relationship: pendingEdge.rel,
          userAdded: true,
        },
      },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: t("canvas.toast.edgeAdded" as any) });
          setPendingEdge(null);
        },
        onError: () => toast({ title: t("canvas.toast.edgeFailed" as any), variant: "destructive" }),
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

  // Adapter: live-model nodes/edges → canvas shapes.
  const canvasNodes: CanvasNode[] = nodes.map((n) => ({
    id: String(n.id),
    variableId: n.variableId,
    variableName: n.variableName,
    type: n.variableType,
    positionX: n.positionX ?? null,
    positionY: n.positionY ?? null,
  }));
  const canvasEdges: CanvasEdge[] = edges.map((e) => ({
    id: String(e.id),
    fromVariableId: e.fromVariableId,
    toVariableId: e.toVariableId,
    relationship: e.relationship,
    warning: !e.hasProvenance,
  }));
  const variablePool: VariablePoolEntry[] = (variables ?? []).map((v) => ({ variableId: v.id, name: v.name, type: v.type }));

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
          <button
            onClick={() => setEvidenceOpen(true)}
            disabled={isEmpty}
            title={t("evidence.btnTip" as any) as string}
            data-testid="button-evidence-match"
            className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 h-8 px-3 transition-colors disabled:opacity-50"
          >
            <Sparkles className="w-3.5 h-3.5" /> {t("evidence.btn" as any)}
          </button>
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
            <EditableModelGraph
              nodes={canvasNodes}
              edges={canvasEdges}
              variablePool={variablePool}
              height={520}
              onNodeMove={handleCanvasNodeMove}
              onNodeDelete={handleCanvasNodeDelete}
              onEdgeDelete={(edgeId) => handleRemoveEdge(parseInt(edgeId, 10))}
              onEdgeCreate={handleCanvasEdgeCreate}
              onAddVariable={handleAddVar}
            />

            {/* Pending edge picker — choose relationship before persisting */}
            {pendingEdge && (
              <div data-testid="pending-edge-dialog" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-sm p-5 space-y-4">
                  <h3 className="font-semibold text-foreground">{t("canvas.newEdge.title" as any)}</h3>
                  <div className="text-sm text-foreground">
                    <span className="font-medium">{nodes.find((n) => n.variableId === pendingEdge.from)?.variableName}</span>
                    <span className="mx-2 text-muted-foreground">→</span>
                    <span className="font-medium">{nodes.find((n) => n.variableId === pendingEdge.to)?.variableName}</span>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">{t("canvas.newEdge.relLabel" as any)}</label>
                    <select
                      data-testid="pending-edge-rel"
                      value={pendingEdge.rel}
                      onChange={(e) => setPendingEdge((p) => p ? { ...p, rel: e.target.value as typeof p.rel } : p)}
                      className="w-full text-sm rounded-md border border-input bg-background px-3 py-2"
                    >
                      <option value="positive">+ positive</option>
                      <option value="negative">− negative</option>
                      <option value="mediates">→ mediates</option>
                      <option value="moderates">M moderates</option>
                    </select>
                  </div>
                  <p className="text-[11px] text-muted-foreground flex items-start gap-1">
                    <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5 text-amber-600" />
                    {t("live.edges.userAddedHint" as any)}
                  </p>
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setPendingEdge(null)}
                      className="text-xs text-muted-foreground hover:text-foreground px-3 py-1.5"
                    >
                      {t("canvas.newEdge.cancel" as any)}
                    </button>
                    <button
                      type="button"
                      data-testid="pending-edge-confirm"
                      onClick={confirmPendingEdge}
                      disabled={addEdge.isPending}
                      className="inline-flex items-center gap-1.5 rounded-md text-xs font-semibold h-8 px-4 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      {addEdge.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
                      {t("canvas.newEdge.confirm" as any)}
                    </button>
                  </div>
                </div>
              </div>
            )}

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
                            <>
                              <span
                                title={t("live.edge.unsupported.tip" as any)}
                                className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded"
                              >
                                <AlertTriangle className="w-2.5 h-2.5" />
                                {t("live.edge.unsupported.badge" as any)}
                              </span>
                              <button
                                type="button"
                                data-testid={`button-search-evidence-${e.id}`}
                                onClick={() => {
                                  setEvidenceFocus({
                                    edgeKey: `${e.fromVariableId}-${e.toVariableId}-${e.relationship}`,
                                    from: e.fromVariableName,
                                    to: e.toVariableName,
                                  });
                                  setEvidenceOpen(true);
                                }}
                                title={t("live.edge.searchEvidenceTip" as any) as string}
                                className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-1.5 py-0.5 rounded transition-colors"
                              >
                                <Search className="w-2.5 h-2.5" />
                                {t("live.edge.searchEvidence" as any)}
                              </button>
                            </>
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

      <EvidenceMatchDialog
        open={evidenceOpen}
        onClose={() => { setEvidenceOpen(false); setEvidenceFocus(null); }}
        mode="live"
        sessionId={sessionId}
        autoSearch={!!evidenceFocus}
        focusEdgeKey={evidenceFocus?.edgeKey}
        focusEdgeLabel={evidenceFocus ? { from: evidenceFocus.from, to: evidenceFocus.to } : undefined}
      />
    </div>
  );
}

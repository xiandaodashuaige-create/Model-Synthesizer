import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import {
  useGetLiveModel,
  useGetSession,
  useAddLiveModelNode,
  useRemoveLiveModelNode,
  useUpdateLiveModelNodePosition,
  useAddLiveModelEdge,
  useRemoveLiveModelEdge,
  useListSessionVariables,
  useCreateSessionVariable,
  getGetLiveModelQueryKey,
  getGetSessionQueryKey,
  getListSessionVariablesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X, AlertTriangle, BookOpen, ArrowRight, Sparkles, GitBranch, Search, FileDown, FileText, ImageDown, ImageIcon, RotateCcw, Trash2 } from "lucide-react";
import { exportMarkdown, exportDocx } from "@/lib/export-live-model";
import {
  renderModelSvg,
  svgToPngDataUrl,
  downloadDataUrl,
  type ExportNode,
  type ExportEdge,
} from "@/lib/export-live-model-image";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";
import { EditableModelGraph, type CanvasNode, type CanvasEdge, type VariablePoolEntry } from "@/components/editable-model-graph";
import { EvidenceMatchDialog } from "@/components/evidence-match-dialog";
import { ReferenceFigureDialog } from "@/components/reference-figure-dialog";
import dagre from "@dagrejs/dagre";

// Compute the effective on-canvas (x,y) for each live-model node so we can
// number hypotheses (H1, H2…) in the same left-to-right reading order the
// user actually sees. We mirror EditableModelGraph's autoLayout: prefer the
// persisted positionX/Y; otherwise fall back to a dagre LR layout.
function computeNodePositions(
  nodes: Array<{ id: number; variableType: string; positionX: number | null; positionY: number | null }>,
  edges: Array<{ fromVariableId: number; toVariableId: number }>,
  variableIdToNodeId: Map<number, number>,
): Map<number, { x: number; y: number }> {
  const out = new Map<number, { x: number; y: number }>();
  if (nodes.length === 0) return out;
  const NODE_W = 180;
  const NODE_H = 60;
  const hasAnyPersisted = nodes.some((n) => typeof n.positionX === "number" && typeof n.positionY === "number");
  if (hasAnyPersisted) {
    // Use persisted positions where present; for the rest place them in a
    // grid below the bounding box (same fallback as EditableModelGraph).
    const pinned = nodes.filter((n) => typeof n.positionX === "number" && typeof n.positionY === "number");
    const maxY = pinned.reduce((m, n) => Math.max(m, (n.positionY as number) + NODE_H), 0);
    const minX = pinned.reduce((m, n) => Math.min(m, n.positionX as number), Infinity);
    const baseX = Number.isFinite(minX) ? minX : 24;
    let i = 0;
    for (const n of nodes) {
      if (typeof n.positionX === "number" && typeof n.positionY === "number") {
        out.set(n.id, { x: n.positionX, y: n.positionY });
      } else {
        out.set(n.id, { x: baseX + (i % 4) * (NODE_W + 24), y: maxY + 40 + Math.floor(i / 4) * (NODE_H + 24) });
        i++;
      }
    }
    return out;
  }
  const typeRank: Record<string, number> = { independent: 0, mediator: 1, moderator: 2, dependent: 3 };
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 36, ranksep: 110, marginx: 24, marginy: 24, ranker: "network-simplex" });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(String(n.id), { width: NODE_W, height: NODE_H, rank: typeRank[n.variableType] ?? 0 });
  for (const e of edges) {
    const from = variableIdToNodeId.get(e.fromVariableId);
    const to = variableIdToNodeId.get(e.toVariableId);
    if (from != null && to != null) g.setEdge(String(from), String(to));
  }
  dagre.layout(g);
  for (const n of nodes) {
    const dn = g.node(String(n.id)) as { x: number; y: number } | undefined;
    if (dn) out.set(n.id, { x: dn.x - NODE_W / 2, y: dn.y - NODE_H / 2 });
    else out.set(n.id, { x: 0, y: 0 });
  }
  return out;
}

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
  // For export filenames + document title — Research Model Builder treats the
  // session's display name as the title of the exported model document.
  const { data: sessionData } = useGetSession(sessionId, {
    query: { enabled: !!sessionId, queryKey: getGetSessionQueryKey(sessionId) },
  });
  const [isExportingDocx, setIsExportingDocx] = useState(false);
  const [isExportingPng, setIsExportingPng] = useState(false);

  // ---------------------------------------------------------------------------
  // Edge recycle bin (per-session, localStorage-persisted).
  //
  // Two intertwined concerns:
  //  (1) Sync — the user reported that deleting an edge from the bottom list
  //      sometimes "doesn't update" the canvas. The data flow is correct
  //      (delete -> invalidate -> refetch -> re-render) but visually there's a
  //      brief gap. We close that gap with an OPTIMISTIC cache update so both
  //      the canvas and the list update the same frame the user clicks ×.
  //  (2) Recovery — accidental deletes happen, and AI-generated edges carry
  //      provenance the user does NOT want to lose. We snapshot every removed
  //      edge into a per-session trash bin so the user can restore it.
  //      Restore re-creates via the existing addEdge endpoint (provenance
  //      metadata is currently lost on restore — surfaced in the panel hint).
  // ---------------------------------------------------------------------------
  type TrashedEdge = {
    trashId: string;
    fromVariableId: number;
    fromVariableName: string;
    toVariableId: number;
    toVariableName: string;
    relationship: "positive" | "negative" | "mediates" | "moderates";
    moderatesEdgeId: number | null;
    hadProvenance: boolean;
    deletedAt: number;
  };
  const TRASH_CAP = 20;
  const trashKey = sessionId ? `liveModelTrash:${sessionId}` : "";
  const [trash, setTrash] = useState<TrashedEdge[]>(() => {
    if (typeof window === "undefined" || !trashKey) return [];
    try {
      const raw = window.localStorage.getItem(trashKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as TrashedEdge[]) : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    if (typeof window === "undefined" || !trashKey) return;
    try {
      window.localStorage.setItem(trashKey, JSON.stringify(trash));
    } catch {
      // Quota exceeded or storage disabled — silently ignore; the bin still
      // works for the current session, just doesn't survive a refresh.
    }
  }, [trash, trashKey]);
  const pruneTrash = (next: TrashedEdge[]) => next.slice(0, TRASH_CAP);
  // PNG export — built from the live-model data, NOT screenshotted from the
  // DOM. See `lib/export-live-model-image.ts` for the rationale (html-to-image
  // kept failing on Replit due to cross-origin stylesheet walks and 520s on
  // proxied font fetches; the data-driven SVG path is bulletproof).
  const handleExportPng = async () => {
    if (!detail || isExportingPng) return;
    const liveNodes = detail.nodes ?? [];
    const liveEdges = detail.edges ?? [];
    if (liveNodes.length === 0 && liveEdges.length === 0) {
      toast({ title: t("live.export.empty" as any), variant: "destructive" });
      return;
    }

    setIsExportingPng(true);
    try {
      const exportNodes: ExportNode[] = liveNodes.map((n) => ({
        id: n.id,
        variableId: n.variableId,
        variableName: n.variableName,
        variableType: n.variableType,
        positionX: n.positionX ?? null,
        positionY: n.positionY ?? null,
      }));
      const exportEdges: ExportEdge[] = liveEdges.map((e) => ({
        id: e.id,
        fromVariableId: e.fromVariableId,
        toVariableId: e.toVariableId,
        relationship: e.relationship,
        moderatesEdgeId: e.moderatesEdgeId ?? null,
        hTag: hTagByEdgeId.get(e.id),
      }));
      const safeName = (sessionData?.name ?? "research-model")
        .replace(/[\\/:*?"<>|]+/g, "_")
        .trim() || "research-model";
      const svg = renderModelSvg(exportNodes, exportEdges, { title: safeName });
      const dataUrl = await svgToPngDataUrl(svg, 2);
      const filename = `${safeName}.png`;
      downloadDataUrl(dataUrl, filename);
      toast({ title: t("live.export.toastDone" as any, { filename }) });
    } catch (err) {
      // We rendered the SVG ourselves so failures here are extremely rare —
      // typically only an OOM on huge models. Surface the message in dev.
      console.error("[export-png] failed:", err);
      toast({ title: t("live.export.toastFailed" as any), variant: "destructive" });
    } finally {
      setIsExportingPng(false);
    }
  };
  const handleExportMd = () => {
    if (!detail) return;
    try {
      const filename = exportMarkdown(detail, sessionData?.name ?? "research-model");
      toast({ title: t("live.export.toastDone" as any, { filename }) });
    } catch {
      toast({ title: t("live.export.toastFailed" as any), variant: "destructive" });
    }
  };
  const handleExportDocx = async () => {
    if (!detail || isExportingDocx) return;
    setIsExportingDocx(true);
    try {
      const filename = await exportDocx(detail, sessionData?.name ?? "research-model");
      toast({ title: t("live.export.toastDone" as any, { filename }) });
    } catch {
      toast({ title: t("live.export.toastFailed" as any), variant: "destructive" });
    } finally {
      setIsExportingDocx(false);
    }
  };

  const [evidenceOpen, setEvidenceOpen] = useState(false);
  // When the user clicks "Find sources" on a specific edge row we pass these
  // hints to the dialog so it auto-runs the search and scrolls to that edge.
  const [evidenceFocus, setEvidenceFocus] = useState<{ edgeKey: string; from: string; to: string } | null>(null);
  // Per-edge "find reference figure" dialog state — visual evidence for an
  // unsupported edge. Pre-fills a query like "X positive effect Y conceptual
  // model" so the user can see published model figures showing this same
  // construct relationship even when no quotable citation exists.
  const [figureFocus, setFigureFocus] = useState<{ from: string; to: string; relationship: string } | null>(null);
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
  // `moderatesEdgeId` is set when the user dropped the arrow on an EXISTING
  // edge between two other variables — locks rel to "moderates" and makes the
  // arrow tip render at that edge's midpoint.
  const [pendingEdge, setPendingEdge] = useState<{
    from: number;
    to: number;
    rel: "positive" | "negative" | "mediates" | "moderates";
    moderatesEdgeId?: number;
  } | null>(null);

  // Variable-pool keyword filter. Matches against name + type + definition
  // (case-insensitive, whitespace-trimmed) so users can find a construct fast
  // even when the pool has 100+ entries after a multi-paper extraction.
  const [poolQuery, setPoolQuery] = useState("");
  // Inline "+ 自定义新变量" form state (lives in the variable pool sidebar).
  // The user types a name + picks a type, the new variable is POSTed to
  // /sessions/:id/variables (sentinel-paper backed) and immediately added to
  // the live canvas via handleAddVar. Closed by default to keep the sidebar
  // compact.
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customType, setCustomType] = useState<"independent" | "mediator" | "moderator" | "dependent">("independent");
  const [customDef, setCustomDef] = useState("");
  const createCustomVar = useCreateSessionVariable();
  // P3: cross-highlight between the edge list and the canvas. Hovering a row
  // sets the canvas edge's stroke to a thicker primary tint (and vice-versa).
  // String-typed because RF edge ids are strings even though our DB ids are numbers.
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
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

  const handleCreateCustomVar = () => {
    const name = customName.trim();
    if (name.length === 0 || name.length > 200) {
      toast({ title: t("canvas.pool.custom.invalidName" as any), variant: "destructive" });
      return;
    }
    createCustomVar.mutate(
      {
        id: sessionId,
        data: {
          name,
          type: customType,
          ...(customDef.trim().length > 0 ? { definition: customDef.trim().slice(0, 150) } : {}),
        },
      },
      {
        onSuccess: (created: { id: number; name: string }) => {
          // Refresh the variable list so the new row shows in the pool, then
          // immediately drop it onto the canvas — that's almost always why the
          // user opened the form.
          queryClient.invalidateQueries({ queryKey: getListSessionVariablesQueryKey(sessionId) });
          toast({ title: t("canvas.pool.custom.toastDone" as any, { name: created.name }) });
          setCustomName("");
          setCustomDef("");
          setCustomOpen(false);
          handleAddVar(created.id);
        },
        onError: () => {
          toast({ title: t("canvas.pool.custom.toastFailed" as any), variant: "destructive" });
        },
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
    const liveKey = getGetLiveModelQueryKey(sessionId);
    // Snapshot current detail BEFORE we mutate so we can (a) record the edge
    // into the trash bin with full context (names + provenance flag) and
    // (b) roll the cache back if the server rejects the delete.
    const prev = queryClient.getQueryData<typeof detail>(liveKey);
    const target = prev?.edges?.find((e) => e.id === edgeId);
    if (!target || !prev) {
      // Edge no longer in cache — fall back to plain mutate without trash.
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
      return;
    }
    // OPTIMISTIC: drop the edge from the live-model query cache immediately
    // so canvas + list both update on the same frame as the click.
    queryClient.setQueryData(liveKey, {
      ...prev,
      edges: prev.edges.filter((e) => e.id !== edgeId),
    });
    const trashEntry: TrashedEdge = {
      trashId: `${edgeId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fromVariableId: target.fromVariableId,
      fromVariableName: target.fromVariableName,
      toVariableId: target.toVariableId,
      toVariableName: target.toVariableName,
      relationship: target.relationship as TrashedEdge["relationship"],
      moderatesEdgeId: target.moderatesEdgeId ?? null,
      hadProvenance: !!target.hasProvenance,
      deletedAt: Date.now(),
    };
    setTrash((cur) => pruneTrash([trashEntry, ...cur]));
    removeEdge.mutate(
      { id: sessionId, edgeId },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: t("live.toast.edgeRemoved" as any) });
        },
        onError: () => {
          // Roll back: restore the cache and pull this entry back out of trash.
          queryClient.setQueryData(liveKey, prev);
          setTrash((cur) => cur.filter((tr) => tr.trashId !== trashEntry.trashId));
          toast({ title: t("live.toast.failed" as any), variant: "destructive" });
        },
      },
    );
  };

  // Restore an edge from the trash bin: re-create via addEdge. Marks userAdded
  // so the server accepts it without provenance (provenance is genuinely lost).
  // If the original was a "moderates" edge whose target edge has since also
  // been deleted, the server will 400 — we retry once without moderatesEdgeId
  // so the user at least gets a plain moderates edge back.
  const handleRestoreEdge = (entry: TrashedEdge, options?: { withoutModeratesRef?: boolean }) => {
    const payload: Parameters<typeof addEdge.mutate>[0]["data"] = {
      fromVariableId: entry.fromVariableId,
      toVariableId: entry.toVariableId,
      relationship: entry.relationship,
      userAdded: true,
    };
    if (
      entry.relationship === "moderates" &&
      entry.moderatesEdgeId != null &&
      !options?.withoutModeratesRef
    ) {
      payload.moderatesEdgeId = entry.moderatesEdgeId;
    }
    addEdge.mutate(
      { id: sessionId, data: payload },
      {
        onSuccess: () => {
          invalidate();
          setTrash((cur) => cur.filter((tr) => tr.trashId !== entry.trashId));
          toast({ title: t("live.trash.toastRestored" as any) });
        },
        onError: (err: any) => {
          const status = err?.response?.status ?? err?.status;
          if (status === 409) {
            // Already exists — pull it out of trash so the panel reflects reality.
            setTrash((cur) => cur.filter((tr) => tr.trashId !== entry.trashId));
            toast({ title: t("live.toast.edgeExists" as any) });
            return;
          }
          if (
            status === 400 &&
            entry.relationship === "moderates" &&
            entry.moderatesEdgeId != null &&
            !options?.withoutModeratesRef
          ) {
            handleRestoreEdge(entry, { withoutModeratesRef: true });
            return;
          }
          toast({ title: t("live.toast.failed" as any), variant: "destructive" });
        },
      },
    );
  };
  const handleClearTrashEntry = (trashId: string) => {
    setTrash((cur) => cur.filter((tr) => tr.trashId !== trashId));
  };
  const handleClearTrashAll = () => setTrash([]);

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
        // 409 = duplicate (server enforces unique (from,to,rel) per live model). Surface
        // a friendly "already exists" toast instead of the generic failure message so the
        // user understands why nothing changed.
        onError: (err: any) => {
          const status = err?.response?.status ?? err?.status;
          if (status === 409) {
            toast({ title: t("live.toast.edgeExists" as any) });
          } else {
            toast({ title: t("live.toast.failed" as any), variant: "destructive" });
          }
        },
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

  // User dragged from a node and dropped on an existing edge between two OTHER
  // variables. Treat it as "moderate this relationship": create a moderates
  // edge whose target is the moderated edge's TO variable, with an explicit
  // `moderatesEdgeId` so the canvas can route the arrow tip to the midpoint.
  const handleCanvasEdgeOnEdge = (fromVariableId: number, targetEdgeId: string) => {
    const targetEdge = (detail?.edges ?? []).find((e) => String(e.id) === targetEdgeId);
    if (!targetEdge) return;
    if (targetEdge.fromVariableId === fromVariableId || targetEdge.toVariableId === fromVariableId) return;
    setPendingEdge({
      from: fromVariableId,
      to: targetEdge.toVariableId,
      rel: "moderates",
      moderatesEdgeId: targetEdge.id,
    });
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
          ...(pendingEdge.moderatesEdgeId != null && pendingEdge.rel === "moderates"
            ? { moderatesEdgeId: pendingEdge.moderatesEdgeId }
            : {}),
        },
      },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: t("canvas.toast.edgeAdded" as any) });
          setPendingEdge(null);
        },
        onError: (err: any) => {
          const status = err?.response?.status ?? err?.status;
          if (status === 409) {
            // Drag-to-create on the canvas: the same (from,to,rel) already exists.
            // Close the picker and tell the user, rather than implying a generic failure.
            toast({ title: t("canvas.toast.edgeExists" as any) });
            setPendingEdge(null);
          } else {
            toast({ title: t("canvas.toast.edgeFailed" as any), variant: "destructive" });
          }
        },
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
  // Sort edges by visual reading order (left-to-right, top-to-bottom) using
  // each edge's source-node position, then target-node position. After the
  // user re-edits the model, this re-numbers H1, H2, … so the labels on the
  // graph and the rows in the "参考依据" list match the canvas the user sees.
  const variableIdToNodeId = new Map<number, number>();
  for (const n of nodes) variableIdToNodeId.set(n.variableId, n.id);
  const positionByNodeId = computeNodePositions(
    nodes.map((n) => ({ id: n.id, variableType: n.variableType, positionX: n.positionX ?? null, positionY: n.positionY ?? null })),
    edges,
    variableIdToNodeId,
  );
  const posOf = (variableId: number) => {
    const nid = variableIdToNodeId.get(variableId);
    if (nid == null) return { x: Number.POSITIVE_INFINITY, y: 0 };
    return positionByNodeId.get(nid) ?? { x: Number.POSITIVE_INFINITY, y: 0 };
  };
  const sortedEdges = [...edges].sort((a, b) => {
    const af = posOf(a.fromVariableId);
    const bf = posOf(b.fromVariableId);
    if (af.x !== bf.x) return af.x - bf.x;          // leftmost source first
    if (af.y !== bf.y) return af.y - bf.y;          // then top source first
    const at = posOf(a.toVariableId);
    const bt = posOf(b.toVariableId);
    if (at.x !== bt.x) return at.x - bt.x;          // then leftmost target
    if (at.y !== bt.y) return at.y - bt.y;          // then top target
    return a.id - b.id;                              // stable tiebreak
  });
  // Assign sequential H1, H2, … tags in the sorted reading order. Used in
  // both the canvas badge and the relations list below so the user can
  // cross-reference the graph and the list.
  const hTagByEdgeId = new Map<number, string>();
  sortedEdges.forEach((e, i) => hTagByEdgeId.set(e.id, `H${i + 1}`));
  const canvasEdges: CanvasEdge[] = edges.map((e) => ({
    id: String(e.id),
    fromVariableId: e.fromVariableId,
    toVariableId: e.toVariableId,
    relationship: e.relationship,
    warning: !e.hasProvenance,
    hTag: hTagByEdgeId.get(e.id),
    moderatesEdgeId: e.moderatesEdgeId != null ? String(e.moderatesEdgeId) : undefined,
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
            <Sparkles className="w-3.5 h-3.5" /> {t("evidence.btn" as any)}<span className="text-xs text-muted-foreground ml-1">≈ 1 积分</span>
          </button>
          <button
            type="button"
            data-testid="button-export-md"
            onClick={handleExportMd}
            disabled={isEmpty}
            title={isEmpty ? (t("live.export.empty" as any) as string) : (t("live.export.md" as any) as string)}
            className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium border border-border bg-secondary text-secondary-foreground hover:bg-accent h-8 px-3 transition-colors disabled:opacity-50"
          >
            <FileText className="w-3.5 h-3.5" /> {t("live.export.md" as any)}
          </button>
          <button
            type="button"
            data-testid="button-export-docx"
            onClick={handleExportDocx}
            disabled={isEmpty || isExportingDocx}
            title={isEmpty ? (t("live.export.empty" as any) as string) : (t("live.export.docx" as any) as string)}
            className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium border border-border bg-secondary text-secondary-foreground hover:bg-accent h-8 px-3 transition-colors disabled:opacity-50"
          >
            {isExportingDocx ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />}
            {t("live.export.docx" as any)}
          </button>
          <button
            type="button"
            data-testid="button-export-png"
            onClick={handleExportPng}
            disabled={isEmpty || isExportingPng}
            title={isEmpty ? (t("live.export.empty" as any) as string) : (t("live.export.png" as any) as string)}
            className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium border border-border bg-secondary text-secondary-foreground hover:bg-accent h-8 px-3 transition-colors disabled:opacity-50"
          >
            {isExportingPng ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImageDown className="w-3.5 h-3.5" />}
            {t("live.export.png" as any)}
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
              onEdgeCreateOnEdge={handleCanvasEdgeOnEdge}
              onAddVariable={handleAddVar}
              highlightEdgeId={hoveredEdgeId}
              onEdgeHover={setHoveredEdgeId}
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
                  {sortedEdges.map((e) => {
                    // P1: when this is a moderator edge with a known target,
                    // render "X moderates [A → B]" so the user can see WHICH
                    // path is being conditioned (instead of the misleading
                    // "moderator → DV" rendering). Falls back to plain
                    // from/to if the target id isn't in the current edges.
                    const moderatedTarget = e.relationship === "moderates" && e.moderatesEdgeId != null
                      ? edges.find((ed) => ed.id === e.moderatesEdgeId)
                      : null;
                    const isHighlighted = hoveredEdgeId === String(e.id);
                    return (
                    <li
                      key={e.id}
                      data-testid={`edge-row-${e.id}`}
                      onMouseEnter={() => setHoveredEdgeId(String(e.id))}
                      onMouseLeave={() => setHoveredEdgeId((cur) => cur === String(e.id) ? null : cur)}
                      className={`flex items-start gap-3 px-4 py-3 group transition-colors ${isHighlighted ? "bg-primary/5" : ""}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 text-sm flex-wrap">
                          {hTagByEdgeId.get(e.id) && (
                            <span
                              className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-violet-50 text-violet-700 border border-violet-200"
                              title={t("models.evidence.title" as any) as string}
                            >
                              {hTagByEdgeId.get(e.id)}
                            </span>
                          )}
                          <span className="font-medium text-foreground">{e.fromVariableName}</span>
                          <span className="text-muted-foreground">{REL_STYLE[e.relationship]?.label ?? e.relationship}</span>
                          {moderatedTarget ? (
                            <span
                              data-testid={`edge-moderated-path-${e.id}`}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] bg-violet-50 text-violet-700 border border-violet-200"
                              title={t("live.edge.moderatedPathTip" as any) as string}
                            >
                              <span className="font-medium">{moderatedTarget.fromVariableName}</span>
                              <span className="opacity-70">→</span>
                              <span className="font-medium">{moderatedTarget.toVariableName}</span>
                            </span>
                          ) : (
                            <span className="font-medium text-foreground">{e.toVariableName}</span>
                          )}
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
                              <button
                                type="button"
                                data-testid={`button-search-figure-${e.id}`}
                                onClick={() => {
                                  setFigureFocus({
                                    from: e.fromVariableName,
                                    to: e.toVariableName,
                                    relationship: e.relationship,
                                  });
                                }}
                                title={t("live.edge.searchFigureTip" as any) as string}
                                className="inline-flex items-center gap-1 text-[10px] font-medium text-sky-700 bg-sky-50 hover:bg-sky-100 border border-sky-200 px-1.5 py-0.5 rounded transition-colors"
                              >
                                <ImageIcon className="w-2.5 h-2.5" />
                                {t("live.edge.searchFigure" as any)}
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
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Recycle bin: lets the user restore an edge they just × off the
                list. Hidden when empty so it doesn't add noise to fresh models.
                Cap at 20 most-recent deletions; survives refresh via
                localStorage keyed by sessionId. */}
            {trash.length > 0 && (
              <div data-testid="live-trash-panel" className="bg-card border border-dashed border-border rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                    <h3 className="text-sm font-semibold text-foreground">
                      {t("live.trash.title" as any)}
                    </h3>
                    <span className="text-[11px] text-muted-foreground">({trash.length})</span>
                  </div>
                  <button
                    type="button"
                    data-testid="button-trash-clear-all"
                    onClick={handleClearTrashAll}
                    className="text-[11px] text-muted-foreground hover:text-destructive transition-colors"
                  >
                    {t("live.trash.clearAll" as any)}
                  </button>
                </div>
                <p className="px-4 pt-2 text-[11px] text-muted-foreground italic">
                  {t("live.trash.hint" as any)}
                </p>
                <ul className="divide-y divide-border">
                  {trash.map((tr) => (
                    <li key={tr.trashId} data-testid={`trash-row-${tr.trashId}`} className="flex items-start gap-3 px-4 py-3 group">
                      <div className="flex-1 min-w-0 text-sm">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-foreground">{tr.fromVariableName}</span>
                          <span className="text-muted-foreground">{REL_STYLE[tr.relationship]?.label ?? tr.relationship}</span>
                          <span className="font-medium text-foreground">{tr.toVariableName}</span>
                          {tr.hadProvenance && (
                            <span
                              title={t("live.trash.lostProvenance" as any) as string}
                              className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded"
                            >
                              <AlertTriangle className="w-2.5 h-2.5" />
                              {t("live.trash.lostProvenance.badge" as any)}
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        data-testid={`button-trash-restore-${tr.trashId}`}
                        onClick={() => handleRestoreEdge(tr)}
                        disabled={addEdge.isPending}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-2 py-1 rounded transition-colors disabled:opacity-50"
                      >
                        <RotateCcw className="w-3 h-3" />
                        {t("live.trash.restore" as any)}
                      </button>
                      <button
                        type="button"
                        data-testid={`button-trash-clear-${tr.trashId}`}
                        onClick={() => handleClearTrashEntry(tr.trashId)}
                        className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
                        aria-label={t("live.trash.clear" as any) as string}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
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
            ) : (() => {
              // Compute filtered list inline so the empty-state ("no match")
              // sees the same source-of-truth filter the rendered list uses.
              const q = poolQuery.trim().toLowerCase();
              // Match against the variable name only (and the type token, so
               // typing "moderator" still narrows by type). The previous
               // implementation also searched the full definition paragraph,
               // which produced wildly irrelevant hits — e.g. "im" matched the
               // word "image" buried inside the definition of "perceived
               // value". Definitions are long prose; substring search across
               // them is too noisy for a quick picker.
              const filtered = q
                ? variables.filter((v) => {
                    const name = (v.name ?? "").toLowerCase();
                    const type = (v.type ?? "").toLowerCase();
                    return name.includes(q) || type === q || type.startsWith(q);
                  })
                : variables;
              return (
                <>
                  <div className="px-3 pt-3 pb-2 border-b border-border">
                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                      <input
                        type="search"
                        value={poolQuery}
                        onChange={(e) => setPoolQuery(e.target.value)}
                        placeholder={t("live.pool.searchPlaceholder" as any) as string}
                        data-testid="input-pool-search"
                        className="w-full text-xs bg-background border border-input rounded-md h-7 pl-7 pr-7 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      {poolQuery && (
                        <button
                          type="button"
                          data-testid="button-pool-search-clear"
                          onClick={() => setPoolQuery("")}
                          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                          aria-label={t("live.pool.searchClear" as any) as string}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                    {q && (
                      <p className="mt-1.5 text-[10px] text-muted-foreground">
                        {t("live.pool.searchCount" as any, { matched: filtered.length, total: variables.length })}
                      </p>
                    )}
                    {/* Inline custom-variable form — collapsed by default so it
                        doesn't crowd the sidebar. Opens to a 4-row mini-form;
                        on submit, the variable is created server-side and
                        immediately added to the canvas via handleAddVar. */}
                    <div className="mt-2">
                      {!customOpen ? (
                        <button
                          type="button"
                          data-testid="button-pool-custom-toggle"
                          onClick={() => setCustomOpen(true)}
                          className="w-full text-[11px] text-primary hover:bg-primary/5 rounded-md py-1.5 px-2 border border-dashed border-primary/40 transition-colors"
                        >
                          {t("canvas.pool.custom.toggle" as any)}
                        </button>
                      ) : (
                        <div className="space-y-2 border border-border rounded-md p-2 bg-muted/30">
                          <div className="text-[11px] font-medium text-foreground">{t("canvas.pool.custom.title" as any)}</div>
                          <input
                            type="text"
                            data-testid="input-pool-custom-name"
                            value={customName}
                            onChange={(e) => setCustomName(e.target.value)}
                            placeholder={t("canvas.pool.custom.namePh" as any) as string}
                            maxLength={200}
                            className="w-full text-xs bg-background border border-input rounded-md h-7 px-2 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                          />
                          <select
                            data-testid="select-pool-custom-type"
                            value={customType}
                            onChange={(e) => setCustomType(e.target.value as typeof customType)}
                            className="w-full text-xs bg-background border border-input rounded-md h-7 px-2 focus:outline-none focus:ring-1 focus:ring-ring"
                          >
                            <option value="independent">{t("type.independent" as any)}</option>
                            <option value="mediator">{t("type.mediator" as any)}</option>
                            <option value="moderator">{t("type.moderator" as any)}</option>
                            <option value="dependent">{t("type.dependent" as any)}</option>
                          </select>
                          <textarea
                            data-testid="input-pool-custom-def"
                            value={customDef}
                            onChange={(e) => setCustomDef(e.target.value.slice(0, 150))}
                            placeholder={t("canvas.pool.custom.defPh" as any) as string}
                            rows={2}
                            className="w-full text-xs bg-background border border-input rounded-md px-2 py-1.5 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                          />
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              data-testid="button-pool-custom-create"
                              onClick={handleCreateCustomVar}
                              disabled={createCustomVar.isPending || customName.trim().length === 0}
                              className="flex-1 text-[11px] bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 rounded-md h-7 px-2 transition-colors"
                            >
                              {createCustomVar.isPending
                                ? t("canvas.pool.custom.creating" as any)
                                : t("canvas.pool.custom.create" as any)}
                            </button>
                            <button
                              type="button"
                              data-testid="button-pool-custom-cancel"
                              onClick={() => { setCustomOpen(false); setCustomName(""); setCustomDef(""); }}
                              disabled={createCustomVar.isPending}
                              className="text-[11px] text-muted-foreground hover:text-foreground rounded-md h-7 px-2 transition-colors"
                            >
                              {t("canvas.pool.custom.cancel" as any)}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  {filtered.length === 0 ? (
                    <div className="p-4 text-center text-xs text-muted-foreground italic">
                      {t("live.pool.searchEmpty" as any)}
                    </div>
                  ) : (
                    <ul className="divide-y divide-border max-h-[480px] overflow-y-auto">
                      {filtered.map((v) => {
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
                </>
              );
            })()}
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

      <ReferenceFigureDialog
        open={!!figureFocus}
        onClose={() => setFigureFocus(null)}
        sessionId={sessionId}
        edge={figureFocus}
      />
    </div>
  );
}

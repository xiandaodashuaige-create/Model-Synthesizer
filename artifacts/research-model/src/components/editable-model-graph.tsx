import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  applyNodeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type NodeProps,
  type EdgeProps,
  getBezierPath,
  EdgeLabelRenderer,
  BaseEdge,
  useStore,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import { Plus, Trash2, X } from "lucide-react";
import { useT } from "@/lib/i18n";

const TYPE_COLORS: Record<string, string> = {
  independent: "#2563eb",
  mediator: "#d97706",
  moderator: "#7c3aed",
  dependent: "#16a34a",
};

const REL_COLOR: Record<string, string> = {
  positive: "#475569",
  negative: "#dc2626",
  moderates: "#7c3aed",
  mediates: "#0891b2",
};

const REL_LABEL: Record<string, string> = {
  positive: "+",
  negative: "−",
  moderates: "M",
  mediates: "→",
};

const NODE_W = 170;
const NODE_H = 56;

// ---------------------------------------------------------------------------
// Public input shape — agnostic of which page (LiveModel vs AI candidate model)
// is using the canvas. Each integration converts to/from this shape.
// ---------------------------------------------------------------------------

export interface CanvasNode {
  id: string; // stable per-node identity (e.g. live-model node id, or `var-${variableId}`)
  variableId: number;
  variableName: string;
  type: string; // independent | mediator | moderator | dependent
  paperTag?: string; // optional "P1" etc.
  positionX?: number | null;
  positionY?: number | null;
}

export interface CanvasEdge {
  id: string; // stable per-edge identity
  fromVariableId: number;
  toVariableId: number;
  relationship: string; // positive | negative | moderates | mediates
  hTag?: string; // optional "H1" etc.
  warning?: boolean; // amber tone for edges lacking provenance
}

export interface VariablePoolEntry {
  variableId: number;
  name: string;
  type: string;
}

export interface EditableModelGraphProps {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  variablePool: VariablePoolEntry[]; // session vars not yet on canvas → for "add variable"
  // Read-only mode disables all editing handles + callbacks.
  readOnly?: boolean;
  height?: number;
  // Editing callbacks (only invoked when !readOnly).
  onNodeMove?: (canvasNodeId: string, variableId: number, x: number, y: number) => void;
  onNodeDelete?: (canvasNodeId: string, variableId: number) => void;
  onEdgeDelete?: (edgeId: string) => void;
  onEdgeCreate?: (fromVariableId: number, toVariableId: number) => void;
  onAddVariable?: (variableId: number) => void;
}

// ---------------------------------------------------------------------------
// Custom node — colored card with paperTag badge + a subtle delete button on hover.
// ---------------------------------------------------------------------------

interface VarNodeData extends Record<string, unknown> {
  variableName: string;
  type: string;
  paperTag?: string;
  variableId: number;
  canvasNodeId: string;
  readOnly: boolean;
  onDelete?: (canvasNodeId: string, variableId: number) => void;
}
type VarNode = Node<VarNodeData, "var">;

function VarNode({ data }: NodeProps<VarNode>) {
  const color = TYPE_COLORS[data.type] ?? "#64748b";
  const maxChars = 22;
  const label = data.variableName.length > maxChars ? data.variableName.slice(0, maxChars - 1) + "…" : data.variableName;
  return (
    <div
      data-testid={`canvas-node-${data.variableId}`}
      className="group relative flex items-center justify-center text-center select-none"
      style={{
        width: NODE_W,
        height: NODE_H,
        background: `${color}1a`, // ~10% alpha
        border: `1.6px solid ${color}8c`,
        borderRadius: 8,
        color,
        fontSize: 12,
        fontWeight: 600,
        padding: "0 8px",
        cursor: data.readOnly ? "default" : "grab",
      }}
      title={data.variableName}
    >
      {/* Connect handles — only shown on hover, only when editable */}
      <Handle
        type="target"
        position={Position.Left}
        style={{
          background: color,
          width: 8,
          height: 8,
          border: "1.5px solid white",
          opacity: data.readOnly ? 0 : undefined,
          pointerEvents: data.readOnly ? "none" : undefined,
        }}
      />
      <span className="leading-tight">{label}</span>
      {data.paperTag && (
        <span
          className="absolute bottom-0.5 left-1/2 -translate-x-1/2 px-1 rounded text-white text-[8px] font-bold"
          style={{ background: color }}
        >
          {data.paperTag}
        </span>
      )}
      <Handle
        type="source"
        position={Position.Right}
        style={{
          background: color,
          width: 8,
          height: 8,
          border: "1.5px solid white",
          opacity: data.readOnly ? 0 : undefined,
          pointerEvents: data.readOnly ? "none" : undefined,
        }}
      />
      {!data.readOnly && data.onDelete && (
        <button
          type="button"
          data-testid={`canvas-node-delete-${data.variableId}`}
          onClick={(e) => {
            e.stopPropagation();
            data.onDelete?.(data.canvasNodeId, data.variableId);
          }}
          className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-white border border-destructive/60 text-destructive opacity-0 group-hover:opacity-100 hover:bg-destructive hover:text-white transition-all flex items-center justify-center shadow-sm"
          title="Delete"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom edge — colored stroke + relationship label badge + on-hover delete button.
// ---------------------------------------------------------------------------

interface RelEdgeData extends Record<string, unknown> {
  relationship: string;
  hTag?: string;
  warning?: boolean;
  readOnly: boolean;
  onDelete?: (edgeId: string) => void;
  // For "moderates" edges: when present, the moderator's arrow is rerouted to
  // land on the midpoint of the primary edge between these two nodes,
  // visually indicating that it moderates the *relationship* (not a node).
  primaryFromNodeId?: string;
  primaryToNodeId?: string;
}
type RelEdge = Edge<RelEdgeData, "rel">;

function RelEdge(props: EdgeProps<RelEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data } = props;
  const rel = data?.relationship ?? "positive";
  const color = data?.warning ? "#f59e0b" : (REL_COLOR[rel] ?? "#475569");
  const dash = rel === "moderates" ? "5 4" : undefined;
  const relLabel = REL_LABEL[rel] ?? "?";

  // Live midpoint of the primary edge this moderator targets. We select a
  // primitive string so React Flow's store subscription only re-renders this
  // edge when the relevant node geometry actually changes (not on every pan,
  // zoom, or selection event).
  const midpointKey = useStore((state) => {
    if (rel !== "moderates" || !data?.primaryFromNodeId || !data?.primaryToNodeId) return "";
    const a = state.nodeLookup.get(data.primaryFromNodeId);
    const b = state.nodeLookup.get(data.primaryToNodeId);
    if (!a || !b) return "";
    const aPos = a.internals?.positionAbsolute ?? a.position;
    const bPos = b.internals?.positionAbsolute ?? b.position;
    const aw = a.measured?.width ?? NODE_W;
    const ah = a.measured?.height ?? NODE_H;
    const bw = b.measured?.width ?? NODE_W;
    const bh = b.measured?.height ?? NODE_H;
    const mx = (aPos.x + aw / 2 + bPos.x + bw / 2) / 2;
    const my = (aPos.y + ah / 2 + bPos.y + bh / 2) / 2;
    return `${mx},${my}`;
  });
  const primaryMidpoint = useMemo(() => {
    if (!midpointKey) return null;
    const [mx, my] = midpointKey.split(",").map(Number);
    return { x: mx, y: my };
  }, [midpointKey]);

  const tX = primaryMidpoint?.x ?? targetX;
  const tY = primaryMidpoint?.y ?? targetY;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX: tX, targetY: tY, sourcePosition, targetPosition });
  const useMidpoint = !!primaryMidpoint;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={useMidpoint ? undefined : markerEnd}
        style={{ stroke: color, strokeWidth: 1.8, strokeDasharray: dash, opacity: 0.85 }}
      />
      {useMidpoint && (
        // Small filled disc at the attachment point so it visibly "lands on" the moderated edge.
        <circle cx={tX} cy={tY} r={5} fill={color} stroke="white" strokeWidth={1.5} opacity={0.95} />
      )}
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan group flex items-center gap-1"
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "all",
          }}
        >
          {data?.hTag && (
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-white border"
              style={{ color: "#6d28d9", borderColor: "#7c3aed8c" }}
            >
              {data.hTag}
            </span>
          )}
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-white border"
            style={{ color, borderColor: `${color}8c` }}
          >
            {relLabel}
          </span>
          {!data?.readOnly && data?.onDelete && (
            <button
              type="button"
              data-testid={`canvas-edge-delete-${id}`}
              onClick={(e) => {
                e.stopPropagation();
                data.onDelete?.(id);
              }}
              className="w-5 h-5 rounded-full bg-white border border-destructive/60 text-destructive opacity-0 group-hover:opacity-100 hover:bg-destructive hover:text-white transition-all flex items-center justify-center shadow-sm"
              title="Delete"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

// ---------------------------------------------------------------------------
// Auto-layout: dagre when nodes lack persisted positions.
// ---------------------------------------------------------------------------

function autoLayout(canvasNodes: CanvasNode[], canvasEdges: CanvasEdge[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (!canvasNodes.length) return positions;
  // Mixed mode: only auto-place nodes that lack a persisted position. Nodes
  // with positions are pinned in dagre so the layout flows around them
  // instead of overlapping. If at least one node already has a position we
  // skip dagre and let unpositioned nodes fall to (0,0) — the user can drag
  // them where they want; this avoids dagre rearranging pinned neighbours.
  const hasAnyPersisted = canvasNodes.some((n) => typeof n.positionX === "number" && typeof n.positionY === "number");
  if (hasAnyPersisted) {
    // Place unpositioned nodes in a small grid below the bounding box of pinned ones.
    const pinned = canvasNodes.filter((n) => typeof n.positionX === "number" && typeof n.positionY === "number");
    const maxY = pinned.reduce((m, n) => Math.max(m, (n.positionY as number) + NODE_H), 0);
    const minX = pinned.reduce((m, n) => Math.min(m, n.positionX as number), Infinity);
    const baseX = Number.isFinite(minX) ? minX : 24;
    let i = 0;
    for (const n of canvasNodes) {
      if (typeof n.positionX !== "number" || typeof n.positionY !== "number") {
        positions.set(n.id, { x: baseX + (i % 4) * (NODE_W + 24), y: maxY + 40 + Math.floor(i / 4) * (NODE_H + 24) });
        i++;
      }
    }
    return positions;
  }
  const typeRank: Record<string, number> = { independent: 0, mediator: 1, moderator: 2, dependent: 3 };
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 36, ranksep: 110, marginx: 24, marginy: 24, ranker: "network-simplex" });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of canvasNodes) {
    g.setNode(n.id, { width: NODE_W, height: NODE_H, rank: typeRank[n.type] ?? 0 });
  }
  // Edges keyed by variable pair — dagre wants graph-internal node ids.
  const idByVar = new Map<number, string>();
  canvasNodes.forEach((n) => idByVar.set(n.variableId, n.id));
  for (const e of canvasEdges) {
    const from = idByVar.get(e.fromVariableId);
    const to = idByVar.get(e.toVariableId);
    if (from && to) g.setEdge(from, to);
  }
  dagre.layout(g);
  for (const n of canvasNodes) {
    const dn = g.node(n.id) as { x: number; y: number } | undefined;
    if (dn) positions.set(n.id, { x: dn.x - NODE_W / 2, y: dn.y - NODE_H / 2 });
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Inner component (must live inside ReactFlowProvider).
// ---------------------------------------------------------------------------

const nodeTypes = { var: VarNode };
const edgeTypes = { rel: RelEdge };

function EditableModelGraphInner(props: EditableModelGraphProps) {
  const { t } = useT();
  const { nodes: inputNodes, edges: inputEdges, variablePool, readOnly = false, height = 480, onNodeMove, onNodeDelete, onEdgeDelete, onEdgeCreate, onAddVariable } = props;

  // Compute initial positions once per node-set change. We keep an internal
  // Node[] that we mutate during drag (for smooth UI) and only call onNodeMove
  // on dragStop to avoid spamming the server.
  const positions = useMemo(() => autoLayout(inputNodes, inputEdges), [inputNodes, inputEdges]);

  const buildRfNodes = useCallback((): Node[] => {
    return inputNodes.map((n) => {
      const auto = positions.get(n.id) ?? { x: 0, y: 0 };
      const x = typeof n.positionX === "number" ? n.positionX : auto.x;
      const y = typeof n.positionY === "number" ? n.positionY : auto.y;
      return {
        id: n.id,
        type: "var",
        position: { x, y },
        data: {
          variableName: n.variableName,
          type: n.type,
          paperTag: n.paperTag,
          variableId: n.variableId,
          canvasNodeId: n.id,
          readOnly,
          onDelete: onNodeDelete,
        } satisfies VarNodeData,
        draggable: !readOnly,
        selectable: !readOnly,
      };
    });
  }, [inputNodes, positions, readOnly, onNodeDelete]);

  const [rfNodes, setRfNodes] = useState<Node[]>(buildRfNodes);

  // Only reset when the SET of nodes (or labels) changes — NOT on every
  // position update from the server. Otherwise a successful drag-save would
  // round-trip the data through React Query and snap any other node the user
  // might be dragging back to its previous server-side position.
  const upstreamKey = useMemo(
    () => inputNodes.map((n) => `${n.id}:${n.variableName}`).join("|"),
    [inputNodes],
  );
  useEffect(() => {
    // Preserve current positions for nodes that are still present; only seed
    // positions for newly-added nodes from the upstream layout.
    setRfNodes((cur) => {
      const curById = new Map(cur.map((n) => [n.id, n]));
      return buildRfNodes().map((n) => {
        const existing = curById.get(n.id);
        return existing ? { ...n, position: existing.position } : n;
      });
    });
  }, [upstreamKey, buildRfNodes]);

  const rfEdges = useMemo<Edge[]>(() => {
    const idByVar = new Map<number, string>();
    inputNodes.forEach((n) => idByVar.set(n.variableId, n.id));
    // For each potential "moderated edge target" node, remember the first
    // non-moderates incoming edge — that's what a moderator pointing at the
    // same target is interpreted as moderating. Heuristic, but matches the
    // common research-diagram convention where M → B means "M moderates A→B".
    const primaryByTargetVar = new Map<number, { fromVar: number; toVar: number }>();
    for (const e of inputEdges) {
      if (e.relationship === "moderates") continue;
      if (!primaryByTargetVar.has(e.toVariableId)) {
        primaryByTargetVar.set(e.toVariableId, { fromVar: e.fromVariableId, toVar: e.toVariableId });
      }
    }
    return inputEdges
      .map((e) => {
        const source = idByVar.get(e.fromVariableId);
        const target = idByVar.get(e.toVariableId);
        if (!source || !target) return null;
        const color = e.warning ? "#f59e0b" : (REL_COLOR[e.relationship] ?? "#475569");
        const data: RelEdgeData = {
          relationship: e.relationship,
          hTag: e.hTag,
          warning: e.warning,
          readOnly,
          onDelete: onEdgeDelete,
        };
        if (e.relationship === "moderates") {
          const primary = primaryByTargetVar.get(e.toVariableId);
          // Skip self-pointing degenerate cases (would compute a midpoint = node center).
          if (primary && primary.fromVar !== e.fromVariableId && primary.toVar !== e.fromVariableId) {
            data.primaryFromNodeId = idByVar.get(primary.fromVar);
            data.primaryToNodeId = idByVar.get(primary.toVar);
          }
        }
        return {
          id: e.id,
          source,
          target,
          type: "rel",
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
          data,
        } as Edge;
      })
      .filter((x): x is Edge => !!x);
  }, [inputNodes, inputEdges, readOnly, onEdgeDelete]);

  // Drag handling — mutate internal state on every change, fire callback only on dragStop.
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setRfNodes((cur) => applyNodeChanges(changes, cur));
    },
    [],
  );

  const handleNodeDragStop = useCallback(
    (_e: React.MouseEvent, node: Node) => {
      if (readOnly || !onNodeMove) return;
      const data = node.data as unknown as VarNodeData;
      onNodeMove(data.canvasNodeId, data.variableId, node.position.x, node.position.y);
    },
    [readOnly, onNodeMove],
  );

  const handleConnect = useCallback(
    (c: Connection) => {
      if (readOnly || !onEdgeCreate || !c.source || !c.target || c.source === c.target) return;
      const fromVar = inputNodes.find((n) => n.id === c.source)?.variableId;
      const toVar = inputNodes.find((n) => n.id === c.target)?.variableId;
      if (fromVar && toVar) onEdgeCreate(fromVar, toVar);
    },
    [readOnly, onEdgeCreate, inputNodes],
  );

  // Add-variable popover
  const [showPool, setShowPool] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showPool) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as globalThis.Node | null)) setShowPool(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [showPool]);

  const availablePool = useMemo(() => {
    const onCanvas = new Set(inputNodes.map((n) => n.variableId));
    return variablePool.filter((v) => !onCanvas.has(v.variableId));
  }, [variablePool, inputNodes]);

  return (
    <div ref={wrapperRef} className="relative bg-card border border-border rounded-lg overflow-hidden" style={{ height }}>
      {!readOnly && (
        <div className="absolute top-2 left-2 z-10 flex items-center gap-2">
          <button
            type="button"
            data-testid="canvas-add-variable-toggle"
            onClick={() => setShowPool((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium h-8 px-3 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shadow"
          >
            <Plus className="w-3.5 h-3.5" />
            {t("canvas.addVariable" as any)}
          </button>
          <span className="text-[11px] text-muted-foreground bg-white/80 backdrop-blur px-2 py-1 rounded">
            {t("canvas.hint" as any)}
          </span>
        </div>
      )}

      {showPool && (
        <div data-testid="canvas-variable-pool" className="absolute top-12 left-2 z-20 w-72 max-h-80 overflow-auto bg-popover border border-border rounded-md shadow-lg">
          <div className="px-3 py-2 border-b border-border text-xs font-semibold text-foreground sticky top-0 bg-popover">
            {t("canvas.pool.title" as any)} ({availablePool.length})
          </div>
          {availablePool.length === 0 ? (
            <div className="p-4 text-xs text-center text-muted-foreground italic">{t("canvas.pool.empty" as any)}</div>
          ) : (
            <ul className="divide-y divide-border">
              {availablePool.map((v) => (
                <li key={v.variableId}>
                  <button
                    type="button"
                    data-testid={`canvas-pool-add-${v.variableId}`}
                    onClick={() => {
                      onAddVariable?.(v.variableId);
                      setShowPool(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors"
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: TYPE_COLORS[v.type] ?? "#64748b" }}
                      title={v.type}
                    />
                    <span className="flex-1 text-xs text-foreground truncate" title={v.name}>{v.name}</span>
                    <Plus className="w-3.5 h-3.5 text-primary shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={handleNodeDragStop}
        onConnect={handleConnect}
        nodesConnectable={!readOnly}
        nodesDraggable={!readOnly}
        elementsSelectable={!readOnly}
        edgesFocusable={!readOnly}
        proOptions={{ hideAttribution: true }}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1.2 }}
        minZoom={0.3}
        maxZoom={1.6}
        defaultEdgeOptions={{ type: "rel" }}
      >
        <Background gap={18} size={1} />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap pannable zoomable className="!bg-card border border-border" nodeColor={(n) => TYPE_COLORS[(n.data as unknown as VarNodeData)?.type] ?? "#64748b"} />
      </ReactFlow>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public wrapper — provides ReactFlowProvider so the inner can use hooks.
// ---------------------------------------------------------------------------

export function EditableModelGraph(props: EditableModelGraphProps) {
  return (
    <ReactFlowProvider>
      <EditableModelGraphInner {...props} />
    </ReactFlowProvider>
  );
}

// Re-export shared color maps for callers that need to render legends.
export const CANVAS_TYPE_COLORS = TYPE_COLORS;
export const CANVAS_REL_COLORS = REL_COLOR;

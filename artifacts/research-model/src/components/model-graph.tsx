import React, { useMemo } from "react";
import dagre from "@dagrejs/dagre";

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

export interface ModelGraphNode {
  variableId: number;
  variableName: string;
  type: string;
  paperId: number;
}

export interface ModelGraphEdge {
  fromVariableId: number;
  toVariableId: number;
  relationship: string;
  evidencePaperId: number;
}

export function ModelGraph({
  nodes,
  edges,
  paperTagById,
  edgeHTagByKey,
}: {
  nodes: ModelGraphNode[];
  edges: ModelGraphEdge[];
  paperTagById: Map<number, string>;
  edgeHTagByKey: Map<string, string>;
}) {
  const layout = useMemo(() => {
    if (!nodes.length) return null;
    const NODE_W = 160;
    const NODE_H = 56;
    const PAD = 24;

    const edgeGroups = new Map<string, ModelGraphEdge[]>();
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
    const positionedNodes = nodes
      .map((n) => {
        const dn = g.node(String(n.variableId)) as { x: number; y: number } | undefined;
        return dn ? { ...n, x: dn.x, y: dn.y, w: NODE_W, h: NODE_H } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);

    const positionedEdges = [...edgeGroups.entries()]
      .map(([k, group]) => {
        const [from, to] = k.split("->");
        const de = g.edge(from, to) as { points: Array<{ x: number; y: number }> } | undefined;
        if (!de || !de.points || de.points.length < 2) return null;
        return { key: k, group, points: de.points };
      })
      .filter((x): x is NonNullable<typeof x> => !!x);

    return { width, height, nodes: positionedNodes, edges: positionedEdges };
  }, [nodes, edges]);

  if (!layout) return null;
  const { width, height } = layout;

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

// Build sequential H1, H2, … tags for an edge array, keyed by `${from}->${to}#${gi}`
// where gi is the index within parallel edges between the same node pair.
export function buildEdgeHTagMap(edges: ModelGraphEdge[]): Map<string, string> {
  const out = new Map<string, string>();
  const counter = new Map<string, number>();
  edges.forEach((e, i) => {
    const k = `${e.fromVariableId}->${e.toVariableId}`;
    const gi = counter.get(k) ?? 0;
    counter.set(k, gi + 1);
    out.set(`${k}#${gi}`, `H${i + 1}`);
  });
  return out;
}

// Build sequential P1, P2, … tags for papers in first-appearance order across nodes then edges.
export function buildPaperTagMap(
  nodes: Array<{ paperId: number }>,
  edges: Array<{ evidencePaperId: number }>,
): Map<number, string> {
  const order: number[] = [];
  const seen = new Set<number>();
  for (const n of nodes) {
    if (!seen.has(n.paperId)) {
      seen.add(n.paperId);
      order.push(n.paperId);
    }
  }
  for (const e of edges) {
    if (!seen.has(e.evidencePaperId)) {
      seen.add(e.evidencePaperId);
      order.push(e.evidencePaperId);
    }
  }
  const out = new Map<number, string>();
  order.forEach((pid, i) => out.set(pid, `P${i + 1}`));
  return out;
}

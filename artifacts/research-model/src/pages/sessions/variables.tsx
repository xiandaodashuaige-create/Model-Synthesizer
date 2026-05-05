import React from "react";
import { useParams, Link } from "wouter";
import {
  useListSessionVariables,
  useGetVariableGraph,
  getListSessionVariablesQueryKey,
  getGetVariableGraphQueryKey,
} from "@workspace/api-client-react";
import { Loader2, Database, ArrowRight, Quote, BookOpen } from "lucide-react";
import { useT } from "@/lib/i18n";
import { NextStepHint } from "@/components/onboarding-stepper";

function useTypeMeta() {
  const { t } = useT();
  return {
    independent: { label: t("vars.type.independent" as any), color: "text-blue-700 dark:text-blue-300", bg: "bg-blue-50 dark:bg-blue-950/40", border: "border-blue-200 dark:border-blue-800" },
    mediator: { label: t("vars.type.mediator" as any), color: "text-amber-700 dark:text-amber-300", bg: "bg-amber-50 dark:bg-amber-950/40", border: "border-amber-200 dark:border-amber-800" },
    moderator: { label: t("vars.type.moderator" as any), color: "text-purple-700 dark:text-purple-300", bg: "bg-purple-50 dark:bg-purple-950/40", border: "border-purple-200 dark:border-purple-800" },
    dependent: { label: t("vars.type.dependent" as any), color: "text-green-700 dark:text-green-300", bg: "bg-green-50 dark:bg-green-950/40", border: "border-green-200 dark:border-green-800" },
  } as Record<string, { label: string; color: string; bg: string; border: string }>;
}

function VariableGraph({ sessionId }: { sessionId: number }) {
  const { t } = useT();
  const TYPE_META = useTypeMeta();
  const { data: graph, isLoading } = useGetVariableGraph(sessionId, {
    query: { enabled: !!sessionId, queryKey: getGetVariableGraphQueryKey(sessionId) },
  });

  if (isLoading) return <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  if (!graph || graph.nodes.length === 0) return null;

  const WIDTH = 700;
  const HEIGHT = 320;
  const NODE_W = 140;
  const NODE_H = 44;
  const groups: Record<string, typeof graph.nodes> = {};
  for (const n of graph.nodes) {
    if (!groups[n.type]) groups[n.type] = [];
    groups[n.type].push(n);
  }
  const typeOrder = ["independent", "mediator", "moderator", "dependent"];
  const positions = new Map<string, { x: number; y: number }>();
  const cols = typeOrder.filter((t) => groups[t]?.length > 0);
  cols.forEach((type, colIdx) => {
    const nodes = groups[type] ?? [];
    const colX = ((colIdx + 0.5) / cols.length) * WIDTH;
    nodes.forEach((node, rowIdx) => {
      const totalH = nodes.length * (NODE_H + 16) - 16;
      const startY = (HEIGHT - totalH) / 2;
      positions.set(node.id, { x: colX, y: startY + rowIdx * (NODE_H + 16) + NODE_H / 2 });
    });
  });

  const colorMap: Record<string, string> = {
    independent: "#2563eb", mediator: "#d97706", moderator: "#7c3aed", dependent: "#16a34a",
  };

  const drawnEdges = new Set<string>();

  return (
    <div className="bg-card border border-border rounded-lg p-5">
      <h3 className="text-sm font-semibold text-foreground mb-4">{t("vars.graph.title" as any)}</h3>
      <div className="overflow-x-auto">
        <svg width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="text-foreground">
          <defs>
            <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity={0.5} />
            </marker>
          </defs>
          {graph.edges.map((edge, i) => {
            const edgeKey = `${edge.source}->${edge.target}`;
            if (drawnEdges.has(edgeKey)) return null;
            drawnEdges.add(edgeKey);
            const from = positions.get(edge.source);
            const to = positions.get(edge.target);
            if (!from || !to) return null;
            const fromX = from.x + NODE_W / 2;
            const toX = to.x - NODE_W / 2;
            return (
              <line key={i} x1={fromX} y1={from.y} x2={toX} y2={to.y}
                stroke="currentColor" strokeOpacity={0.25} strokeWidth={1.5}
                markerEnd="url(#arrowhead)" />
            );
          })}
          {graph.nodes.map((node) => {
            const pos = positions.get(node.id);
            if (!pos) return null;
            const color = colorMap[node.type] ?? "#888";
            return (
              <g key={node.id} transform={`translate(${pos.x - NODE_W / 2}, ${pos.y - NODE_H / 2})`}>
                <rect width={NODE_W} height={NODE_H} rx={6} fill={color} fillOpacity={0.12} stroke={color} strokeOpacity={0.4} strokeWidth={1.5} />
                <text x={NODE_W / 2} y={NODE_H / 2 - 4} textAnchor="middle" fontSize={10} fontWeight={600} fill={color}>
                  {node.label.length > 18 ? node.label.slice(0, 17) + "…" : node.label}
                </text>
                <text x={NODE_W / 2} y={NODE_H / 2 + 10} textAnchor="middle" fontSize={9} fill={color} opacity={0.7}>
                  {node.paperCount}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="flex flex-wrap gap-3 mt-3">
        {Object.entries(colorMap).map(([type, color]) =>
          groups[type]?.length ? (
            <div key={type} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: color }} />
              {TYPE_META[type]?.label}
            </div>
          ) : null
        )}
      </div>
    </div>
  );
}

export default function SessionVariables({ params: routeParams }: { params?: { id?: string } }) {
  const { t } = useT();
  const TYPE_META = useTypeMeta();
  const params = useParams<{ id: string }>();
  const sessionId = parseInt(routeParams?.id ?? params.id ?? "0", 10);

  const { data: variables, isLoading } = useListSessionVariables(sessionId, {
    query: { enabled: !!sessionId, queryKey: getListSessionVariablesQueryKey(sessionId) },
  });

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

  const grouped = variables.reduce<Record<string, typeof variables>>((acc, v) => {
    if (!acc[v.type]) acc[v.type] = [];
    acc[v.type].push(v);
    return acc;
  }, {});

  const typeOrder = ["independent", "mediator", "moderator", "dependent"];

  return (
    <div className="space-y-8">
      <NextStepHint
        title={t("vars.tip.next.title" as any)}
        body={t("vars.tip.next.body" as any)}
        href={`/sessions/${sessionId}/models`}
        cta={t("vars.goModels" as any)}
      />

      <VariableGraph sessionId={sessionId} />

      <div className="space-y-8">
        {typeOrder.filter((t) => grouped[t]?.length).map((type) => {
          const meta = TYPE_META[type]!;
          return (
            <div key={type}>
              <h2 className={`text-sm font-semibold uppercase tracking-wider mb-3 flex items-center gap-2 ${meta.color}`}>
                <span className={`w-2 h-2 rounded-full inline-block ${meta.bg} border ${meta.border}`} />
                {meta.label}
                <span className="font-normal text-muted-foreground normal-case tracking-normal">
                  {t("vars.type.suffix" as any, { n: grouped[type].length })}
                </span>
              </h2>
              <div className="space-y-3">
                {grouped[type].map((v) => (
                  <div key={v.id} data-testid={`card-variable-${v.id}`} className={`bg-card border rounded-lg p-5 ${meta.border}`}>
                    <div className="flex items-start justify-between gap-4 mb-3">
                      <div>
                        <h3 className="text-base font-semibold text-foreground">{v.name}</h3>
                        <p className="text-xs text-muted-foreground mt-0.5">{v.definition}</p>
                      </div>
                      <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${meta.bg} ${meta.color} border ${meta.border}`}>
                        {meta.label}
                      </span>
                    </div>
                    <div className={`flex items-start gap-2 p-3 rounded-md ${meta.bg} border ${meta.border}`}>
                      <Quote className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${meta.color}`} />
                      <p className={`text-xs leading-relaxed ${meta.color} italic`}>{v.citationText}</p>
                    </div>
                    <div className="flex items-center gap-1.5 mt-3 text-xs text-muted-foreground">
                      <BookOpen className="w-3.5 h-3.5" />
                      <span className="font-medium">{v.paperTitle}</span>
                      {v.paperAuthors?.length > 0 && <span>· {v.paperAuthors.slice(0, 2).join(", ")}{v.paperAuthors.length > 2 ? " et al." : ""}</span>}
                      {v.paperYear && <span>· {v.paperYear}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

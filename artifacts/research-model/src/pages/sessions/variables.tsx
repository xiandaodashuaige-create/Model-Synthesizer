import React, { useState } from "react";
import { useParams, Link } from "wouter";
import {
  useListSessionVariables,
  useGetVariableGraph,
  getListSessionVariablesQueryKey,
  getGetVariableGraphQueryKey,
} from "@workspace/api-client-react";
import { Loader2, Database, ArrowRight, Quote, BookOpen, ChevronDown, ChevronRight as ChevronRightIcon, Layers } from "lucide-react";
import { useT } from "@/lib/i18n";
import { NextStepHint, BigNextStep } from "@/components/onboarding-stepper";

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
      />

      <VariableGraph sessionId={sessionId} />

      <div className="rounded-md border border-border bg-muted/30 p-4 text-xs text-muted-foreground flex items-start gap-2">
        <Layers className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
        <span>{t("vars.cluster.hint" as any, { clusterCount: clusters.length, totalCount: variables.length })}</span>
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
                    <ClusterCard key={c.key} cluster={c} meta={meta} primary />
                  ))}
                </div>
              )}

              {secondary.length > 0 && (
                <SecondaryGroup clusters={secondary} meta={meta} />
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
}: {
  cluster: { key: string; type: string; name: string; sources: any[] };
  meta: { label: string; color: string; bg: string; border: string };
  primary?: boolean;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const top = cluster.sources[0];
  return (
    <div data-testid={`cluster-${cluster.key}`} className={`bg-card border rounded-lg p-5 ${meta.border}`}>
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-foreground">{cluster.name}</h3>
            {primary && cluster.sources.length >= 2 && (
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${meta.bg} ${meta.color} border ${meta.border}`}>
                {t("vars.cluster.fromN" as any, { n: cluster.sources.length })}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{top.definition}</p>
        </div>
        <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${meta.bg} ${meta.color} border ${meta.border}`}>
          {meta.label}
        </span>
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
            <div key={s.id} className={`rounded-md border ${meta.border} ${meta.bg} p-3`}>
              <div className="flex items-start gap-2 mb-2">
                <Quote className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${meta.color}`} />
                <p className={`text-xs leading-relaxed ${meta.color} italic`}>{s.citationText}</p>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <BookOpen className="w-3.5 h-3.5 shrink-0" />
                <span className="font-medium">{s.paperTitle}</span>
                {s.paperAuthors?.length > 0 && (
                  <span>· {s.paperAuthors.slice(0, 2).join(", ")}{s.paperAuthors.length > 2 ? " et al." : ""}</span>
                )}
                {s.paperYear && <span>· {s.paperYear}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SecondaryGroup({
  clusters,
  meta,
}: {
  clusters: Array<{ key: string; type: string; name: string; sources: any[] }>;
  meta: { label: string; color: string; bg: string; border: string };
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
          <ClusterCard key={c.key} cluster={c} meta={meta} />
        ))}
      </div>
    </details>
  );
}

import React, { useMemo } from "react";
import { Link, useParams, useSearch } from "wouter";
import {
  useGetModel,
  getGetModelQueryKey,
} from "@workspace/api-client-react";
import { Loader2, ArrowLeft, AlertTriangle } from "lucide-react";
import { useT } from "@/lib/i18n";
import { ModelGraph, buildEdgeHTagMap, buildPaperTagMap } from "@/components/model-graph";

const REL_LABEL: Record<string, string> = {
  positive: "+",
  negative: "−",
  moderates: "M",
  mediates: "→",
};

type EdgeForCompare = {
  fromVariableId: number;
  toVariableId: number;
  fromVariableName: string;
  toVariableName: string;
  relationship: string;
};
function edgeKey(e: EdgeForCompare): string {
  return `${e.fromVariableId}->${e.toVariableId}#${e.relationship}`;
}

function ModelPanel({ modelId, label }: { modelId: number; label: string }) {
  const { t } = useT();
  const { data: model, isLoading, isError } = useGetModel(modelId, {
    query: { enabled: modelId > 0, queryKey: getGetModelQueryKey(modelId) },
  });

  if (isLoading) {
    return (
      <div className="bg-card border border-border rounded-xl p-8 flex justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }
  if (isError || !model) {
    return (
      <div className="bg-destructive/10 text-destructive rounded-xl border border-destructive/20 p-6 text-sm">
        {t("compare.notFound" as any)}
      </div>
    );
  }

  const nodes = model.nodes ?? [];
  const edges = model.edges ?? [];
  const paperTagById = buildPaperTagMap(nodes, edges);
  const edgeHTagByKey = buildEdgeHTagMap(edges);

  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-3 min-w-0">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-primary text-primary-foreground text-sm font-bold">
            {label}
          </span>
          <h3 className="text-sm font-semibold text-foreground">{model.name}</h3>
        </div>
        {model.partialPassMeta?.allowPartial && (
          <span
            title={t("models.partial.badgeTip" as any, { n: model.partialPassMeta.missingPapers.length }) as string}
            className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-800 bg-amber-50 border border-amber-300 px-1.5 py-0.5 rounded"
          >
            <AlertTriangle className="w-3 h-3" />
            {t("models.partial.badge" as any)}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">{model.description}</p>
      <div className="border border-border rounded-lg overflow-hidden bg-muted/20">
        <ModelGraph nodes={nodes} edges={edges} paperTagById={paperTagById} edgeHTagByKey={edgeHTagByKey} />
      </div>
      <div className="text-[11px] text-muted-foreground">
        {nodes.length} · {edges.length}
      </div>
    </div>
  );
}

function diffSets<T>(a: T[], b: T[], keyFn: (x: T) => string): { onlyA: T[]; onlyB: T[]; shared: T[] } {
  const ka = new Map(a.map((x) => [keyFn(x), x]));
  const kb = new Map(b.map((x) => [keyFn(x), x]));
  const onlyA: T[] = [];
  const onlyB: T[] = [];
  const shared: T[] = [];
  for (const [k, v] of ka) (kb.has(k) ? shared : onlyA).push(v);
  for (const [k, v] of kb) if (!ka.has(k)) onlyB.push(v);
  return { onlyA, onlyB, shared };
}

function DiffCard({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div className="bg-card border border-border rounded-lg p-3">
      <p className="text-xs font-semibold text-foreground mb-2">{title}</p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((it, i) => (
            <li key={i} className="text-xs text-foreground truncate" title={it}>{it}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ModelsComparePage({ params }: { params?: { id: string } }) {
  const { t } = useT();
  const routeParams = useParams<{ id: string }>();
  const sessionId = parseInt(params?.id ?? routeParams?.id ?? "0", 10);
  const search = useSearch();
  const sp = new URLSearchParams(search);
  const aId = parseInt(sp.get("a") ?? "0", 10);
  const bId = parseInt(sp.get("b") ?? "0", 10);

  const aQ = useGetModel(aId, { query: { enabled: aId > 0, queryKey: getGetModelQueryKey(aId) } });
  const bQ = useGetModel(bId, { query: { enabled: bId > 0, queryKey: getGetModelQueryKey(bId) } });

  const diff = useMemo(() => {
    const a = aQ.data;
    const b = bQ.data;
    if (!a || !b) return null;
    const aNodes = a.nodes ?? [];
    const bNodes = b.nodes ?? [];
    const aEdges = a.edges ?? [];
    const bEdges = b.edges ?? [];
    const vars = diffSets(aNodes, bNodes, (n) => String(n.variableId));
    const edges = diffSets<EdgeForCompare>(aEdges, bEdges, edgeKey);
    const fmtEdge = (e: EdgeForCompare) =>
      `${e.fromVariableName} ${REL_LABEL[e.relationship] ?? e.relationship} ${e.toVariableName}`;
    return {
      varsOnlyA: vars.onlyA.map((n) => n.variableName),
      varsOnlyB: vars.onlyB.map((n) => n.variableName),
      varsShared: vars.shared.map((n) => n.variableName),
      edgesOnlyA: edges.onlyA.map(fmtEdge),
      edgesOnlyB: edges.onlyB.map(fmtEdge),
      edgesShared: edges.shared.map(fmtEdge),
    };
  }, [aQ.data, bQ.data]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-serif font-bold text-foreground">{t("compare.title" as any)}</h2>
          {diff && (
            <p className="text-xs text-muted-foreground mt-1">
              {t("compare.diff.summary" as any, {
                varsA: diff.varsOnlyA.length,
                varsB: diff.varsOnlyB.length,
                edgesA: diff.edgesOnlyA.length,
                edgesB: diff.edgesOnlyB.length,
              })}
            </p>
          )}
        </div>
        <Link
          href={`/sessions/${sessionId}/models`}
          className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium border border-border bg-secondary text-secondary-foreground hover:bg-accent h-8 px-3 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> {t("compare.back" as any)}
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ModelPanel modelId={aId} label={t("compare.legendA" as any)} />
        <ModelPanel modelId={bId} label={t("compare.legendB" as any)} />
      </div>

      {diff && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">{t("compare.diff.title" as any)}</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <DiffCard title={t("compare.diff.varsOnlyA" as any)} items={diff.varsOnlyA} empty={t("compare.diff.empty" as any)} />
            <DiffCard title={t("compare.diff.varsShared" as any)} items={diff.varsShared} empty={t("compare.diff.empty" as any)} />
            <DiffCard title={t("compare.diff.varsOnlyB" as any)} items={diff.varsOnlyB} empty={t("compare.diff.empty" as any)} />
            <DiffCard title={t("compare.diff.edgesOnlyA" as any)} items={diff.edgesOnlyA} empty={t("compare.diff.empty" as any)} />
            <DiffCard title={t("compare.diff.edgesShared" as any)} items={diff.edgesShared} empty={t("compare.diff.empty" as any)} />
            <DiffCard title={t("compare.diff.edgesOnlyB" as any)} items={diff.edgesOnlyB} empty={t("compare.diff.empty" as any)} />
          </div>
        </div>
      )}
    </div>
  );
}

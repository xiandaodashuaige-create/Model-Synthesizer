import React from "react";
import { useParams, Link } from "wouter";
import {
  useListSessionModels,
  useGenerateModels,
  useSelectModel,
  getListSessionModelsQueryKey,
  getGetSessionSummaryQueryKey,
  getGetSessionQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Share2, Sparkles, CheckCircle, ArrowRight, BookOpen } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const TYPE_COLORS: Record<string, string> = {
  independent: "#2563eb",
  mediator: "#d97706",
  moderator: "#7c3aed",
  dependent: "#16a34a",
};

function ModelGraph({ nodes, edges }: {
  nodes: Array<{ variableId: number; variableName: string; type: string }>;
  edges: Array<{ fromVariableId: number; toVariableId: number; relationship: string }>;
}) {
  if (!nodes.length) return null;
  const WIDTH = 460;
  const HEIGHT = 200;
  const NODE_W = 120;
  const NODE_H = 38;

  const typeOrder = ["independent", "mediator", "moderator", "dependent"];
  const grouped: Record<string, typeof nodes> = {};
  for (const n of nodes) {
    if (!grouped[n.type]) grouped[n.type] = [];
    grouped[n.type].push(n);
  }
  const cols = typeOrder.filter((t) => grouped[t]?.length);
  const positions = new Map<number, { x: number; y: number }>();
  cols.forEach((type, colIdx) => {
    const ns = grouped[type] ?? [];
    const colX = ((colIdx + 0.5) / cols.length) * WIDTH;
    ns.forEach((node, rowIdx) => {
      const totalH = ns.length * (NODE_H + 12) - 12;
      const startY = (HEIGHT - totalH) / 2;
      positions.set(node.variableId, { x: colX, y: startY + rowIdx * (NODE_H + 12) + NODE_H / 2 });
    });
  });

  return (
    <svg width="100%" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="overflow-visible">
      <defs>
        <marker id="arr-m" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
          <path d="M0,0 L0,6 L7,3 z" fill="currentColor" opacity={0.4} />
        </marker>
      </defs>
      {edges.map((edge, i) => {
        const from = positions.get(edge.fromVariableId);
        const to = positions.get(edge.toVariableId);
        if (!from || !to) return null;
        const fromX = from.x + NODE_W / 2 - 2;
        const toX = to.x - NODE_W / 2 + 2;
        return (
          <line key={i} x1={fromX} y1={from.y} x2={toX} y2={to.y}
            stroke="currentColor" strokeOpacity={0.2} strokeWidth={1.5}
            markerEnd="url(#arr-m)" />
        );
      })}
      {nodes.map((node) => {
        const pos = positions.get(node.variableId);
        if (!pos) return null;
        const color = TYPE_COLORS[node.type] ?? "#888";
        return (
          <g key={node.variableId} transform={`translate(${pos.x - NODE_W / 2}, ${pos.y - NODE_H / 2})`}>
            <rect width={NODE_W} height={NODE_H} rx={5} fill={color} fillOpacity={0.1} stroke={color} strokeOpacity={0.35} strokeWidth={1.5} />
            <text x={NODE_W / 2} y={NODE_H / 2 + 4} textAnchor="middle" fontSize={9} fontWeight={600} fill={color}>
              {node.variableName.length > 16 ? node.variableName.slice(0, 15) + "…" : node.variableName}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default function SessionModels({ params: routeParams }: { params?: { id?: string } }) {
  const params = useParams<{ id: string }>();
  const sessionId = parseInt(routeParams?.id ?? params.id ?? "0", 10);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const generateModels = useGenerateModels();
  const selectModel = useSelectModel();

  const { data: models, isLoading } = useListSessionModels(sessionId, {
    query: { enabled: !!sessionId, queryKey: getListSessionModelsQueryKey(sessionId) }
  });

  const handleGenerate = () => {
    generateModels.mutate({ id: sessionId }, {
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: getListSessionModelsQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
        toast({ title: "Models generated", description: `${result.length} new research models generated.` });
      },
      onError: (err: any) => {
        const msg = err?.error ?? "Failed to generate models. Make sure you have extracted variables first.";
        toast({ title: "Generation failed", description: msg, variant: "destructive" });
      },
    });
  };

  const handleSelect = (modelId: number, name: string) => {
    selectModel.mutate({ id: modelId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSessionModelsQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
        toast({ title: "Model selected", description: `"${name}" is now your selected research model.` });
      },
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Generate novel research model combinations from your extracted variables using AI.</p>
        </div>
        <button
          data-testid="button-generate-models"
          onClick={handleGenerate}
          disabled={generateModels.isPending}
          className="inline-flex items-center gap-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-5 disabled:opacity-50 disabled:pointer-events-none transition-colors"
        >
          {generateModels.isPending ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Generating... (this may take ~20s)</>
          ) : (
            <><Sparkles className="w-4 h-4" /> Generate Models</>
          )}
        </button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
      ) : !models || models.length === 0 ? (
        <div className="bg-card border border-dashed border-border rounded-lg p-12 text-center">
          <Share2 className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
          <h3 className="font-semibold text-foreground mb-1">No Models Generated Yet</h3>
          <p className="text-sm text-muted-foreground">Extract variables from papers first, then generate model combinations.</p>
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
                    View Details <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                  {!model.selected && (
                    <button
                      data-testid={`button-select-model-${model.id}`}
                      onClick={() => handleSelect(model.id, model.name)}
                      disabled={selectModel.isPending}
                      className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium h-8 px-3 bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
                    >
                      Select
                    </button>
                  )}
                </div>
              </div>

              <div className="mb-4 bg-background/50 rounded-lg p-4 border border-border overflow-hidden">
                <ModelGraph nodes={model.nodes ?? []} edges={model.edges ?? []} />
              </div>

              <div className="border-t border-border pt-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Rationale</p>
                <p className="text-sm text-muted-foreground leading-relaxed">{model.rationale}</p>
              </div>

              {(model.edges ?? []).length > 0 && (
                <div className="border-t border-border pt-4 mt-4">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Evidence Sources</p>
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
                        +{(model.edges ?? []).length - 3} more evidence sources
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

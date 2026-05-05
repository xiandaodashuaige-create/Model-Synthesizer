import React, { useMemo, useState } from "react";
import { useParams, Link } from "wouter";
import {
  useListSessionModels,
  useGenerateModels,
  useSelectModel,
  useGetSessionLearningStats,
  getListSessionModelsQueryKey,
  getGetSessionSummaryQueryKey,
  getGetSessionQueryKey,
  getGetSessionLearningStatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Share2, Sparkles, CheckCircle, ArrowRight, BookOpen, Wand2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";

const TYPE_COLORS: Record<string, string> = {
  independent: "#2563eb",
  mediator: "#d97706",
  moderator: "#7c3aed",
  dependent: "#16a34a",
};

function ModelGraph({ nodes, edges, paperTagById }: {
  nodes: Array<{ variableId: number; variableName: string; type: string; paperId: number }>;
  edges: Array<{ fromVariableId: number; toVariableId: number; relationship: string; evidencePaperId: number }>;
  paperTagById: Map<number, string>;
}) {
  if (!nodes.length) return null;
  const NODE_W = 140;
  const NODE_H = 50;
  const ROW_GAP = 26;
  const COL_GAP = 70;
  const PAD_X = 20;
  const PAD_Y = 20;

  const typeOrder = ["independent", "mediator", "moderator", "dependent"];
  const grouped: Record<string, typeof nodes> = {};
  for (const n of nodes) {
    (grouped[n.type] ??= []).push(n);
  }
  const cols = typeOrder.filter((t) => grouped[t]?.length);

  // Dynamic SVG height = max column height
  const maxRows = Math.max(1, ...cols.map((c) => grouped[c].length));
  const HEIGHT = PAD_Y * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP;
  const WIDTH = PAD_X * 2 + cols.length * NODE_W + (cols.length - 1) * COL_GAP;

  const positions = new Map<number, { x: number; y: number }>();
  cols.forEach((type, colIdx) => {
    const ns = grouped[type] ?? [];
    const colX = PAD_X + colIdx * (NODE_W + COL_GAP) + NODE_W / 2;
    const totalH = ns.length * NODE_H + (ns.length - 1) * ROW_GAP;
    const startY = (HEIGHT - totalH) / 2;
    ns.forEach((node, rowIdx) => {
      positions.set(node.variableId, { x: colX, y: startY + rowIdx * (NODE_H + ROW_GAP) + NODE_H / 2 });
    });
  });

  // Group edges that share the same (from,to) so labels stack instead of overlapping.
  const edgeGroups = new Map<string, Array<{ edge: typeof edges[number]; idx: number }>>();
  edges.forEach((edge, i) => {
    const k = `${edge.fromVariableId}->${edge.toVariableId}`;
    (edgeGroups.get(k) ?? edgeGroups.set(k, []).get(k)!).push({ edge, idx: i });
  });

  return (
    <svg width="100%" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="overflow-visible" style={{ minHeight: HEIGHT }}>
      <defs>
        <marker id="arr-m" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
          <path d="M0,0 L0,6 L7,3 z" fill="currentColor" opacity={0.5} />
        </marker>
      </defs>

      {[...edgeGroups.values()].map((group) => {
        const first = group[0].edge;
        const from = positions.get(first.fromVariableId);
        const to = positions.get(first.toVariableId);
        if (!from || !to) return null;
        const fromX = from.x + NODE_W / 2;
        const toX = to.x - NODE_W / 2;
        const dx = toX - fromX;
        const dy = to.y - from.y;
        const len = Math.max(1, Math.hypot(dx, dy));
        // Perpendicular unit vector for label offset.
        const nx = -dy / len;
        const ny = dx / len;
        const midX = (fromX + toX) / 2;
        const midY = (from.y + to.y) / 2;
        return (
          <g key={`${first.fromVariableId}->${first.toVariableId}`}>
            <line x1={fromX} y1={from.y} x2={toX} y2={to.y}
              stroke="currentColor" strokeOpacity={0.3} strokeWidth={1.5}
              markerEnd="url(#arr-m)" />
            {group.map(({ edge }, gi) => {
              const tag = paperTagById.get(edge.evidencePaperId);
              if (!tag) return null;
              // Stack labels along the perpendicular direction so they don't overlap each other or the edge.
              const offset = 12 + gi * 16;
              const lx = midX + nx * offset;
              const ly = midY + ny * offset;
              return (
                <g key={gi} transform={`translate(${lx - 14}, ${ly - 7})`}>
                  <rect width={28} height={14} rx={3} fill="white" stroke="currentColor" strokeOpacity={0.4} strokeWidth={0.8} />
                  <text x={14} y={10} textAnchor="middle" fontSize={9} fontWeight={700} fill="#444">{tag}</text>
                </g>
              );
            })}
          </g>
        );
      })}

      {nodes.map((node) => {
        const pos = positions.get(node.variableId);
        if (!pos) return null;
        const color = TYPE_COLORS[node.type] ?? "#888";
        const tag = paperTagById.get(node.paperId);
        const label = node.variableName.length > 18 ? node.variableName.slice(0, 17) + "…" : node.variableName;
        return (
          <g key={node.variableId} transform={`translate(${pos.x - NODE_W / 2}, ${pos.y - NODE_H / 2})`}>
            <rect width={NODE_W} height={NODE_H} rx={6} fill={color} fillOpacity={0.1} stroke={color} strokeOpacity={0.45} strokeWidth={1.5} />
            <text x={NODE_W / 2} y={NODE_H / 2 - 2} textAnchor="middle" fontSize={10} fontWeight={600} fill={color}>
              {label}
            </text>
            {tag && (
              <g transform={`translate(${NODE_W / 2 - 14}, ${NODE_H - 14})`}>
                <rect width={28} height={11} rx={2} fill={color} fillOpacity={0.9} />
                <text x={14} y={8.5} textAnchor="middle" fontSize={7} fontWeight={700} fill="white">{tag}</text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
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

  const { data: models, isLoading } = useListSessionModels(sessionId, {
    query: { enabled: !!sessionId, queryKey: getListSessionModelsQueryKey(sessionId) },
  });
  const { data: learningStats } = useGetSessionLearningStats(sessionId, {
    query: { enabled: !!sessionId, queryKey: getGetSessionLearningStatsQueryKey(sessionId) },
  });

  const [userPrompt, setUserPrompt] = useState("");
  const [numModels, setNumModels] = useState(3);

  const handleGenerate = () => {
    generateModels.mutate({
      id: sessionId,
      data: {
        userPrompt: userPrompt.trim() || undefined,
        numModels,
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
                return (
                  <div className="mb-4 bg-background/50 rounded-lg p-4 border border-border overflow-hidden">
                    <ModelGraph nodes={nodes} edges={edges} paperTagById={paperTagById} />
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

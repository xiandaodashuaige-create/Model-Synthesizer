import React, { useState, useMemo } from "react";
import { useParams, Link } from "wouter";
import { ModelGraph, buildEdgeHTagMap, buildPaperTagMap } from "@/components/model-graph";
import {
  useListSessionModels,
  useGenerateModels,
  useSelectModel,
  useGetSessionLearningStats,
  useListSessionVariables,
  useImportLiveModelFromModel,
  getListSessionModelsQueryKey,
  getGetSessionSummaryQueryKey,
  getGetSessionQueryKey,
  getGetSessionLearningStatsQueryKey,
  getListSessionVariablesQueryKey,
  getGetLiveModelQueryKey,
} from "@workspace/api-client-react";
import { ModelAssistantChat } from "@/components/model-assistant-chat";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Share2, Sparkles, CheckCircle, ArrowRight, BookOpen, Wand2, GitBranch } from "lucide-react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";

// (ModelGraph + buildEdgeHTagMap + buildPaperTagMap moved to @/components/model-graph)
function HypothesisLegend({ items }: { items: Array<{ tag: string; from: string; to: string; rel: string; paperTag: string }> }) {
  if (!items.length) return null;
  const relSymbol: Record<string, string> = { positive: "→ (+)", negative: "→ (−)", moderates: "⇢ moderates", mediates: "→ mediates" };
  return (
    <div className="mt-3 pt-3 border-t border-border/60 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
      {items.map((h) => (
        <div key={h.tag} className="flex items-start gap-2 text-[11px] text-muted-foreground" data-testid={`legend-hypothesis-${h.tag}`}>
          <span className="shrink-0 inline-flex items-center justify-center min-w-[26px] h-4 px-1 rounded bg-violet-50 text-violet-800 text-[10px] font-bold border border-violet-200">
            {h.tag}
          </span>
          <span className="truncate" title={`${h.from} ${relSymbol[h.rel] ?? "→"} ${h.to}${h.paperTag ? ` (${h.paperTag})` : ""}`}>
            <span className="text-foreground">{h.from}</span>
            <span className="mx-1 text-muted-foreground">{relSymbol[h.rel] ?? "→"}</span>
            <span className="text-foreground">{h.to}</span>
            {h.paperTag && <span className="ml-1 text-muted-foreground">({h.paperTag})</span>}
          </span>
        </div>
      ))}
    </div>
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
  const importLiveModel = useImportLiveModelFromModel();
  const [, navigate] = useLocation();

  const { data: models, isLoading } = useListSessionModels(sessionId, {
    query: { enabled: !!sessionId, queryKey: getListSessionModelsQueryKey(sessionId) },
  });
  const { data: learningStats } = useGetSessionLearningStats(sessionId, {
    query: { enabled: !!sessionId, queryKey: getGetSessionLearningStatsQueryKey(sessionId) },
  });
  const { data: variables } = useListSessionVariables(sessionId, {
    query: { enabled: !!sessionId, queryKey: getListSessionVariablesQueryKey(sessionId) },
  });

  const [userPrompt, setUserPrompt] = useState("");
  const [numModels, setNumModels] = useState(3);
  const [focusVariableIds, setFocusVariableIds] = useState<number[]>([]);

  const variableNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const v of variables ?? []) m.set(v.id, v.name);
    return m;
  }, [variables]);

  const handleApplySuggestion = (s: { userPrompt: string; focusVariableIds: number[] }) => {
    setUserPrompt(s.userPrompt);
    setFocusVariableIds(s.focusVariableIds);
    // Trigger generation immediately with the suggested params.
    generateModels.mutate({
      id: sessionId,
      data: { userPrompt: s.userPrompt || undefined, numModels, focusVariableIds: s.focusVariableIds.length ? s.focusVariableIds : undefined },
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
        toast({ title: t("models.toast.failed" as any), description: t("models.toast.failedDesc" as any), variant: "destructive" });
      },
    });
  };

  const handleGenerate = () => {
    generateModels.mutate({
      id: sessionId,
      data: {
        userPrompt: userPrompt.trim() || undefined,
        numModels,
        focusVariableIds: focusVariableIds.length ? focusVariableIds : undefined,
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

  const handleUseAsBase = (modelId: number, name: string) => {
    importLiveModel.mutate(
      { id: sessionId, data: { modelId, replace: false } },
      {
        onSuccess: (detail) => {
          queryClient.invalidateQueries({ queryKey: getGetLiveModelQueryKey(sessionId) });
          toast({
            title: t("live.toast.imported" as any),
            description: t("live.toast.importedDesc" as any, {
              name,
              vars: detail.nodes.length,
              edges: detail.edges.length,
            }),
          });
          navigate(`/sessions/${sessionId}/live-model`);
        },
        onError: () => toast({ title: t("live.toast.failed" as any), variant: "destructive" }),
      },
    );
  };

  const handleSelect = (modelId: number, name: string) => {
    selectModel.mutate({ id: modelId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSessionModelsQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
        // "选用" semantically promotes this model to be the user's working model — also
        // import its nodes/edges into the live model (replacing previous content) so the
        // "我的研究模型" page actually reflects the choice.
        importLiveModel.mutate(
          { id: sessionId, data: { modelId, replace: true } },
          {
            onSuccess: (detail) => {
              queryClient.invalidateQueries({ queryKey: getGetLiveModelQueryKey(sessionId) });
              toast({
                title: t("models.toast.selected" as any),
                description: t("live.toast.importedDesc" as any, {
                  name,
                  vars: detail.nodes.length,
                  edges: detail.edges.length,
                }),
              });
            },
            onError: () => {
              toast({
                title: t("models.toast.selected" as any),
                description: t("live.toast.failed" as any),
                variant: "destructive",
              });
            },
          },
        );
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

      {/* AI assistant chat */}
      <ModelAssistantChat
        sessionId={sessionId}
        variableNameById={variableNameById}
        onApplySuggestion={handleApplySuggestion}
      />

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
                  <button
                    data-testid={`button-use-as-base-${model.id}`}
                    onClick={() => handleUseAsBase(model.id, model.name)}
                    disabled={importLiveModel.isPending}
                    title={t("models.useAsBase.tip" as any)}
                    className="inline-flex items-center gap-1.5 rounded-md text-xs font-semibold h-8 px-3 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    <GitBranch className="w-3.5 h-3.5" />
                    {t("models.useAsBase" as any)}
                  </button>
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
                const paperTagById = buildPaperTagMap(nodes, edges);
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
                const edgeHTagByKey = buildEdgeHTagMap(edges);
                const hLegend = edges.map((e, i) => ({
                  tag: `H${i + 1}`,
                  from: nodes.find((n) => n.variableId === e.fromVariableId)?.variableName ?? `#${e.fromVariableId}`,
                  to: nodes.find((n) => n.variableId === e.toVariableId)?.variableName ?? `#${e.toVariableId}`,
                  rel: e.relationship,
                  paperTag: paperTagById.get(e.evidencePaperId) ?? "",
                }));
                return (
                  <div className="mb-4 bg-background/50 rounded-lg p-4 border border-border overflow-hidden">
                    <ModelGraph nodes={nodes} edges={edges} paperTagById={paperTagById} edgeHTagByKey={edgeHTagByKey} />
                    <HypothesisLegend items={hLegend} />
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

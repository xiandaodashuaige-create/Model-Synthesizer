import React from "react";
import { useParams, Link } from "wouter";
import {
  useGetModel,
  useSelectModel,
  getGetModelQueryKey,
  getListSessionModelsQueryKey,
  getGetSessionSummaryQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, ArrowLeft, CheckCircle, BookOpen, Quote, Share2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const TYPE_META: Record<string, { label: string; color: string; bg: string; border: string; dot: string }> = {
  independent: { label: "Independent", color: "text-blue-700 dark:text-blue-300", bg: "bg-blue-50 dark:bg-blue-950/40", border: "border-blue-200 dark:border-blue-800", dot: "bg-blue-500" },
  mediator: { label: "Mediator", color: "text-amber-700 dark:text-amber-300", bg: "bg-amber-50 dark:bg-amber-950/40", border: "border-amber-200 dark:border-amber-800", dot: "bg-amber-500" },
  moderator: { label: "Moderator", color: "text-purple-700 dark:text-purple-300", bg: "bg-purple-50 dark:bg-purple-950/40", border: "border-purple-200 dark:border-purple-800", dot: "bg-purple-500" },
  dependent: { label: "Dependent", color: "text-green-700 dark:text-green-300", bg: "bg-green-50 dark:bg-green-950/40", border: "border-green-200 dark:border-green-800", dot: "bg-green-500" },
};

export default function SessionModelDetail({ params: routeParams }: { params?: { id?: string; modelId?: string } }) {
  const params = useParams<{ id: string; modelId: string }>();
  const sessionId = parseInt(routeParams?.id ?? params.id ?? "0", 10);
  const modelId = parseInt(routeParams?.modelId ?? params.modelId ?? "0", 10);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const selectModel = useSelectModel();
  const { data: model, isLoading } = useGetModel(modelId, {
    query: { enabled: !!modelId, queryKey: getGetModelQueryKey(modelId) }
  });

  const handleSelect = () => {
    if (!model) return;
    selectModel.mutate({ id: modelId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetModelQueryKey(modelId) });
        queryClient.invalidateQueries({ queryKey: getListSessionModelsQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
        toast({ title: "Model selected", description: `"${model.name}" is now your selected research model.` });
      },
    });
  };

  if (isLoading) return <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  if (!model) return (
    <div className="text-center py-16">
      <p className="text-muted-foreground">Model not found.</p>
      <Link href={`/sessions/${sessionId}/models`} className="text-primary hover:underline text-sm mt-2 inline-block">Back to Models</Link>
    </div>
  );

  const nodesByType = (model.nodes ?? []).reduce<Record<string, typeof model.nodes>>((acc, n) => {
    if (!acc[n.type]) acc[n.type] = [];
    acc[n.type].push(n);
    return acc;
  }, {});

  const typeOrder = ["independent", "mediator", "moderator", "dependent"];

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="flex items-start gap-4">
        <Link href={`/sessions/${sessionId}/models`} className="mt-1 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0">
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <Share2 className="w-5 h-5 text-primary" />
            {model.selected && <CheckCircle className="w-5 h-5 text-primary" />}
            <h1 className="text-2xl font-serif font-bold text-foreground">{model.name}</h1>
          </div>
          <p className="text-muted-foreground leading-relaxed">{model.description}</p>
        </div>
        {!model.selected && (
          <button
            data-testid="button-select-model"
            onClick={handleSelect}
            disabled={selectModel.isPending}
            className="shrink-0 inline-flex items-center gap-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-5 disabled:opacity-50"
          >
            {selectModel.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            Select This Model
          </button>
        )}
        {model.selected && (
          <span className="shrink-0 inline-flex items-center gap-2 rounded-md text-sm font-medium bg-primary/10 text-primary border border-primary/20 h-10 px-4">
            <CheckCircle className="w-4 h-4" /> Selected
          </span>
        )}
      </div>

      {/* Rationale */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">Theoretical Rationale</h2>
        <p className="text-sm text-foreground leading-relaxed">{model.rationale}</p>
      </div>

      {/* Variables */}
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-4">Model Variables</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {typeOrder.filter((t) => nodesByType[t]?.length).map((type) => {
            const meta = TYPE_META[type]!;
            return (
              <div key={type} className={`bg-card border rounded-lg p-5 ${meta.border}`}>
                <p className={`text-xs font-semibold uppercase tracking-wider mb-3 ${meta.color}`}>{meta.label}</p>
                <div className="space-y-3">
                  {nodesByType[type].map((node) => (
                    <div key={node.variableId} data-testid={`card-model-node-${node.variableId}`} className={`rounded-md p-3 ${meta.bg} border ${meta.border}`}>
                      <p className={`text-sm font-medium ${meta.color}`}>{node.variableName}</p>
                      <div className="flex items-center gap-1.5 mt-1.5 text-xs text-muted-foreground">
                        <BookOpen className="w-3 h-3 shrink-0" />
                        <span className="line-clamp-1">{node.paperTitle}</span>
                        {node.paperYear && <span>· {node.paperYear}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Relationships with Evidence */}
      {(model.edges ?? []).length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-foreground mb-4">Variable Relationships & Evidence</h2>
          <div className="space-y-4">
            {(model.edges ?? []).map((edge, i) => (
              <div key={i} data-testid={`card-model-edge-${i}`} className="bg-card border border-border rounded-lg p-5">
                <div className="flex items-center gap-3 mb-4">
                  <span className="text-sm font-semibold text-foreground">{edge.fromVariableName}</span>
                  <div className="flex-1 flex items-center gap-2">
                    <div className="flex-1 h-px bg-border" />
                    <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full border border-border">{edge.relationship}</span>
                    <div className="flex-1 h-px bg-border" />
                  </div>
                  <span className="text-sm font-semibold text-foreground">{edge.toVariableName}</span>
                </div>
                <div className="bg-muted/40 rounded-md p-4 border border-border">
                  <div className="flex items-start gap-2 mb-3">
                    <Quote className="w-4 h-4 text-primary/60 shrink-0 mt-0.5" />
                    <p className="text-sm text-muted-foreground italic leading-relaxed">{edge.evidenceCitationText}</p>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground border-t border-border pt-3">
                    <BookOpen className="w-3.5 h-3.5 text-primary/60 shrink-0" />
                    <span className="font-medium text-foreground">{edge.evidencePaperTitle}</span>
                    {(edge.evidencePaperAuthors ?? []).length > 0 && (
                      <span>· {(edge.evidencePaperAuthors ?? []).slice(0, 2).join(", ")}{(edge.evidencePaperAuthors ?? []).length > 2 ? " et al." : ""}</span>
                    )}
                    {edge.evidencePaperYear && <span>· {edge.evidencePaperYear}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

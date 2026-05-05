import React, { useState, useMemo } from "react";
import { useParams, Link } from "wouter";
import {
  useGetModel,
  useSelectModel,
  useUpdateModel,
  useListSessionVariables,
  getGetModelQueryKey,
  getListSessionModelsQueryKey,
  getListSessionVariablesQueryKey,
  getGetSessionSummaryQueryKey,
  getGetSessionLearningStatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, ArrowLeft, CheckCircle, BookOpen, Quote, Share2, Pencil, Save, X, Trash2, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";

interface NodeT {
  variableId: number;
  variableName: string;
  type: string;
  paperId: number;
  paperTitle: string;
  paperAuthors: string[];
  paperYear: number | null;
}
interface EdgeT {
  fromVariableId: number;
  toVariableId: number;
  fromVariableName: string;
  toVariableName: string;
  relationship: string;
  evidencePaperId: number;
  evidencePaperTitle: string;
  evidencePaperAuthors: string[];
  evidencePaperYear: number | null;
  evidenceCitationText: string;
}

function useTypeMeta() {
  const { t } = useT();
  return {
    independent: { label: t("vars.type.independent" as any), color: "text-blue-700 dark:text-blue-300", bg: "bg-blue-50 dark:bg-blue-950/40", border: "border-blue-200 dark:border-blue-800", dot: "bg-blue-500" },
    mediator: { label: t("vars.type.mediator" as any), color: "text-amber-700 dark:text-amber-300", bg: "bg-amber-50 dark:bg-amber-950/40", border: "border-amber-200 dark:border-amber-800", dot: "bg-amber-500" },
    moderator: { label: t("vars.type.moderator" as any), color: "text-purple-700 dark:text-purple-300", bg: "bg-purple-50 dark:bg-purple-950/40", border: "border-purple-200 dark:border-purple-800", dot: "bg-purple-500" },
    dependent: { label: t("vars.type.dependent" as any), color: "text-green-700 dark:text-green-300", bg: "bg-green-50 dark:bg-green-950/40", border: "border-green-200 dark:border-green-800", dot: "bg-green-500" },
  } as Record<string, { label: string; color: string; bg: string; border: string; dot: string }>;
}

const REL_OPTIONS = ["positive", "negative", "moderates", "mediates"] as const;

export default function SessionModelDetail({ params: routeParams }: { params?: { id?: string; modelId?: string } }) {
  const { t } = useT();
  const TYPE_META = useTypeMeta();
  const params = useParams<{ id: string; modelId: string }>();
  const sessionId = parseInt(routeParams?.id ?? params.id ?? "0", 10);
  const modelId = parseInt(routeParams?.modelId ?? params.modelId ?? "0", 10);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const selectModel = useSelectModel();
  const updateModel = useUpdateModel();
  const { data: model, isLoading } = useGetModel(modelId, {
    query: { enabled: !!modelId, queryKey: getGetModelQueryKey(modelId) },
  });
  const { data: sessionVars } = useListSessionVariables(sessionId, {
    query: { enabled: !!sessionId, queryKey: getListSessionVariablesQueryKey(sessionId) },
  });

  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftRationale, setDraftRationale] = useState("");
  const [draftNodes, setDraftNodes] = useState<NodeT[]>([]);
  const [draftEdges, setDraftEdges] = useState<EdgeT[]>([]);
  const [newEdgeFrom, setNewEdgeFrom] = useState<string>("");
  const [newEdgeTo, setNewEdgeTo] = useState<string>("");
  const [newEdgeRel, setNewEdgeRel] = useState<string>("positive");
  const [newEdgeEvidence, setNewEdgeEvidence] = useState("");

  const startEdit = () => {
    if (!model) return;
    setDraftName(model.name);
    setDraftDescription(model.description);
    setDraftRationale(model.rationale);
    setDraftNodes(((model.nodes ?? []) as NodeT[]).map((n) => ({ ...n })));
    setDraftEdges(((model.edges ?? []) as EdgeT[]).map((e) => ({ ...e })));
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setNewEdgeFrom(""); setNewEdgeTo(""); setNewEdgeRel("positive"); setNewEdgeEvidence("");
  };

  const saveEdit = () => {
    if (!model) return;
    updateModel.mutate({
      id: modelId,
      data: {
        name: draftName,
        description: draftDescription,
        rationale: draftRationale,
        nodes: draftNodes as unknown as Record<string, unknown>[],
        edges: draftEdges as unknown as Record<string, unknown>[],
      },
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetModelQueryKey(modelId) });
        queryClient.invalidateQueries({ queryKey: getListSessionModelsQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetSessionLearningStatsQueryKey(sessionId) });
        setEditing(false);
        toast({ title: t("md.editToast.saved" as any), description: t("md.editToast.savedDesc" as any) });
      },
      onError: () => {
        toast({ title: t("md.editToast.failed" as any), variant: "destructive" });
      },
    });
  };

  const handleSelect = () => {
    if (!model) return;
    selectModel.mutate({ id: modelId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetModelQueryKey(modelId) });
        queryClient.invalidateQueries({ queryKey: getListSessionModelsQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetSessionLearningStatsQueryKey(sessionId) });
        toast({
          title: t("models.toast.selected" as any),
          description: t("models.toast.selectedDesc" as any, { name: model.name }),
        });
      },
    });
  };

  const deleteEdge = (idx: number) => setDraftEdges((cur) => cur.filter((_, i) => i !== idx));
  const updateEdge = (idx: number, patch: Partial<EdgeT>) =>
    setDraftEdges((cur) => cur.map((e, i) => i === idx ? { ...e, ...patch } : e));

  const deleteNode = (variableId: number) => {
    setDraftNodes((cur) => cur.filter((n) => n.variableId !== variableId));
    setDraftEdges((cur) => cur.filter((e) => e.fromVariableId !== variableId && e.toVariableId !== variableId));
  };

  const availableNodesForNewEdge = useMemo(() => draftNodes, [draftNodes]);

  const addEdge = () => {
    const from = parseInt(newEdgeFrom, 10);
    const to = parseInt(newEdgeTo, 10);
    if (!from || !to || from === to || !newEdgeEvidence.trim()) {
      toast({ title: t("md.addEdge.invalid" as any), variant: "destructive" });
      return;
    }
    const fromN = draftNodes.find((n) => n.variableId === from);
    const toN = draftNodes.find((n) => n.variableId === to);
    if (!fromN || !toN) return;
    const evidenceFrom = fromN; // attribute evidence to the source-side paper
    setDraftEdges((cur) => [...cur, {
      fromVariableId: from,
      toVariableId: to,
      fromVariableName: fromN.variableName,
      toVariableName: toN.variableName,
      relationship: newEdgeRel,
      evidencePaperId: evidenceFrom.paperId,
      evidencePaperTitle: evidenceFrom.paperTitle,
      evidencePaperAuthors: evidenceFrom.paperAuthors,
      evidencePaperYear: evidenceFrom.paperYear,
      evidenceCitationText: newEdgeEvidence.trim(),
    }]);
    setNewEdgeFrom(""); setNewEdgeTo(""); setNewEdgeRel("positive"); setNewEdgeEvidence("");
  };

  if (isLoading) return <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  if (!model) return (
    <div className="text-center py-16">
      <p className="text-muted-foreground">{t("md.notFound" as any)}</p>
      <Link href={`/sessions/${sessionId}/models`} className="text-primary hover:underline text-sm mt-2 inline-block">{t("md.backToList" as any)}</Link>
    </div>
  );

  const displayNodes = editing ? draftNodes : ((model.nodes ?? []) as NodeT[]);
  const displayEdges = editing ? draftEdges : ((model.edges ?? []) as EdgeT[]);

  const nodesByType = displayNodes.reduce<Record<string, NodeT[]>>((acc, n) => {
    (acc[n.type] ??= []).push(n);
    return acc;
  }, {});

  const typeOrder = ["independent", "mediator", "moderator", "dependent"];

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="flex items-start gap-4">
        <Link href={`/sessions/${sessionId}/models`} className="mt-1 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0">
          <ArrowLeft className="w-4 h-4" /> {t("md.back" as any)}
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <Share2 className="w-5 h-5 text-primary" />
            {model.selected && <CheckCircle className="w-5 h-5 text-primary" />}
            {editing ? (
              <input
                data-testid="input-edit-name"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                className="text-2xl font-serif font-bold text-foreground bg-background border border-input rounded-md px-2 py-1 flex-1"
              />
            ) : (
              <h1 className="text-2xl font-serif font-bold text-foreground">{model.name}</h1>
            )}
            {editing && (
              <span className="ml-2 text-xs font-semibold uppercase tracking-wider text-amber-700 bg-amber-100 border border-amber-200 px-2 py-0.5 rounded">
                {t("md.editing" as any)}
              </span>
            )}
          </div>
          {editing ? (
            <textarea
              data-testid="textarea-edit-description"
              value={draftDescription}
              onChange={(e) => setDraftDescription(e.target.value)}
              rows={2}
              className="w-full text-sm text-muted-foreground bg-background border border-input rounded-md px-2 py-1.5 leading-relaxed"
            />
          ) : (
            <p className="text-muted-foreground leading-relaxed">{model.description}</p>
          )}
        </div>
        <div className="flex flex-col gap-2 shrink-0">
          {!editing && (
            <button
              data-testid="button-edit-model"
              onClick={startEdit}
              className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium border border-border bg-background hover:bg-accent h-9 px-3 transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" /> {t("md.edit" as any)}
            </button>
          )}
          {editing && (
            <>
              <button
                data-testid="button-save-edits"
                onClick={saveEdit}
                disabled={updateModel.isPending}
                className="inline-flex items-center gap-1.5 rounded-md text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-4 disabled:opacity-50"
              >
                {updateModel.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {updateModel.isPending ? t("md.saving" as any) : t("md.saveEdits" as any)}
              </button>
              <button
                data-testid="button-cancel-edits"
                onClick={cancelEdit}
                className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium border border-border bg-background hover:bg-accent h-9 px-3"
              >
                <X className="w-3.5 h-3.5" /> {t("md.cancelEdits" as any)}
              </button>
            </>
          )}
          {!editing && !model.selected && (
            <button
              data-testid="button-select-model"
              onClick={handleSelect}
              disabled={selectModel.isPending}
              className="inline-flex items-center gap-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-5 disabled:opacity-50"
            >
              {selectModel.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {t("md.select" as any)}
            </button>
          )}
          {!editing && model.selected && (
            <span className="inline-flex items-center gap-2 rounded-md text-sm font-medium bg-primary/10 text-primary border border-primary/20 h-10 px-4">
              <CheckCircle className="w-4 h-4" /> {t("md.selected" as any)}
            </span>
          )}
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">{t("md.rationale" as any)}</h2>
        {editing ? (
          <textarea
            data-testid="textarea-edit-rationale"
            value={draftRationale}
            onChange={(e) => setDraftRationale(e.target.value)}
            rows={6}
            className="w-full text-sm text-foreground bg-background border border-input rounded-md px-3 py-2 leading-relaxed"
          />
        ) : (
          <p className="text-sm text-foreground leading-relaxed">{model.rationale}</p>
        )}
      </div>

      <div>
        <h2 className="text-lg font-semibold text-foreground mb-4">{t("md.variables" as any)}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {typeOrder.filter((tp) => nodesByType[tp]?.length).map((type) => {
            const meta = TYPE_META[type]!;
            return (
              <div key={type} className={`bg-card border rounded-lg p-5 ${meta.border}`}>
                <p className={`text-xs font-semibold uppercase tracking-wider mb-3 ${meta.color}`}>{meta.label}</p>
                <div className="space-y-3">
                  {nodesByType[type].map((node) => (
                    <div key={node.variableId} data-testid={`card-model-node-${node.variableId}`} className={`rounded-md p-3 ${meta.bg} border ${meta.border} relative`}>
                      <p className={`text-sm font-medium ${meta.color}`}>{node.variableName}</p>
                      <div className="flex items-center gap-1.5 mt-1.5 text-xs text-muted-foreground">
                        <BookOpen className="w-3 h-3 shrink-0" />
                        <span className="line-clamp-1">{node.paperTitle}</span>
                        {node.paperYear && <span>· {node.paperYear}</span>}
                      </div>
                      {editing && (
                        <button
                          data-testid={`button-delete-node-${node.variableId}`}
                          onClick={() => deleteNode(node.variableId)}
                          className="absolute top-2 right-2 text-xs inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-red-600 hover:bg-red-50"
                          title={t("md.deleteNode" as any)}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {(displayEdges.length > 0 || editing) && (
        <div>
          <h2 className="text-lg font-semibold text-foreground mb-4">{t("md.relations" as any)}</h2>
          <div className="space-y-4">
            {displayEdges.map((edge, i) => (
              <div key={i} data-testid={`card-model-edge-${i}`} className="bg-card border border-border rounded-lg p-5">
                <div className="flex items-center gap-3 mb-4">
                  <span className="text-sm font-semibold text-foreground">{edge.fromVariableName}</span>
                  <div className="flex-1 flex items-center gap-2">
                    <div className="flex-1 h-px bg-border" />
                    {editing ? (
                      <select
                        data-testid={`select-edge-rel-${i}`}
                        value={edge.relationship}
                        onChange={(e) => updateEdge(i, { relationship: e.target.value })}
                        className="text-xs rounded-md border border-input bg-background px-2 py-1"
                      >
                        {REL_OPTIONS.map((r) => (
                          <option key={r} value={r}>{t(`md.rel.${r}` as any)}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full border border-border">{edge.relationship}</span>
                    )}
                    <div className="flex-1 h-px bg-border" />
                  </div>
                  <span className="text-sm font-semibold text-foreground">{edge.toVariableName}</span>
                  {editing && (
                    <button
                      data-testid={`button-delete-edge-${i}`}
                      onClick={() => deleteEdge(i)}
                      className="ml-2 text-xs inline-flex items-center gap-1 px-2 py-1 rounded text-red-600 hover:bg-red-50"
                      title={t("md.deleteEdge" as any)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="bg-muted/40 rounded-md p-4 border border-border">
                  <div className="flex items-start gap-2 mb-3">
                    <Quote className="w-4 h-4 text-primary/60 shrink-0 mt-0.5" />
                    {editing ? (
                      <textarea
                        data-testid={`textarea-edge-evidence-${i}`}
                        value={edge.evidenceCitationText}
                        onChange={(e) => updateEdge(i, { evidenceCitationText: e.target.value })}
                        rows={2}
                        className="flex-1 text-sm text-foreground bg-background border border-input rounded-md px-2 py-1 italic leading-relaxed"
                      />
                    ) : (
                      <p className="text-sm text-muted-foreground italic leading-relaxed">{edge.evidenceCitationText}</p>
                    )}
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

            {editing && availableNodesForNewEdge.length >= 2 && (
              <div className="bg-card border border-dashed border-border rounded-lg p-5 space-y-3">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Plus className="w-4 h-4" /> {t("md.addEdge" as any)}
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground block mb-1">{t("md.addEdge.from" as any)}</label>
                    <select
                      data-testid="select-new-edge-from"
                      value={newEdgeFrom}
                      onChange={(e) => setNewEdgeFrom(e.target.value)}
                      className="w-full text-xs rounded-md border border-input bg-background px-2 py-1.5"
                    >
                      <option value="">—</option>
                      {availableNodesForNewEdge.map((n) => (
                        <option key={n.variableId} value={n.variableId}>{n.variableName}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground block mb-1">{t("md.addEdge.to" as any)}</label>
                    <select
                      data-testid="select-new-edge-to"
                      value={newEdgeTo}
                      onChange={(e) => setNewEdgeTo(e.target.value)}
                      className="w-full text-xs rounded-md border border-input bg-background px-2 py-1.5"
                    >
                      <option value="">—</option>
                      {availableNodesForNewEdge.map((n) => (
                        <option key={n.variableId} value={n.variableId}>{n.variableName}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground block mb-1">{t("md.addEdge.relationship" as any)}</label>
                    <select
                      data-testid="select-new-edge-rel"
                      value={newEdgeRel}
                      onChange={(e) => setNewEdgeRel(e.target.value)}
                      className="w-full text-xs rounded-md border border-input bg-background px-2 py-1.5"
                    >
                      {REL_OPTIONS.map((r) => (
                        <option key={r} value={r}>{t(`md.rel.${r}` as any)}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground block mb-1">{t("md.addEdge.evidence" as any)}</label>
                  <textarea
                    data-testid="textarea-new-edge-evidence"
                    value={newEdgeEvidence}
                    onChange={(e) => setNewEdgeEvidence(e.target.value)}
                    rows={2}
                    className="w-full text-sm rounded-md border border-input bg-background px-3 py-2"
                  />
                </div>
                <div className="flex justify-end">
                  <button
                    data-testid="button-add-new-edge"
                    onClick={addEdge}
                    className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 h-8 px-3"
                  >
                    <Plus className="w-3.5 h-3.5" /> {t("md.addEdge.confirm" as any)}
                  </button>
                </div>
                {sessionVars && sessionVars.length > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    {sessionVars.length} variables available in this session — only those already in this model are shown above. Delete a node and add a fresh one if you need a different variable.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

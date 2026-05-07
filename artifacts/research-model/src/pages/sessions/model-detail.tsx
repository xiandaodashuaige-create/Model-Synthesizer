import React, { useState, useMemo, useEffect } from "react";
import { useParams, Link, useLocation } from "wouter";
import {
  useGetModel,
  useSelectModel,
  useUpdateModel,
  useListSessionVariables,
  useGetModelQualityReport,
  useGenerateModelLiteratureReview,
  useGetPaperModelFigures,
  useImportLiveModelFromModel,
  useGetLiveModel,
  getGetModelQueryKey,
  getListSessionModelsQueryKey,
  getListSessionVariablesQueryKey,
  getGetSessionSummaryQueryKey,
  getGetSessionLearningStatsQueryKey,
  getGetModelQualityReportQueryKey,
  getGetPaperModelFiguresQueryKey,
  getGetLiveModelQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, ArrowLeft, CheckCircle, BookOpen, Quote, Share2, Pencil, Save, X, Trash2, Plus, Download, Hash, BarChart3, MapPin, Info, FileText, AlertTriangle, Copy as CopyIcon, GitBranch, Image as ImageIcon, ChevronDown, ChevronUp, ExternalLink, Sparkles } from "lucide-react";
import { ModelGraph, buildEdgeHTagMap, buildPaperTagMap } from "@/components/model-graph";
import { EditableModelGraph } from "@/components/editable-model-graph";
import { EvidenceMatchDialog } from "@/components/evidence-match-dialog";
import { InnovationMetaPanel } from "@/components/innovation-meta-panel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  evidenceHypothesisId?: string | null;
  effectSize?: string | null;
  evidenceLocation?: string | null;
  moderatorJustification?: string | null;
}

// APA-7 reference string for a paper used as edge evidence.
function formatApaReference(authors: string[], year: number | null, title: string): string {
  const safeAuthors = (authors ?? []).filter(Boolean);
  let authorStr = "Unknown";
  if (safeAuthors.length === 1) authorStr = safeAuthors[0];
  else if (safeAuthors.length === 2) authorStr = `${safeAuthors[0]} & ${safeAuthors[1]}`;
  else if (safeAuthors.length >= 3) authorStr = `${safeAuthors[0]} et al.`;
  const yr = year ? `(${year})` : "(n.d.)";
  return `${authorStr} ${yr}. ${title}.`;
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

// Lazy per-paper model figure thumbnails. Only fetches when expanded.
// Compact: max 3 thumbnails, ~96px tall. Clicking a thumbnail opens an
// in-app lightbox showing the full-size image (no navigation away from the
// page); the lightbox itself offers a separate "open source page" link.
type PaperFigure = { title: string; thumbnailUrl: string; imageUrl?: string; sourceUrl: string; sourceDomain: string };

function PaperFigures({ sessionId, paperId, edgeIndex }: { sessionId: number; paperId: number; edgeIndex: number }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [lightbox, setLightbox] = useState<PaperFigure | null>(null);

  // Lock background scroll + ESC-to-close while the lightbox is open.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLightbox(null); };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [lightbox]);

  const { data, isFetching, error } = useGetPaperModelFigures(
    sessionId,
    paperId,
    {},
    {
      query: {
        enabled: open && !!sessionId && !!paperId,
        queryKey: getGetPaperModelFiguresQueryKey(sessionId, paperId, {}),
        staleTime: 24 * 60 * 60 * 1000,
      },
    },
  );

  const results = (data?.results ?? []) as PaperFigure[];

  return (
    <div className="mt-3 border-t border-border pt-3">
      <button
        type="button"
        data-testid={`button-show-paper-figures-${edgeIndex}`}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ImageIcon className="w-3.5 h-3.5" />
        <span>{t("md.figures.title" as any)}</span>
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>
      {open && (
        <div className="mt-2" data-testid={`panel-paper-figures-${edgeIndex}`}>
          {isFetching && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> {t("md.figures.loading" as any)}</div>
          )}
          {!isFetching && error && (
            <div className="text-xs text-amber-700">{t("md.figures.error" as any)}</div>
          )}
          {!isFetching && !error && results.length === 0 && (
            <div className="text-xs text-muted-foreground italic">{t("md.figures.empty" as any)}</div>
          )}
          {!isFetching && results.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {results.map((fig, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setLightbox(fig)}
                  data-testid={`button-paper-figure-${edgeIndex}-${idx}`}
                  title={t("md.figures.zoomHint" as any) as string}
                  className="group relative block border border-border rounded-md overflow-hidden bg-background hover:border-primary/60 transition-colors cursor-zoom-in"
                  style={{ width: 132, height: 96 }}
                >
                  <img
                    src={fig.thumbnailUrl}
                    alt={fig.title || "model figure"}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                    onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }}
                  />
                  <span className="absolute bottom-0 inset-x-0 bg-black/55 text-white text-[10px] px-1.5 py-0.5 truncate opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1">
                    <ImageIcon className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate">{t("md.figures.zoomHint" as any)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* In-app lightbox: full-size image, ESC / overlay / × to close. */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightbox(null)}
          data-testid={`dialog-figure-lightbox-${edgeIndex}`}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="relative flex flex-col max-w-[95vw] max-h-[95vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={lightbox.imageUrl || lightbox.thumbnailUrl}
              alt={lightbox.title || "model figure"}
              referrerPolicy="no-referrer"
              className="max-w-[95vw] max-h-[85vh] object-contain rounded-md bg-white shadow-2xl"
              data-testid={`img-figure-lightbox-${edgeIndex}`}
              onError={(e) => {
                // Fall back to the thumbnail if the full-size image fails to load.
                const img = e.currentTarget;
                if (lightbox.imageUrl && img.src !== lightbox.thumbnailUrl) img.src = lightbox.thumbnailUrl;
              }}
            />
            <div className="mt-2 flex items-center justify-between gap-3 text-xs text-white/90">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium" title={lightbox.title}>{lightbox.title || "—"}</div>
                <div className="text-white/60">{lightbox.sourceDomain}</div>
              </div>
              <a
                href={lightbox.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 rounded-md bg-white/10 hover:bg-white/20 px-2 py-1 transition-colors"
                data-testid={`link-figure-source-${edgeIndex}`}
              >
                <ExternalLink className="w-3 h-3" /> {t("md.figures.openSource" as any)}
              </a>
            </div>
            <button
              type="button"
              onClick={() => setLightbox(null)}
              aria-label={t("md.figures.close" as any) as string}
              data-testid={`button-close-figure-lightbox-${edgeIndex}`}
              className="absolute -top-3 -right-3 rounded-full bg-white text-foreground shadow-lg p-1.5 hover:bg-accent transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SessionModelDetail({ params: routeParams }: { params?: { id?: string; modelId?: string } }) {
  const { t } = useT();
  const TYPE_META = useTypeMeta();
  const params = useParams<{ id: string; modelId: string }>();
  const sessionId = parseInt(routeParams?.id ?? params.id ?? "0", 10);
  const modelId = parseInt(routeParams?.modelId ?? params.modelId ?? "0", 10);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const selectModel = useSelectModel();
  const updateModel = useUpdateModel();
  const importLiveModel = useImportLiveModelFromModel();
  const { data: model, isLoading } = useGetModel(modelId, {
    query: { enabled: !!modelId, queryKey: getGetModelQueryKey(modelId) },
  });
  const { data: sessionVars } = useListSessionVariables(sessionId, {
    query: { enabled: !!sessionId, queryKey: getListSessionVariablesQueryKey(sessionId) },
  });
  // Mirror the list page guard: count manual edges in the live model so the
  // user is warned BEFORE they overwrite work they hand-curated. Without this
  // confirm dialog, clicking "选用此模型" silently nukes everything they
  // dragged in on the "我的研究模型" page.
  const { data: liveModel } = useGetLiveModel(sessionId, {
    query: { enabled: !!sessionId, queryKey: getGetLiveModelQueryKey(sessionId) },
  });
  const manualEdgeCount = (liveModel?.edges ?? []).filter((e) => e.userAdded).length;
  const [pendingSelectOpen, setPendingSelectOpen] = useState(false);

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
  // Empty string ("auto") = "default to source-side paper", as before. Any
  // numeric value = the paperId the user explicitly picked as the citation
  // for this manual edge.
  const [newEdgePaperId, setNewEdgePaperId] = useState<string>("");
  // Canvas drag-to-connect → opens a small modal to capture the required evidence quote.
  const [pendingCanvasEdge, setPendingCanvasEdge] = useState<{ from: number; to: number } | null>(null);

  const [evidenceOpen, setEvidenceOpen] = useState(false);
  // Lit review dialog state
  const [litOpen, setLitOpen] = useState(false);
  const [litMd, setLitMd] = useState<string>("");
  const [litCopied, setLitCopied] = useState(false);
  const litReviewMut = useGenerateModelLiteratureReview();

  // Quality report
  const { data: qualityReport } = useGetModelQualityReport(modelId, {
    query: { enabled: !!modelId, queryKey: getGetModelQualityReportQueryKey(modelId) },
  });

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
    setPendingCanvasEdge(null);
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
    if (manualEdgeCount > 0) {
      setPendingSelectOpen(true);
      return;
    }
    doSelect();
  };

  const doSelect = () => {
    if (!model) return;
    selectModel.mutate({ id: modelId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetModelQueryKey(modelId) });
        queryClient.invalidateQueries({ queryKey: getListSessionModelsQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetSessionLearningStatsQueryKey(sessionId) });
        // Promote to live model so "我的研究模型" actually reflects the user's choice.
        importLiveModel.mutate(
          { id: sessionId, data: { modelId, replace: true } },
          {
            onSuccess: (detail) => {
              queryClient.invalidateQueries({ queryKey: getGetLiveModelQueryKey(sessionId) });
              toast({
                title: t("models.toast.selected" as any),
                description: t("live.toast.importedDesc" as any, {
                  name: model.name,
                  vars: detail.nodes.length,
                  edges: detail.edges.length,
                }),
              });
              // Auto-navigate to /live-model so the user lands where their
              // newly-promoted model is actually rendered, instead of staying
              // on the read-only candidate detail page (the "选用" felt like
              // a no-op pre-fix because nothing visible changed on screen).
              if (Number.isFinite(sessionId) && sessionId > 0) {
                navigate(`/sessions/${sessionId}/live-model`);
              }
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
    // Evidence paper resolution:
    //   1. If the user explicitly picked one in the dropdown, use that.
    //   2. Otherwise default to the source-side node's paper (legacy behavior).
    // Looking the picked id up against draftNodes lets us reuse the paper
    // metadata (authors / year / title) we already loaded — no extra fetch.
    let evidence = fromN as NodeT;
    if (newEdgePaperId) {
      const pid = parseInt(newEdgePaperId, 10);
      const picked = draftNodes.find((n) => n.paperId === pid);
      if (picked) evidence = picked;
    }
    setDraftEdges((cur) => [...cur, {
      fromVariableId: from,
      toVariableId: to,
      fromVariableName: fromN.variableName,
      toVariableName: toN.variableName,
      relationship: newEdgeRel,
      evidencePaperId: evidence.paperId,
      evidencePaperTitle: evidence.paperTitle,
      evidencePaperAuthors: evidence.paperAuthors,
      evidencePaperYear: evidence.paperYear,
      evidenceCitationText: newEdgeEvidence.trim(),
    }]);
    setNewEdgeFrom(""); setNewEdgeTo(""); setNewEdgeRel("positive"); setNewEdgeEvidence(""); setNewEdgePaperId("");
    setPendingCanvasEdge(null);
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

  const exportApaReferences = () => {
    const seen = new Map<number, { authors: string[]; year: number | null; title: string }>();
    for (const e of displayEdges) {
      if (!seen.has(e.evidencePaperId)) {
        seen.set(e.evidencePaperId, { authors: e.evidencePaperAuthors, year: e.evidencePaperYear, title: e.evidencePaperTitle });
      }
    }
    for (const n of displayNodes) {
      if (!seen.has(n.paperId)) {
        seen.set(n.paperId, { authors: n.paperAuthors, year: n.paperYear, title: n.paperTitle });
      }
    }
    const refs = [...seen.values()]
      .map((p) => formatApaReference(p.authors, p.year, p.title))
      .sort((a, b) => a.localeCompare(b));
    const body = `${model.name}\n\nReferences (APA-7)\n\n${refs.map((r, i) => `${i + 1}. ${r}`).join("\n")}\n`;
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `references-${model.name.replace(/[^\w]+/g, "-").toLowerCase()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast({ title: t("md.export.done" as any), description: t("md.export.doneDesc" as any, { n: refs.length }) });
  };

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
            <>
              <button
                data-testid="button-edit-model"
                onClick={startEdit}
                className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium border border-border bg-background hover:bg-accent h-9 px-3 transition-colors"
              >
                <Pencil className="w-3.5 h-3.5" /> {t("md.edit" as any)}
              </button>
              <button
                data-testid="button-export-apa"
                onClick={exportApaReferences}
                title={t("md.export.apaTip" as any)}
                className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium border border-border bg-background hover:bg-accent h-9 px-3 transition-colors"
              >
                <Download className="w-3.5 h-3.5" /> {t("md.export.apa" as any)}
              </button>
              <button
                data-testid="button-evidence-match"
                onClick={() => setEvidenceOpen(true)}
                disabled={editing}
                title={t("evidence.btnTip" as any) as string}
                className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 h-9 px-3 transition-colors disabled:opacity-50"
              >
                <Sparkles className="w-3.5 h-3.5" /> {t("evidence.btn" as any)}
              </button>
              <button
                data-testid="button-generate-lit-review"
                onClick={() => {
                  setLitOpen(true);
                  setLitMd("");
                  setLitCopied(false);
                  litReviewMut.mutate(
                    { id: modelId, data: { lang: typeof document !== "undefined" && document.documentElement.lang.startsWith("zh") ? "zh" : "en" } },
                    {
                      onSuccess: (r) => setLitMd((r as { markdown?: string }).markdown ?? ""),
                      onError: () => toast({ title: t("md.litReview.failed" as any), variant: "destructive" }),
                    },
                  );
                }}
                title={t("md.litReview.btnTip" as any)}
                className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 h-9 px-3 transition-colors"
              >
                <FileText className="w-3.5 h-3.5" /> {t("md.litReview.btn" as any)}
              </button>
            </>
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

      {qualityReport && (
        <div className="bg-card border border-border rounded-lg p-4" data-testid="panel-quality-report">
          <div className="flex items-center gap-2 mb-3">
            <BarChart3 className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{t("md.quality.title" as any)}</h2>
            <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" aria-label={t("md.quality.titleTip" as any) as string}>
              <title>{t("md.quality.titleTip" as any)}</title>
            </Info>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3">
            <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-sky-700 font-semibold">{t("md.quality.structural" as any)}</div>
              <div className="text-xl font-bold text-sky-900" data-testid="text-quality-structural">{qualityReport.structuralScore}</div>
            </div>
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-emerald-700 font-semibold">{t("md.quality.evidence" as any)}</div>
              <div className="text-xl font-bold text-emerald-900" data-testid="text-quality-evidence">{qualityReport.evidenceScore}</div>
            </div>
            {([
              ["layer", qualityReport.layerCompliance, "md.quality.layer"],
              ["dupRole", qualityReport.duplicateRoleCheck, "md.quality.dupRole"],
              ["modJust", qualityReport.moderatorJustified, "md.quality.modJust"],
            ] as const).map(([k, ok, lbl]) => (
              <div
                key={k}
                data-testid={`badge-quality-${k}`}
                className={
                  "rounded-md border px-3 py-2 " +
                  (ok ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50")
                }
              >
                <div className={"text-[10px] uppercase tracking-wider font-semibold " + (ok ? "text-emerald-700" : "text-amber-700")}>{t(lbl as any)}</div>
                <div className={"text-sm font-bold " + (ok ? "text-emerald-900" : "text-amber-900")}>
                  {ok ? "✓ " + t("md.quality.pass" as any) : "✗ " + t("md.quality.fail" as any)}
                </div>
              </div>
            ))}
          </div>
          <div className="text-xs text-muted-foreground">
            <span className="font-semibold">{t("md.quality.weakEdges" as any)}:</span>{" "}
            {qualityReport.weakEdges.length === 0 ? (
              <span className="text-emerald-700">{t("md.quality.weakEmpty" as any)}</span>
            ) : (
              <ul className="mt-1 space-y-0.5" data-testid="list-quality-weakedges">
                {qualityReport.weakEdges.map((w, i) => (
                  <li key={i} className="inline-flex items-center gap-1.5 mr-3">
                    <AlertTriangle className="w-3 h-3 text-amber-600" />
                    <span className="text-foreground">{w.fromVariableName} → {w.toVariableName}</span>
                    <span className="text-amber-700 italic">({t(`md.quality.reason.${w.reason}` as any)})</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <InnovationMetaPanel
        sessionId={sessionId}
        modelId={modelId}
        meta={model.innovationMeta ?? null}
        variant="full"
      />

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
          {displayNodes.length > 0 && displayEdges.length > 0 && (() => {
            const edgeHTagByKey = buildEdgeHTagMap(displayEdges);
            const paperTagById = buildPaperTagMap(displayNodes, displayEdges);
            return (
              <div className="mb-4 bg-background/50 rounded-lg p-4 border border-border overflow-hidden" data-testid="panel-model-graph">
                <div className="flex items-center gap-2 mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <GitBranch className="w-3.5 h-3.5 text-violet-600" />
                  <span>{t("md.graph.title" as any)}</span>
                  <span className="font-normal normal-case tracking-normal text-[11px] text-muted-foreground/80">{t("md.graph.tip" as any)}</span>
                </div>
                {editing ? (
                  <EditableModelGraph
                    nodes={displayNodes.map((n) => ({
                      id: `var-${n.variableId}`,
                      variableId: n.variableId,
                      variableName: n.variableName,
                      type: n.type,
                      paperTag: paperTagById.get(n.paperId),
                      positionX: (n as NodeT & { positionX?: number | null }).positionX ?? null,
                      positionY: (n as NodeT & { positionY?: number | null }).positionY ?? null,
                    }))}
                    edges={displayEdges.map((e, i) => ({
                      id: `edge-${i}`,
                      fromVariableId: e.fromVariableId,
                      toVariableId: e.toVariableId,
                      relationship: e.relationship,
                      hTag: edgeHTagByKey.get(`${e.fromVariableId}->${e.toVariableId}`),
                    }))}
                    variablePool={(sessionVars ?? []).map((v) => ({ variableId: v.id, name: v.name, type: v.type }))}
                    height={480}
                    onNodeMove={(_id, variableId, x, y) =>
                      setDraftNodes((cur) =>
                        cur.map((n) => n.variableId === variableId ? ({ ...n, positionX: x, positionY: y } as NodeT) : n),
                      )
                    }
                    onNodeDelete={(_id, variableId) => deleteNode(variableId)}
                    onEdgeDelete={(edgeId) => {
                      const idx = parseInt(edgeId.replace(/^edge-/, ""), 10);
                      if (Number.isFinite(idx)) deleteEdge(idx);
                    }}
                    onEdgeCreate={(from, to) => {
                      setNewEdgeFrom(String(from));
                      setNewEdgeTo(String(to));
                      setNewEdgeRel("positive");
                      setNewEdgeEvidence("");
                      setPendingCanvasEdge({ from, to });
                    }}
                    onAddVariable={(variableId) => {
                      const v = (sessionVars ?? []).find((x) => x.id === variableId);
                      if (!v) return;
                      setDraftNodes((cur) => [...cur, {
                        variableId: v.id,
                        variableName: v.name,
                        type: v.type,
                        paperId: v.paperId,
                        paperTitle: v.paperTitle,
                        paperAuthors: v.paperAuthors,
                        paperYear: v.paperYear ?? null,
                      } as NodeT]);
                    }}
                  />
                ) : (
                  <ModelGraph nodes={displayNodes} edges={displayEdges} paperTagById={paperTagById} edgeHTagByKey={edgeHTagByKey} />
                )}
              </div>
            );
          })()}
          <div className="space-y-4">
            {displayEdges.map((edge, i) => (
              <div key={i} data-testid={`card-model-edge-${i}`} className="bg-card border border-border rounded-lg p-5 scroll-mt-4" id={`edge-h${i + 1}`}>
                <div className="flex items-center gap-3 mb-4">
                  <span data-testid={`badge-edge-htag-${i}`} className="inline-flex items-center justify-center min-w-[36px] h-6 px-2 rounded-full bg-violet-100 text-violet-800 border border-violet-300 text-xs font-bold">
                    H{i + 1}
                  </span>
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
                  {(edge.evidenceHypothesisId || edge.effectSize || edge.evidenceLocation) && (
                    <div className="flex flex-wrap items-center gap-1.5 mb-3">
                      {edge.evidenceHypothesisId && (
                        <span data-testid={`badge-edge-hyp-${i}`} className="inline-flex items-center gap-1 text-[11px] font-semibold rounded-full bg-indigo-100 text-indigo-800 border border-indigo-200 px-2 py-0.5">
                          <Hash className="w-3 h-3" /> {edge.evidenceHypothesisId}
                        </span>
                      )}
                      {edge.effectSize && (
                        <span data-testid={`badge-edge-effect-${i}`} className="inline-flex items-center gap-1 text-[11px] font-mono rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 px-2 py-0.5">
                          <BarChart3 className="w-3 h-3" /> {edge.effectSize}
                        </span>
                      )}
                      {edge.evidenceLocation && (
                        <span data-testid={`badge-edge-loc-${i}`} className="inline-flex items-center gap-1 text-[11px] rounded-full bg-slate-100 text-slate-700 border border-slate-200 px-2 py-0.5">
                          <MapPin className="w-3 h-3" /> {edge.evidenceLocation}
                        </span>
                      )}
                    </div>
                  )}
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
                  {edge.relationship === "moderates" && edge.moderatorJustification && (
                    <div data-testid={`text-edge-modjust-${i}`} className="mb-3 flex items-start gap-2 text-xs leading-relaxed bg-purple-50 border border-purple-200 text-purple-900 rounded-md p-2">
                      <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span><span className="font-semibold">{t("md.modJust" as any)}: </span>{edge.moderatorJustification}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground border-t border-border pt-3">
                    <BookOpen className="w-3.5 h-3.5 text-primary/60 shrink-0" />
                    <span className="font-medium text-foreground">{edge.evidencePaperTitle}</span>
                    {(edge.evidencePaperAuthors ?? []).length > 0 && (
                      <span>· {(edge.evidencePaperAuthors ?? []).slice(0, 2).join(", ")}{(edge.evidencePaperAuthors ?? []).length > 2 ? " et al." : ""}</span>
                    )}
                    {edge.evidencePaperYear && <span>· {edge.evidencePaperYear}</span>}
                  </div>
                  {!editing && edge.evidencePaperId && (
                    <PaperFigures sessionId={sessionId} paperId={edge.evidencePaperId} edgeIndex={i} />
                  )}
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
                  <label className="text-[11px] font-medium text-muted-foreground block mb-1">证据来源论文</label>
                  <select
                    data-testid="select-new-edge-paper"
                    value={newEdgePaperId}
                    onChange={(e) => setNewEdgePaperId(e.target.value)}
                    className="w-full text-xs rounded-md border border-input bg-background px-2 py-1.5"
                  >
                    <option value="">默认(来源变量所在论文)</option>
                    {[...new Map(draftNodes.map((n) => [n.paperId, n])).values()].map((n) => (
                      <option key={n.paperId} value={n.paperId}>
                        {(n.paperAuthors?.[0] ?? "Unknown")}{n.paperYear ? ` (${n.paperYear})` : ""} — {n.paperTitle.slice(0, 80)}
                      </option>
                    ))}
                  </select>
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

      {/* Canvas drag-to-create → small modal asking for relationship + evidence quote */}
      {pendingCanvasEdge && editing && (() => {
        const fromN = draftNodes.find((n) => n.variableId === pendingCanvasEdge.from);
        const toN = draftNodes.find((n) => n.variableId === pendingCanvasEdge.to);
        if (!fromN || !toN) return null;
        return (
          <div
            data-testid="dialog-canvas-edge"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => setPendingCanvasEdge(null)}
          >
            <div
              className="bg-card border border-border rounded-lg shadow-xl w-full max-w-md p-5 space-y-4"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="font-semibold text-foreground">{t("canvas.newEdge.title" as any)}</h3>
              <div className="text-sm text-foreground">
                <span className="font-medium">{fromN.variableName}</span>
                <span className="mx-2 text-muted-foreground">→</span>
                <span className="font-medium">{toN.variableName}</span>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t("canvas.newEdge.relLabel" as any)}</label>
                <select
                  data-testid="canvas-edge-rel"
                  value={newEdgeRel}
                  onChange={(e) => setNewEdgeRel(e.target.value)}
                  className="w-full text-sm rounded-md border border-input bg-background px-3 py-2"
                >
                  <option value="positive">+ positive</option>
                  <option value="negative">− negative</option>
                  <option value="mediates">→ mediates</option>
                  <option value="moderates">M moderates</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t("canvas.newEdge.evidenceLabel" as any)}</label>
                <textarea
                  data-testid="canvas-edge-evidence"
                  value={newEdgeEvidence}
                  onChange={(e) => setNewEdgeEvidence(e.target.value)}
                  placeholder={t("canvas.newEdge.evidencePh" as any) as string}
                  rows={3}
                  className="w-full text-sm rounded-md border border-input bg-background px-3 py-2 resize-y"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setPendingCanvasEdge(null)}
                  className="text-xs text-muted-foreground hover:text-foreground px-3 py-1.5"
                >
                  {t("canvas.newEdge.cancel" as any)}
                </button>
                <button
                  type="button"
                  data-testid="canvas-edge-confirm"
                  onClick={addEdge}
                  className="inline-flex items-center gap-1.5 rounded-md text-xs font-semibold h-8 px-4 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  {t("canvas.newEdge.confirm" as any)}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {litOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setLitOpen(false)}
          data-testid="dialog-lit-review"
        >
          <div
            className="bg-background border border-border rounded-lg shadow-xl max-w-3xl w-full max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 p-4 border-b border-border">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-foreground inline-flex items-center gap-2">
                  <FileText className="w-4 h-4 text-emerald-700" /> {t("md.litReview.title" as any)}
                </h2>
                <p className="text-xs text-muted-foreground mt-1">{t("md.litReview.subtitle" as any)}</p>
              </div>
              <button
                onClick={() => setLitOpen(false)}
                className="rounded-md p-1.5 hover:bg-accent text-muted-foreground"
                data-testid="button-close-lit-review"
                aria-label={t("md.litReview.close" as any) as string}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 flex-1 overflow-auto">
              {litReviewMut.isPending ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
                  <Loader2 className="w-4 h-4 animate-spin" /> {t("md.litReview.loading" as any)}
                </div>
              ) : litMd ? (
                <textarea
                  data-testid="textarea-lit-review-output"
                  readOnly
                  value={litMd}
                  className="w-full min-h-[300px] text-sm leading-relaxed bg-muted/30 border border-border rounded-md p-3 font-serif text-foreground"
                />
              ) : (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">{t("md.litReview.failed" as any)}</div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 p-3 border-t border-border bg-muted/20">
              <button
                onClick={() => {
                  setLitMd("");
                  setLitCopied(false);
                  litReviewMut.mutate(
                    { id: modelId, data: { lang: typeof document !== "undefined" && document.documentElement.lang.startsWith("zh") ? "zh" : "en" } },
                    {
                      onSuccess: (r) => setLitMd((r as { markdown?: string }).markdown ?? ""),
                      onError: () => toast({ title: t("md.litReview.failed" as any), variant: "destructive" }),
                    },
                  );
                }}
                disabled={litReviewMut.isPending}
                data-testid="button-regen-lit-review"
                className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium border border-border bg-background hover:bg-accent h-9 px-3 disabled:opacity-50"
              >
                {litReviewMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                {t("md.litReview.regen" as any)}
              </button>
              <button
                onClick={() => {
                  if (!litMd) return;
                  navigator.clipboard.writeText(litMd).then(() => {
                    setLitCopied(true);
                    setTimeout(() => setLitCopied(false), 1800);
                  });
                }}
                disabled={!litMd}
                data-testid="button-copy-lit-review"
                className="inline-flex items-center gap-1.5 rounded-md text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 h-9 px-4 disabled:opacity-50"
              >
                <CopyIcon className="w-3.5 h-3.5" /> {litCopied ? t("md.litReview.copied" as any) : t("md.litReview.copy" as any)}
              </button>
            </div>
          </div>
        </div>
      )}

      <EvidenceMatchDialog
        open={evidenceOpen}
        onClose={() => setEvidenceOpen(false)}
        mode="candidate"
        sessionId={sessionId}
        modelId={modelId}
      />

      <AlertDialog open={pendingSelectOpen} onOpenChange={setPendingSelectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("models.confirm.overwriteTitle" as any, { n: manualEdgeCount })}</AlertDialogTitle>
            <AlertDialogDescription>{t("models.confirm.overwriteBody" as any)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel" as any)}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-overwrite"
              onClick={() => {
                setPendingSelectOpen(false);
                doSelect();
              }}
            >
              {t("models.confirm.overwriteOk" as any)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

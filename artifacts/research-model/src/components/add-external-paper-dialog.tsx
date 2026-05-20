import React, { useState } from "react";
import { Loader2, X, FileText } from "lucide-react";
import {
  useAddExternalPaper,
  getListSessionPapersQueryKey,
  getGetSessionSummaryQueryKey,
  getGetSessionQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";

type SourceType = "industry_report" | "gov_report" | "whitepaper" | "other";

const SOURCE_TYPES: SourceType[] = ["industry_report", "gov_report", "whitepaper", "other"];

interface Props {
  sessionId: number;
  open: boolean;
  onClose: () => void;
}

export function AddExternalPaperDialog({ sessionId, open, onClose }: Props) {
  const { t } = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const addExternal = useAddExternalPaper();

  const [title, setTitle] = useState("");
  const [sourceOrg, setSourceOrg] = useState("");
  const [year, setYear] = useState("");
  const [sourceType, setSourceType] = useState<SourceType>("industry_report");
  const [abstract, setAbstract] = useState("");
  const [fullText, setFullText] = useState("");
  const [titleError, setTitleError] = useState(false);

  if (!open) return null;

  const reset = () => {
    setTitle(""); setSourceOrg(""); setYear(""); setSourceType("industry_report");
    setAbstract(""); setFullText(""); setTitleError(false);
  };

  const handleClose = () => { reset(); onClose(); };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { setTitleError(true); return; }
    setTitleError(false);

    const parsedYear = year.trim() ? parseInt(year.trim(), 10) : null;

    addExternal.mutate(
      {
        id: sessionId,
        data: {
          title: title.trim(),
          sourceOrg: sourceOrg.trim() || null,
          year: parsedYear && !Number.isNaN(parsedYear) ? parsedYear : null,
          sourceType,
          abstract: abstract.trim() || null,
          fullText: fullText.trim() || null,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSessionPapersQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getGetSessionSummaryQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
          toast({ title: t("externalPaper.toast.added" as any) });
          handleClose();
        },
        onError: () => {
          toast({
            title: t("externalPaper.toast.addFailed" as any),
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative bg-background border border-border rounded-xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            <h2 className="text-base font-semibold text-foreground">
              {t("externalPaper.dialog.title" as any)}
            </h2>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="text-muted-foreground hover:text-foreground transition-colors rounded-md p-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pt-3 pb-1">
          <p className="text-sm text-muted-foreground">
            {t("externalPaper.dialog.subtitle" as any)}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t("externalPaper.field.title" as any)} <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => { setTitle(e.target.value); if (e.target.value.trim()) setTitleError(false); }}
              placeholder={t("externalPaper.field.title.ph" as any) as string}
              className={`w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${titleError ? "border-destructive" : "border-input"}`}
            />
            {titleError && (
              <p className="mt-1 text-xs text-destructive">
                {t("externalPaper.field.title.required" as any)}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t("externalPaper.field.sourceOrg" as any)}
              </label>
              <input
                type="text"
                value={sourceOrg}
                onChange={(e) => setSourceOrg(e.target.value)}
                placeholder={t("externalPaper.field.sourceOrg.ph" as any) as string}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t("externalPaper.field.year" as any)}
              </label>
              <input
                type="number"
                value={year}
                onChange={(e) => setYear(e.target.value)}
                placeholder={t("externalPaper.field.year.ph" as any) as string}
                min={1900}
                max={2099}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t("externalPaper.field.sourceType" as any)} <span className="text-destructive">*</span>
            </label>
            <select
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value as SourceType)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {SOURCE_TYPES.map((st) => (
                <option key={st} value={st}>
                  {t(`externalPaper.sourceType.${st}` as any)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t("externalPaper.field.abstract" as any)}
            </label>
            <textarea
              value={abstract}
              onChange={(e) => setAbstract(e.target.value)}
              placeholder={t("externalPaper.field.abstract.ph" as any) as string}
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t("externalPaper.field.fullText" as any)}
            </label>
            <textarea
              value={fullText}
              onChange={(e) => setFullText(e.target.value)}
              placeholder={t("externalPaper.field.fullText.ph" as any) as string}
              rows={6}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t("externalPaper.field.fullText.hint" as any)}
            </p>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="inline-flex items-center gap-2 rounded-md text-sm font-medium border border-input bg-background text-foreground hover:bg-muted h-9 px-4 transition-colors"
            >
              {t("common.cancel" as any)}
            </button>
            <button
              type="submit"
              disabled={addExternal.isPending}
              className="inline-flex items-center gap-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-5 disabled:opacity-50 disabled:pointer-events-none transition-colors"
            >
              {addExternal.isPending
                ? <><Loader2 className="w-4 h-4 animate-spin" />{t("externalPaper.submitting" as any)}</>
                : t("externalPaper.submit" as any)}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

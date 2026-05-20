import React, { useState, useEffect } from "react";
import { useScorePapersForGeneration, type PaperRelevanceScore } from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { useToast } from "@/hooks/use-toast";

interface PaperSelectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: number;
  onConfirm: (includedPaperIds: number[]) => void;
  onSkip: () => void;
}

const REC_COLORS = {
  include: "bg-green-100 text-green-800 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800",
  borderline: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800",
  exclude: "bg-red-100 text-red-800 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800",
} as const;

const BAR_COLORS = {
  include: "bg-green-500",
  borderline: "bg-amber-500",
  exclude: "bg-red-400",
} as const;

export function PaperSelectionDialog({
  open,
  onOpenChange,
  sessionId,
  onConfirm,
  onSkip,
}: PaperSelectionDialogProps) {
  const { t } = useT();
  const { toast } = useToast();
  const [scores, setScores] = useState<PaperRelevanceScore[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [hasLoaded, setHasLoaded] = useState(false);

  const scoreMutation = useScorePapersForGeneration();

  useEffect(() => {
    if (!open) return;
    setHasLoaded(false);
    setScores([]);
    setSelected(new Set());
    scoreMutation.mutate(
      { id: sessionId },
      {
        onSuccess: (result) => {
          setScores(result);
          setSelected(new Set(result.filter((s) => s.recommendation === "include").map((s) => s.paperId)));
          setHasLoaded(true);
        },
        onError: () => {
          toast({ title: t("paperSelect.errorFallback" as any), variant: "warning" });
          onSkip();
          onOpenChange(false);
        },
      },
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId]);

  const toggle = (paperId: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(paperId)) next.delete(paperId);
      else next.add(paperId);
      return next;
    });
  };

  const selectAllRecommended = () => {
    setSelected(new Set(scores.filter((s) => s.recommendation === "include").map((s) => s.paperId)));
  };

  const handleConfirm = () => {
    if (selected.size === 0) {
      toast({ title: t("paperSelect.noneSelected" as any), variant: "warning" });
      return;
    }
    onConfirm(Array.from(selected));
    onOpenChange(false);
  };

  const handleSkip = () => {
    onSkip();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>{t("paperSelect.title" as any)}</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed mt-1">
            {t("paperSelect.subtitle" as any)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0 px-5 space-y-2 pb-2">
          {!hasLoaded ? (
            <div className="flex items-center justify-center py-14 gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t("paperSelect.loading" as any)}
            </div>
          ) : (
            scores.map((s) => {
              const rec = s.recommendation in REC_COLORS ? s.recommendation : "borderline";
              const checked = selected.has(s.paperId);
              return (
                <label
                  key={s.paperId}
                  className={cn(
                    "flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors select-none",
                    checked
                      ? "border-primary/40 bg-primary/5"
                      : "border-border bg-card hover:bg-muted/40",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(s.paperId)}
                    className="mt-0.5 rounded shrink-0 accent-primary"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground leading-snug flex-1 min-w-0 break-words">
                        {s.title || `Paper ${s.paperId}`}
                      </span>
                      <span
                        className={cn(
                          "text-[10px] font-semibold px-1.5 py-0.5 rounded-full border shrink-0",
                          REC_COLORS[rec as keyof typeof REC_COLORS],
                        )}
                      >
                        {t(`paperSelect.${rec}` as any)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1.5">
                      <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                        <div
                          className={cn("h-full rounded-full transition-all", BAR_COLORS[rec as keyof typeof BAR_COLORS])}
                          style={{ width: `${s.relevanceScore}%` }}
                        />
                      </div>
                      <span className="text-[10px] tabular-nums text-muted-foreground shrink-0 w-7 text-right">
                        {s.relevanceScore}%
                      </span>
                    </div>
                    {s.reason && (
                      <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{s.reason}</p>
                    )}
                  </div>
                </label>
              );
            })
          )}
        </div>

        {hasLoaded && (
          <div className="flex items-center justify-between px-5 py-2 border-t border-border bg-muted/30 shrink-0">
            <button
              type="button"
              onClick={selectAllRecommended}
              className="text-xs text-primary hover:underline"
            >
              {t("paperSelect.selectRecommended" as any)}
            </button>
            <span className="text-xs text-muted-foreground">
              {selected.size} / {scores.length}
            </span>
          </div>
        )}

        <DialogFooter className="px-5 py-3 border-t border-border gap-2 flex-col sm:flex-row shrink-0">
          <button
            type="button"
            onClick={handleSkip}
            className="text-sm text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md hover:bg-muted/50 transition-colors order-last sm:order-first sm:mr-auto"
          >
            {t("paperSelect.skipBtn" as any)}
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="text-sm text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md hover:bg-muted/50 transition-colors"
          >
            {t("paperSelect.cancel" as any)}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!hasLoaded || selected.size === 0}
            className="inline-flex items-center gap-2 rounded-md text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-4 disabled:opacity-50 disabled:pointer-events-none transition-colors"
          >
            {t("paperSelect.confirmBtn" as any, { n: selected.size })}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

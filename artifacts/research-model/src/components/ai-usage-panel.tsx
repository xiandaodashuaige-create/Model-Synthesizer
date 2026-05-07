import { useEffect, useState } from "react";
import {
  useGetSessionAiUsage, getGetSessionAiUsageQueryKey,
  useGetSessionSummary, getGetSessionSummaryQueryKey,
} from "@workspace/api-client-react";
import { Activity, ChevronDown, ChevronUp } from "lucide-react";
import { useT } from "@/lib/i18n";

// Display unit is "积分" (credits): 1 credit = $0.01 of underlying OpenAI list
// price, i.e. credits = USD × 100. We round to whole credits for any spend ≥
// 1 credit (the typical case), and show one decimal under that so a freshly
// created session with one cheap call still reads as a non-zero number rather
// than collapsing to "0 积分". The DB layer keeps storing micro-USD so we can
// always re-derive the rate later if pricing changes.
function fmtCredits(usd: number): string {
  const credits = usd * 100;
  if (credits >= 1) return `${Math.round(credits).toLocaleString()}`;
  if (credits <= 0) return "0";
  // Anything 0 < credits < 1 rounds to one decimal, but clamp to 0.1 so a
  // genuinely non-zero spend never visually collapses to "0.0" — that would
  // misleadingly suggest "this call was free" when it wasn't.
  return Math.max(0.1, Math.round(credits * 10) / 10).toFixed(1);
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Conservative manual-labor estimate per output unit (hours). Based on what a
// graduate research assistant would typically need: skim a paper + capture an
// abstract (~30 min), read a paper closely enough to extract one variable
// definition with citation (~12 min), draft a full theoretical model from
// scratch (~90 min). Edge-level cross-checking is intentionally rolled into
// the per-model figure rather than counted separately, which keeps the formula
// matching the headline byline. These are deliberately on the low end so the
// "value" number stays defensible.
const HOURS_PER_PAPER = 0.5;
const HOURS_PER_VARIABLE = 0.2;
const HOURS_PER_MODEL = 1.5;

const DEV_MODE_KEY = "ai-usage-dev-mode";

function readDevMode(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(DEV_MODE_KEY) === "1"; } catch { return false; }
}

export function AiUsagePanel({ sessionId }: { sessionId: number }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  // Dev mode toggle persists in localStorage so power users (and the
  // project owner who actually pays the AI bill) keep it on across reloads.
  // Default OFF — most users care about what they GOT, not what was spent.
  const [devMode, setDevMode] = useState<boolean>(() => readDevMode());

  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(DEV_MODE_KEY, devMode ? "1" : "0"); } catch { /* ignore */ }
  }, [devMode]);

  const { data: usage, isLoading: usageLoading, isError: usageError, error } = useGetSessionAiUsage(sessionId, {
    query: { enabled: !!sessionId, queryKey: getGetSessionAiUsageQueryKey(sessionId), refetchInterval: open ? 15_000 : false },
  });
  const { data: summary } = useGetSessionSummary(sessionId, {
    query: { enabled: !!sessionId, queryKey: getGetSessionSummaryQueryKey(sessionId) },
  });

  if (!sessionId) return null;

  const totalCost = usage?.totalCostUsd ?? 0;
  const totalCalls = usage?.totalCalls ?? 0;
  const totalTokens = usage?.totalTokens ?? 0;
  const totalSaved = usage?.savedCostUsd ?? 0;
  const paperCount = summary?.paperCount ?? 0;
  const variableCount = summary?.variableCount ?? 0;
  const modelCount = summary?.modelCount ?? 0;
  const laborHours = paperCount * HOURS_PER_PAPER + variableCount * HOURS_PER_VARIABLE + modelCount * HOURS_PER_MODEL;
  const panelId = `ai-usage-panel-body-${sessionId}`;
  const hasSavings = totalSaved > 0;

  // Header byline ALWAYS includes the credits-spent + credits-saved tail when
  // the cost figure has loaded, regardless of dev-mode. The previous design
  // hid both numbers behind a checkbox so the project owner couldn't see
  // what they were spending without two clicks. Keep dev-mode as the toggle
  // for the per-route cost breakdown, but make the headline numbers public.
  const haveCost = !usageLoading && !usageError && !!usage;
  const moneyTail = haveCost
    ? ` · ${fmtCredits(totalCost)} ${t("usage.credits.unit" as any)}` +
      (hasSavings ? ` (−${fmtCredits(totalSaved)})` : "")
    : "";
  const valueByline = `${paperCount} ${t("usage.value.papers" as any)} · ${variableCount} ${t("usage.value.variables" as any)} · ${modelCount} ${t("usage.value.models" as any)} · ≈${laborHours.toFixed(1)}h${moneyTail}`;
  const costByline = haveCost
    ? `${fmtCredits(totalCost)} ${t("usage.credits.unit" as any)} · ${fmtNum(totalTokens)} ${t("usage.tokens" as any)} · ${totalCalls} ${t("usage.calls" as any)}`
    : "";

  return (
    <div className="bg-card border border-border rounded-lg shadow-sm" data-testid="ai-usage-panel">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="w-full px-4 py-2.5 flex items-center justify-between text-sm hover:bg-muted/40 transition-colors rounded-lg"
        data-testid="ai-usage-toggle"
      >
        <span className="flex items-center gap-2 text-muted-foreground min-w-0">
          <Activity className="w-4 h-4 shrink-0" />
          <span className="font-medium text-foreground">
            {devMode ? t("usage.title" as any) : t("usage.value.title" as any)}
          </span>
          <span className="ml-1 text-xs truncate">
            {devMode ? costByline : valueByline}
          </span>
          {usageError && devMode && (
            <span className="ml-1 text-xs text-destructive">{t("usage.error" as any)}</span>
          )}
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>

      {open && (
        <div id={panelId} className="border-t border-border px-4 py-3 space-y-3">
          {/* Mode toggle row — small, lives at the top of the body so it's
              always discoverable but doesn't hijack the header byline. */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {devMode ? t("usage.devMode.on.hint" as any) : t("usage.devMode.off.hint" as any)}
            </span>
            <label className="inline-flex items-center gap-1.5 cursor-pointer select-none" data-testid="ai-usage-devmode-toggle">
              <input
                type="checkbox"
                checked={devMode}
                onChange={(e) => setDevMode(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-border accent-primary"
              />
              <span className="text-muted-foreground">{t("usage.devMode.label" as any)}</span>
            </label>
          </div>

          {/* Value dashboard — what the AI produced for this project, what it
              cost in credits, and how many credits were saved by routing easy
              tasks to a cheaper model. The "credits saved" tile is the
              user-facing surface of the per-route model downgrades; without it
              the savings are invisible to anyone who doesn't open dev mode. */}
          {!devMode && (
            <div data-testid="ai-usage-value-grid" className="space-y-2">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                <ValueTile label={t("usage.value.papers" as any) as string} value={String(paperCount)} />
                <ValueTile label={t("usage.value.variables" as any) as string} value={String(variableCount)} />
                <ValueTile label={t("usage.value.models" as any) as string} value={String(modelCount)} />
                <ValueTile label={t("usage.value.laborHours" as any) as string} value={`≈${laborHours.toFixed(1)}h`} />
                <ValueTile
                  label={t("usage.value.spent" as any) as string}
                  value={haveCost ? fmtCredits(totalCost) : "—"}
                  testId="ai-usage-spent"
                />
                <ValueTile
                  label={t("usage.value.saved" as any) as string}
                  value={haveCost ? (hasSavings ? `+${fmtCredits(totalSaved)}` : "0") : "—"}
                  accent={hasSavings ? "success" : "muted"}
                  testId="ai-usage-saved"
                />
              </div>
              {/* Only show the savings explainer once cost has actually loaded.
                  During loading/error the tile reads "—", so emitting "nothing
                  saved" copy here would mislead the user into thinking the
                  savings are zero rather than not yet computed. */}
              {haveCost && (
                <p className="text-[11px] text-muted-foreground leading-snug">
                  {hasSavings ? t("usage.value.savedHint" as any) : t("usage.value.noSaved" as any)}
                </p>
              )}
              <p className="text-[11px] text-muted-foreground leading-snug">
                {t("usage.value.formula" as any)}
              </p>
            </div>
          )}

          {/* Cost details — only shown in dev mode so non-technical users
              don't get distracted by route-level token spend. */}
          {devMode && usageLoading && <div className="text-xs text-muted-foreground">{t("common.loading" as any)}</div>}
          {devMode && !usageLoading && usageError && (
            <div className="text-xs text-destructive">
              {t("usage.error" as any)}
              {error instanceof Error && error.message ? `: ${error.message}` : ""}
            </div>
          )}
          {devMode && !usageLoading && !usageError && (usage?.byRoute?.length ?? 0) === 0 && (
            <div className="text-xs text-muted-foreground">{t("usage.empty" as any)}</div>
          )}
          {devMode && !usageLoading && !usageError && (usage?.byRoute?.length ?? 0) > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left font-medium py-1.5 pr-3">{t("usage.col.route" as any)}</th>
                    <th className="text-right font-medium py-1.5 px-2">{t("usage.col.calls" as any)}</th>
                    <th className="text-right font-medium py-1.5 px-2">{t("usage.col.tokens" as any)}</th>
                    <th className="text-right font-medium py-1.5 pl-2">{t("usage.col.credits" as any)}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(usage?.byRoute ?? [])]
                    .sort((a, b) => b.costUsd - a.costUsd)
                    .map((r) => (
                      <tr key={r.route} className="border-b border-border last:border-b-0" data-testid={`ai-usage-row-${r.route}`}>
                        <td className="py-1.5 pr-3 font-mono text-foreground">{r.route}</td>
                        <td className="py-1.5 px-2 text-right text-muted-foreground">{r.calls}</td>
                        <td className="py-1.5 px-2 text-right text-muted-foreground">{fmtNum(r.totalTokens)}</td>
                        <td className="py-1.5 pl-2 text-right text-foreground tabular-nums">{fmtCredits(r.costUsd)}</td>
                      </tr>
                    ))}
                  <tr className="font-medium">
                    <td className="py-1.5 pr-3 text-foreground">{t("usage.total" as any)}</td>
                    <td className="py-1.5 px-2 text-right">{totalCalls}</td>
                    <td className="py-1.5 px-2 text-right">{fmtNum(totalTokens)}</td>
                    <td className="py-1.5 pl-2 text-right tabular-nums">{fmtCredits(totalCost)}</td>
                  </tr>
                </tbody>
              </table>
              <div className="mt-2 text-[11px] text-muted-foreground leading-snug">
                {t("usage.credits.note" as any)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ValueTile({
  label,
  value,
  accent,
  testId,
}: {
  label: string;
  value: string;
  accent?: "success" | "muted";
  testId?: string;
}) {
  const valueClass =
    accent === "success" ? "text-emerald-700 dark:text-emerald-400"
    : accent === "muted" ? "text-muted-foreground"
    : "text-foreground";
  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2" data-testid={testId}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}

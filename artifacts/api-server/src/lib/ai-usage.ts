import { db, aiUsageLogTable } from "@workspace/db";

// Per-1M-token pricing in USD, by model. We multiply tokens by these rates to
// get micro-USD per token (1 USD = 1_000_000 micro-USD), then divide back when
// displaying. Numbers come from OpenAI's published list pricing for the gpt-5
// family — they let us correctly attribute the discount when a route is
// downgraded from gpt-5.4 to gpt-5-mini for cost reasons.
const PRICING_PER_1M_USD: Record<string, { prompt: number; completion: number }> = {
  "gpt-5.4":     { prompt: 2.5,  completion: 10.0 },
  "gpt-5.3":     { prompt: 2.5,  completion: 10.0 },
  "gpt-5.2":     { prompt: 1.25, completion: 5.0 },
  "gpt-5.1":     { prompt: 1.25, completion: 5.0 },
  "gpt-5":       { prompt: 1.25, completion: 5.0 },
  "gpt-5-mini":  { prompt: 0.25, completion: 2.0 },
  "gpt-5-nano":  { prompt: 0.05, completion: 0.4 },
};
// Used when the response carries no model name, or a model we don't recognise.
// We pick the priciest tier so the bill is never under-reported.
const DEFAULT_PRICING = PRICING_PER_1M_USD["gpt-5.4"];

function pricingFor(model?: string): { prompt: number; completion: number } {
  if (!model) return DEFAULT_PRICING;
  // Strip any date-suffix the proxy may attach (e.g. "gpt-5.4-2026-04-01").
  const base = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return PRICING_PER_1M_USD[base] ?? PRICING_PER_1M_USD[model] ?? DEFAULT_PRICING;
}

export interface UsageInput {
  sessionId?: number | null;
  userId?: string | null;
  route: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
}

export function computeCostMicroUsd(promptTokens: number, completionTokens: number, model?: string): number {
  const p = pricingFor(model);
  const micro = (promptTokens * p.prompt + completionTokens * p.completion);
  // (tokens * usd_per_1M) / 1_000_000 = usd, then * 1_000_000 = micro-usd, so net is just `micro` integer.
  return Math.round(micro);
}

// Fire-and-forget. We never want a logging failure to break the request that
// the user is waiting on, so any DB error is swallowed (caller logs separately
// if it cares).
export function logAiUsage(input: UsageInput): void {
  const promptTokens = input.promptTokens ?? 0;
  const completionTokens = input.completionTokens ?? 0;
  const totalTokens = promptTokens + completionTokens;
  const costMicroUsd = computeCostMicroUsd(promptTokens, completionTokens, input.model);
  void db
    .insert(aiUsageLogTable)
    .values({
      sessionId: input.sessionId ?? null,
      userId: input.userId ?? null,
      route: input.route,
      model: input.model ?? "unknown",
      promptTokens,
      completionTokens,
      totalTokens,
      costMicroUsd,
    })
    .catch(() => {});
}

// Convenience: extract usage from an OpenAI Chat Completions response.
export function logAiUsageFromOpenAI(
  resp: { usage?: { prompt_tokens?: number; completion_tokens?: number } | null; model?: string } | null | undefined,
  meta: Omit<UsageInput, "promptTokens" | "completionTokens" | "model">,
): void {
  const usage = resp?.usage;
  if (!usage) return;
  logAiUsage({
    ...meta,
    model: resp?.model,
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
  });
}

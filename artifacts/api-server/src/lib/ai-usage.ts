import { db, aiUsageLogTable } from "@workspace/db";

// gpt-5.4 pricing — per 1M tokens. We multiply by 100 to get micro-USD per
// token (1 USD = 1_000_000 micro-USD), then divide back when displaying.
const PRICE_PER_1M_PROMPT_USD = 2.5;
const PRICE_PER_1M_COMPLETION_USD = 10.0;

export interface UsageInput {
  sessionId?: number | null;
  userId?: string | null;
  route: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
}

export function computeCostMicroUsd(promptTokens: number, completionTokens: number): number {
  const micro = (promptTokens * PRICE_PER_1M_PROMPT_USD + completionTokens * PRICE_PER_1M_COMPLETION_USD);
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
  const costMicroUsd = computeCostMicroUsd(promptTokens, completionTokens);
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

import { pgTable, serial, text, integer, timestamp, varchar } from "drizzle-orm/pg-core";
import { sessionsTable } from "./sessions";

// Per-AI-call usage log for cost tracking. Each row corresponds to one
// successful OpenAI request.
//   route: "models/generate" | "model-assistant/chat" | "variables/extract" etc.
//   model: the OpenAI model name actually used.
//   promptTokens / completionTokens: from the OpenAI response `usage` field.
//   costMicroUsd: pre-computed cost in micro-USD (1 USD = 1_000_000), to keep
//     integer math and avoid floating-point drift across millions of rows.
export const aiUsageLogTable = pgTable("ai_usage_log", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").references(() => sessionsTable.id, { onDelete: "cascade" }),
  userId: varchar("user_id"),
  route: text("route").notNull(),
  model: text("model").notNull(),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  costMicroUsd: integer("cost_micro_usd").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AiUsageLog = typeof aiUsageLogTable.$inferSelect;

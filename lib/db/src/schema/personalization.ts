import { pgTable, integer, jsonb, timestamp, varchar } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { sessionsTable } from "./sessions";

// Per-user aggregated profile that the AI uses to personalize generation.
// Refreshed lazily; one row per user. The `profile` JSONB carries all
// derived fields so we can evolve the shape without further migrations.
export const userPersonalizationTable = pgTable("user_personalization", {
  userId: varchar("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  profile: jsonb("profile").notNull().default({}),
  sessionsCount: integer("sessions_count").notNull().default(0),
  papersCount: integer("papers_count").notNull().default(0),
  modelsGeneratedCount: integer("models_generated_count").notNull().default(0),
  modelsAcceptedCount: integer("models_accepted_count").notNull().default(0),
  chatTurnsCount: integer("chat_turns_count").notNull().default(0),
  lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type UserPersonalization = typeof userPersonalizationTable.$inferSelect;

// Per-session "signal fingerprint" used both by the user-level aggregator
// (Layer 1) and by the future cross-user topic-cluster aggregator (Layer 2).
// Stored as a JSONB blob keyed by sessionId so future Layer 2 jobs can scan
// rows independently of the live papers/variables/models tables.
export const sessionSignalsTable = pgTable("session_signals", {
  sessionId: integer("session_id")
    .primaryKey()
    .references(() => sessionsTable.id, { onDelete: "cascade" }),
  userId: varchar("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  topicTokens: jsonb("topic_tokens").notNull().default([]),
  variableTokens: jsonb("variable_tokens").notNull().default([]),
  acceptedBackbones: jsonb("accepted_backbones").notNull().default([]),
  acceptedOperators: jsonb("accepted_operators").notNull().default([]),
  paperCount: integer("paper_count").notNull().default(0),
  variableCount: integer("variable_count").notNull().default(0),
  modelCount: integer("model_count").notNull().default(0),
  acceptedModelCount: integer("accepted_model_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type SessionSignals = typeof sessionSignalsTable.$inferSelect;

import { pgTable, text, serial, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sessionsTable } from "./sessions";

export const researchModelsTable = pgTable("research_models", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessionsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull(),
  rationale: text("rationale").notNull(),
  selected: text("selected").notNull().default("false"),
  nodes: jsonb("nodes").notNull().default([]),
  edges: jsonb("edges").notNull().default([]),
  // Set when the user explicitly opted into the "partial-pass" flow (generating
  // models even though some papers in the session had not been extracted yet).
  // Records which papers were used and which were skipped so the UI can warn
  // the reader and the literature review/export can disclose the limitation.
  partialPassMeta: jsonb("partial_pass_meta"),
  // Phase 2 Innovation Layer scoring + provenance. Single-jsonb-column design
  // (rather than splitting into 5+ columns) so the schema stays stable while
  // the computation evolves; we'll consider promotion to dedicated columns
  // once the shape stabilizes (post-Phase-2). Nullable so older rows
  // generated before Phase 2 don't break the response. See
  // docs/innovation-taxonomy.md and `lib/innovation-scoring.ts` for the
  // canonical shape.
  innovationMeta: jsonb("innovation_meta"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertResearchModelSchema = createInsertSchema(researchModelsTable).omit({ id: true, createdAt: true });
export type InsertResearchModel = z.infer<typeof insertResearchModelSchema>;
export type ResearchModel = typeof researchModelsTable.$inferSelect;

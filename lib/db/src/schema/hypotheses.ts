import { pgTable, text, serial, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { papersTable, sessionsTable } from "./sessions";

export const paperHypothesesTable = pgTable(
  "paper_hypotheses",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id").notNull().references(() => sessionsTable.id, { onDelete: "cascade" }),
    paperId: integer("paper_id").notNull().references(() => papersTable.id, { onDelete: "cascade" }),
    hypothesisId: text("hypothesis_id").notNull(),
    fromVariable: text("from_variable").notNull(),
    toVariable: text("to_variable").notNull(),
    viaVariable: text("via_variable"),
    relationship: text("relationship").notNull(),
    statement: text("statement").notNull(),
    effectSize: text("effect_size"),
    pageOrSection: text("page_or_section"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    paperIdx: index("paper_hypotheses_paper_idx").on(t.paperId),
    uniqHyp: uniqueIndex("paper_hypotheses_unique_hyp").on(t.paperId, t.hypothesisId),
  }),
);

export const insertPaperHypothesisSchema = createInsertSchema(paperHypothesesTable).omit({ id: true, createdAt: true });
export type InsertPaperHypothesis = z.infer<typeof insertPaperHypothesisSchema>;
export type PaperHypothesis = typeof paperHypothesesTable.$inferSelect;

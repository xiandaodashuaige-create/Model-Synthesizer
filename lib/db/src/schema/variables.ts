import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { papersTable, sessionsTable } from "./sessions";

export const variablesTable = pgTable("variables", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessionsTable.id, { onDelete: "cascade" }),
  paperId: integer("paper_id").notNull().references(() => papersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  definition: text("definition").notNull(),
  citationText: text("citation_text").notNull(),
  // Canonical construct id — variables across papers with cosine-similar names get the
  // SAME canonical id so we can reason about "trust" once instead of N times. Lazily
  // populated; nullable when alignment hasn't run yet for this variable.
  canonicalConstructId: text("canonical_construct_id"),
  // Construct layer in the standard psychology pipeline:
  // stimulus -> cognitive -> affective -> intention -> behavior.
  // Used by EXTEND / PARALLEL_MEDIATORS to enforce non-jumping mediator chains.
  constructLayer: text("construct_layer"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertVariableSchema = createInsertSchema(variablesTable).omit({ id: true, createdAt: true });
export type InsertVariable = z.infer<typeof insertVariableSchema>;
export type Variable = typeof variablesTable.$inferSelect;

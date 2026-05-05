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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertVariableSchema = createInsertSchema(variablesTable).omit({ id: true, createdAt: true });
export type InsertVariable = z.infer<typeof insertVariableSchema>;
export type Variable = typeof variablesTable.$inferSelect;

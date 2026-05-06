import { pgTable, text, serial, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sessionsTable } from "./sessions";

export const modelVersionsTable = pgTable(
  "model_versions",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id").notNull().references(() => sessionsTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    modelId: integer("model_id"),
    snapshot: jsonb("snapshot").notNull(),
    reason: text("reason").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    bySessionKind: index("model_versions_session_kind_idx").on(table.sessionId, table.kind, table.modelId),
  }),
);

export const insertModelVersionSchema = createInsertSchema(modelVersionsTable).omit({ id: true, createdAt: true });
export type ModelVersion = typeof modelVersionsTable.$inferSelect;
export type InsertModelVersion = z.infer<typeof insertModelVersionSchema>;

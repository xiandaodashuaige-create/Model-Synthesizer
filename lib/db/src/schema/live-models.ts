import { pgTable, text, serial, timestamp, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sessionsTable, papersTable } from "./sessions";
import { variablesTable } from "./variables";
import { researchModelsTable } from "./models";

// One LiveModel per session — the user's own evolving research model,
// assembled by picking variables/edges from AI candidate models and adding their own.
export const liveModelsTable = pgTable("live_models", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessionsTable.id, { onDelete: "cascade" }).unique(),
  notes: text("notes").notNull().default(""),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const liveModelNodesTable = pgTable(
  "live_model_nodes",
  {
    id: serial("id").primaryKey(),
    liveModelId: integer("live_model_id").notNull().references(() => liveModelsTable.id, { onDelete: "cascade" }),
    variableId: integer("variable_id").notNull().references(() => variablesTable.id, { onDelete: "cascade" }),
    // Origin tracking
    sourceModelId: integer("source_model_id").references(() => researchModelsTable.id, { onDelete: "set null" }),
    userAdded: boolean("user_added").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueVarPerLiveModel: uniqueIndex("live_model_nodes_unique_var").on(table.liveModelId, table.variableId),
  }),
);

// Each edge MUST have provenance (a paper backing it) OR be flagged as user-added (manual).
// This is enforced in the API layer for ergonomic error messages.
export const liveModelEdgesTable = pgTable("live_model_edges", {
  id: serial("id").primaryKey(),
  liveModelId: integer("live_model_id").notNull().references(() => liveModelsTable.id, { onDelete: "cascade" }),
  fromVariableId: integer("from_variable_id").notNull().references(() => variablesTable.id, { onDelete: "cascade" }),
  toVariableId: integer("to_variable_id").notNull().references(() => variablesTable.id, { onDelete: "cascade" }),
  relationship: text("relationship").notNull(), // positive | negative | mediates | moderates
  // Provenance
  provenancePaperId: integer("provenance_paper_id").references(() => papersTable.id, { onDelete: "set null" }),
  provenanceCitationText: text("provenance_citation_text"),
  provenanceFigureThumbnailUrl: text("provenance_figure_thumbnail_url"),
  provenanceFigureSourceUrl: text("provenance_figure_source_url"),
  provenanceFigureSourceDomain: text("provenance_figure_source_domain"),
  confidence: text("confidence").notNull().default("medium"), // high | medium | low
  // Origin tracking
  sourceModelId: integer("source_model_id").references(() => researchModelsTable.id, { onDelete: "set null" }),
  userAdded: boolean("user_added").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertLiveModelSchema = createInsertSchema(liveModelsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertLiveModelNodeSchema = createInsertSchema(liveModelNodesTable).omit({ id: true, createdAt: true });
export const insertLiveModelEdgeSchema = createInsertSchema(liveModelEdgesTable).omit({ id: true, createdAt: true });

export type LiveModel = typeof liveModelsTable.$inferSelect;
export type LiveModelNode = typeof liveModelNodesTable.$inferSelect;
export type LiveModelEdge = typeof liveModelEdgesTable.$inferSelect;
export type InsertLiveModel = z.infer<typeof insertLiveModelSchema>;
export type InsertLiveModelNode = z.infer<typeof insertLiveModelNodeSchema>;
export type InsertLiveModelEdge = z.infer<typeof insertLiveModelEdgeSchema>;

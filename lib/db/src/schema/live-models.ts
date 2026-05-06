import { pgTable, text, serial, timestamp, integer, boolean, uniqueIndex, doublePrecision, jsonb } from "drizzle-orm/pg-core";
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
    // Canvas position persisted per node so user-arranged layouts survive reloads.
    // Null means "no manual layout yet — fall back to dagre auto-layout on the client".
    positionX: doublePrecision("position_x"),
    positionY: doublePrecision("position_y"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueVarPerLiveModel: uniqueIndex("live_model_nodes_unique_var").on(table.liveModelId, table.variableId),
  }),
);

// Each edge MUST have provenance (a paper backing it) OR be flagged as user-added (manual).
// This is enforced in the API layer for ergonomic error messages.
export const liveModelEdgesTable = pgTable(
  "live_model_edges",
  {
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
    // For relationship="moderates": optional pointer to the OTHER edge that this one moderates.
    // When set, the canvas reroutes the moderator's arrow to land on the midpoint of the
    // referenced edge (visually conveying "this moderates the A→B relationship", not the node).
    // Self-FK with set-null cascade so deleting the moderated edge doesn't break the moderator.
    moderatesEdgeId: integer("moderates_edge_id").references((): any => liveModelEdgesTable.id, { onDelete: "set null" }),
    // Extra evidence rows attached after the fact via the AI evidence-matching feature.
    // Schema: Array<{ paperId, paperTitle, paperAuthors, paperYear, citationText, source: "library"|"web", score? }>
    additionalEvidence: jsonb("additional_evidence").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // No two edges in the same live model may share the same (from, to, relationship) triple.
    // This is the structural defense that previously was only attempted (and incorrectly) at
    // the application layer in import-from-model: the dedup key there used sourceModelId, so
    // user-added edges and edges from a different source model would collide-import as
    // duplicates whenever the user clicked "作为我的研究模型基础" (replace=false) more than once
    // or after manual edits. With this index, all insert paths are forced to be idempotent
    // via onConflictDoNothing.
    uniqueRelPerLiveModel: uniqueIndex("live_model_edges_unique_rel").on(
      table.liveModelId,
      table.fromVariableId,
      table.toVariableId,
      table.relationship,
    ),
  }),
);

export const insertLiveModelSchema = createInsertSchema(liveModelsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertLiveModelNodeSchema = createInsertSchema(liveModelNodesTable).omit({ id: true, createdAt: true });
export const insertLiveModelEdgeSchema = createInsertSchema(liveModelEdgesTable).omit({ id: true, createdAt: true });

export type LiveModel = typeof liveModelsTable.$inferSelect;
export type LiveModelNode = typeof liveModelNodesTable.$inferSelect;
export type LiveModelEdge = typeof liveModelEdgesTable.$inferSelect;
export type InsertLiveModel = z.infer<typeof insertLiveModelSchema>;
export type InsertLiveModelNode = z.infer<typeof insertLiveModelNodeSchema>;
export type InsertLiveModelEdge = z.infer<typeof insertLiveModelEdgeSchema>;

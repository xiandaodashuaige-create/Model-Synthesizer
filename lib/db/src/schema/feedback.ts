import { pgTable, text, serial, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { sessionsTable } from "./sessions";

export const generationFeedbackTable = pgTable("generation_feedback", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessionsTable.id, { onDelete: "cascade" }),
  userPrompt: text("user_prompt").notNull().default(""),
  numModelsRequested: integer("num_models_requested").notNull().default(3),
  generatedModelNames: text("generated_model_names").array().notNull().default([]),
  selectedModelSnapshot: jsonb("selected_model_snapshot"),
  userEditedSnapshot: jsonb("user_edited_snapshot"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type GenerationFeedback = typeof generationFeedbackTable.$inferSelect;

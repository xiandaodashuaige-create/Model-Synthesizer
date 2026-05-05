import { pgTable, text, serial, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const sessionsTable = pgTable("sessions", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  topic: text("topic").notNull(),
  status: text("status").notNull().default("searching"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSessionSchema = createInsertSchema(sessionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessionsTable.$inferSelect;

export const papersTable = pgTable("papers", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessionsTable.id, { onDelete: "cascade" }),
  externalId: text("external_id").notNull(),
  title: text("title").notNull(),
  abstract: text("abstract"),
  authors: text("authors").array().notNull().default([]),
  year: integer("year"),
  venue: text("venue"),
  citationCount: integer("citation_count"),
  openAccessUrl: text("open_access_url"),
  url: text("url").notNull(),
  fullText: text("full_text"),
  extracted: text("extracted").notNull().default("false"),
  researchModel: jsonb("research_model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPaperSchema = createInsertSchema(papersTable).omit({ id: true, createdAt: true });
export type InsertPaper = z.infer<typeof insertPaperSchema>;
export type Paper = typeof papersTable.$inferSelect;

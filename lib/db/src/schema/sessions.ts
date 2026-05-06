import { pgTable, text, serial, timestamp, integer, jsonb, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";

export const sessionsTable = pgTable("sessions", {
  id: serial("id").primaryKey(),
  // Owning user. NULLable so existing rows (created before auth was added)
  // remain readable. New sessions always set this to the creating user.
  // Routes treat NULL-owner rows as "legacy / shared" — visible to any
  // authenticated user but not editable cross-user.
  userId: varchar("user_id").references(() => usersTable.id, { onDelete: "set null" }),
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
  figureResults: jsonb("figure_results"),
  figuresFetchedAt: timestamp("figures_fetched_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPaperSchema = createInsertSchema(papersTable).omit({ id: true, createdAt: true });
export type InsertPaper = z.infer<typeof insertPaperSchema>;
export type Paper = typeof papersTable.$inferSelect;

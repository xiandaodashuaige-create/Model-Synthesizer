import { pgTable, text, serial, timestamp, integer, jsonb, varchar, boolean } from "drizzle-orm/pg-core";
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
  // Innovation Layer (Phase 1+). See docs/innovation-taxonomy.md "Field naming
  // contract". Carries:
  //   - theoryClusters: Array<{id, label, theoryIds[], paperCount}>
  //   - gapReport: { version, generatedAt, gaps: Array<{type, summary, evidence}>, topGapTypes }
  //   - lastRebuildAt: ISO string
  //   - landscapeVersion: integer (mirrored on constructRelationshipsTable rows for cache-busting)
  // NULL until the first rebuildLandscape() runs for this session.
  landscapeMeta: jsonb("landscape_meta"),
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
  // "academic" for OpenAlex / PDF papers; "industry_report" / "gov_report" /
  // "whitepaper" / "other" for externally-added documents (Task #37).
  // NULL on pre-existing rows — treat as "academic" everywhere.
  sourceType: text("source_type").default("academic"),
  extracted: text("extracted").notNull().default("false"),
  researchModel: jsonb("research_model"),
  figureResults: jsonb("figure_results"),
  figuresFetchedAt: timestamp("figures_fetched_at", { withTimezone: true }),
  // Innovation Layer (Phase 1+). Populated during variable extraction
  // alongside variables + hypotheses; see docs/innovation-taxonomy.md
  // "Per-paper extraction additions" for the prompt contract.
  //
  // theoryBackbone: Array<{ id?: string, name: string, role: "primary"|"secondary", citationText?: string }>
  //   The named theories the paper anchors itself in (e.g. "Theory of Planned
  //   Behavior", "Stimulus-Organism-Response"). Drives the per-session theory
  //   cluster computation in landscapeMeta.theoryClusters.
  //
  // statedGaps: Array<{ type: "mechanism"|"boundary"|"integration"|"correction"|"construct"|"context",
  //                     statement: string, citationText?: string, pageOrSection?: string }>
  //   Gaps the AUTHORS explicitly call out in their own paper. Used as
  //   ground-truth seed for the per-session gap report — auto-detected
  //   gaps that align with at least one paper's stated gap get a
  //   confidence boost.
  //
  // studyContext: { objectType: string, sampleType?: string, geography?: string,
  //                 platform?: string, modality?: string, language?: string }
  //   Structured study setting; objectType is what the paper STUDIES (e.g.
  //   "AI streamer", "chatbot", "voice assistant"). Drives the
  //   `context_transferred` novelty tag and the constructRelationships
  //   table's domainsCovered aggregate.
  //
  // All NULL until the paper has been re-extracted under the Phase 1
  // prompt — older papers extracted pre-Phase 1 retain their existing
  // variables/hypotheses but produce empty entries in these three columns.
  theoryBackbone: jsonb("theory_backbone"),
  statedGaps: jsonb("stated_gaps"),
  studyContext: jsonb("study_context"),
  // Innovation Layer Phase 1+ — tangential-paper governance.
  //
  // The extraction prompt now performs a SCOPE CHECK against the session's
  // topic and emits a three-state scopeStatus. When the AI returns a
  // high-confidence "out_of_scope" verdict AND the server-side corroboration
  // gate (multi-signal: title/abstract terms, objectType, variable shape,
  // canonical-construct overlap) agrees, the paper is marked tangential.
  //
  // Tangential papers are NOT re-extracted: extracted stays "true" and
  // variables/hypotheses arrays are written empty so the on-demand "extract
  // all" loop never re-attacks them. They remain visible in the papers list
  // but are filtered out of every "real literature" read site (landscape
  // rebuild, model generation, paper count, personalization), in lock-step
  // with the existing manual:%-sentinel filter.
  //
  // - tangential: true means "drop from corpus" (high-confidence out-of-scope).
  // - scopeStatus: "in_scope" | "out_of_scope" | "uncertain" — kept verbatim
  //   from the AI's scopeCheck even when we DON'T tangential-flag (so a
  //   reviewer can audit borderline calls).
  // - topicFitScore: 0–100 — how well the paper's research object/variables
  //   FIT the session topic (semantic match, NOT confidence in the verdict).
  //   high = strong fit; low = weak fit. Independent of scopeStatus.
  // - scopeConfidence: 0–100 — how confident the AI is in the scopeStatus
  //   verdict ITSELF. e.g. "uncertain + scopeConfidence=90" means "I am very
  //   sure this is borderline", NOT "90% topic fit".
  // - scopeScore: DEPRECATED — kept for back-compat reads. New writes set
  //   scopeScore = scopeConfidence so existing callers see no behavior change
  //   while we migrate read sites. Will be removed once all readers move to
  //   topicFitScore + scopeConfidence.
  // - tangentialReason: short human-readable rationale for the UI badge.
  tangential: boolean("tangential").notNull().default(false),
  tangentialReason: text("tangential_reason"),
  scopeStatus: text("scope_status"),
  scopeScore: integer("scope_score"),
  topicFitScore: integer("topic_fit_score"),
  scopeConfidence: integer("scope_confidence"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPaperSchema = createInsertSchema(papersTable).omit({ id: true, createdAt: true });
export type InsertPaper = z.infer<typeof insertPaperSchema>;
export type Paper = typeof papersTable.$inferSelect;

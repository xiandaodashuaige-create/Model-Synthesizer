import { pgTable, text, serial, timestamp, integer, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sessionsTable } from "./sessions";

// Per-session aggregate of every directional construct relationship the
// papers in this session collectively assert. Rebuilt by
// rebuildLandscape(sessionId) (server-side, debounced after extraction
// completes). NOT a derived view — it is stored so the Innovation Layer's
// novelty/gap/contribution endpoints can answer "is this edge saturated?"
// in O(1) without re-walking paperHypothesesTable.
//
// Aggregation key = (canonicalFrom + contextQualifierFrom) -> (canonicalTo +
// contextQualifierTo) at a single relationshipType. See
// docs/innovation-taxonomy.md "Three-layer canonicalize spec" + "Field naming
// contract".
export const constructRelationshipsTable = pgTable(
  "construct_relationships",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessionsTable.id, { onDelete: "cascade" }),

    // Layer-2 canonicalNames of the two endpoints (sans qualifier). Used both
    // as join keys and as the user-facing display string when contextQualifier
    // is null.
    canonicalFrom: text("canonical_from").notNull(),
    canonicalTo: text("canonical_to").notNull(),

    // Layer-3 qualifiers — null when the construct name carries no
    // "in/of/for ..." clause. Two papers studying "trust in AI streamer" vs
    // "trust in platform" become DIFFERENT rows here; both can still be
    // rolled up via constructFamily (= canonicalName) when needed.
    contextQualifierFrom: text("context_qualifier_from"),
    contextQualifierTo: text("context_qualifier_to"),

    // "direct" | "mediation" | "moderation" — see docs/innovation-taxonomy.md
    // Hard Rule #19 + Phase 1 prompt. A moderator edge is stored as a
    // separate row (relationshipType = "moderation") with canonicalFrom = W,
    // canonicalTo = ... — the (X, Y) it moderates lives in supportingPapers
    // metadata.
    relationshipType: text("relationship_type").notNull(),

    // Aggregated sign: "positive" | "negative" | "mixed" | "none". "none" only
    // applies to relationshipType="moderation" (sign meaningless for moderators).
    // Set to "mixed" + signConflict=true when ≥2 papers disagree.
    sign: text("sign").notNull(),
    signConflict: boolean("sign_conflict").notNull().default(false),

    // Number of distinct supporting papers (= supportingPapers.length).
    // Denormalized so the novelty-tag SQL doesn't have to count jsonb arrays.
    totalOccurrences: integer("total_occurrences").notNull().default(0),

    // Per-paper evidence carried for downstream novelty tagging + UI tooltip.
    // Shape: Array<{ paperId, externalId, year, sign, statement, hypothesisId,
    // pageOrSection, studyContextSnapshot }>.
    supportingPapers: jsonb("supporting_papers").notNull().default([]),

    // Year span of supporting papers (cheap pre-compute for "first studied"
    // / "most recent" annotations on the landscape page).
    earliestYear: integer("earliest_year"),
    latestYear: integer("latest_year"),

    // Distinct studyContext.objectType values across supporting papers.
    // Empty array when no paper carried structured context. Used by the
    // `context_transferred` novelty tag detector.
    domainsCovered: jsonb("domains_covered").notNull().default([]),

    // Bracketed novelty potential per docs/innovation-taxonomy.md
    // (0 → 100, 1 → 75, 2-3 → 50, 4-6 → 25, 7+ → 10). Recomputed every
    // rebuild, indexed for cheap "all underexplored edges" scans.
    noveltyPotentialScore: integer("novelty_potential_score").notNull().default(100),

    // Monotonic version counter incremented on every full rebuild. Used to
    // cache-bust the AI gap report and any /landscape/* endpoints downstream.
    landscapeVersion: integer("landscape_version").notNull().default(1),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    sessionIdx: index("construct_relationships_session_idx").on(t.sessionId),
    sessionTypeIdx: index("construct_relationships_session_type_idx").on(t.sessionId, t.relationshipType),
    // Aggregation uniqueness: one row per (session, from-key, to-key, type).
    // contextQualifier columns are included so qualified vs unqualified rows
    // never collide. NULLs are treated as distinct in Postgres unique
    // indexes, which matches the intended behaviour: "trust" (no qualifier)
    // is its own row separate from "trust|ai streamer".
    uniqAggregation: uniqueIndex("construct_relationships_unique_aggregation").on(
      t.sessionId,
      t.canonicalFrom,
      t.contextQualifierFrom,
      t.canonicalTo,
      t.contextQualifierTo,
      t.relationshipType,
    ),
  }),
);

export const insertConstructRelationshipSchema = createInsertSchema(constructRelationshipsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertConstructRelationship = z.infer<typeof insertConstructRelationshipSchema>;
export type ConstructRelationship = typeof constructRelationshipsTable.$inferSelect;

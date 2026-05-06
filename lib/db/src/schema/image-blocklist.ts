import { pgTable, text, serial, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sessionsTable } from "./sessions";

export const imageBlocklistTable = pgTable(
  "image_blocklist",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id").notNull().references(() => sessionsTable.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url").notNull(),
    sourceDomain: text("source_domain").notNull(),
    title: text("title"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionIdx: index("image_blocklist_session_idx").on(t.sessionId),
    sessionUrlUnique: uniqueIndex("image_blocklist_session_url_unique").on(t.sessionId, t.sourceUrl),
  }),
);

export const insertImageBlocklistSchema = createInsertSchema(imageBlocklistTable).omit({ id: true, createdAt: true });
export type InsertImageBlocklistEntry = z.infer<typeof insertImageBlocklistSchema>;
export type ImageBlocklistEntry = typeof imageBlocklistTable.$inferSelect;

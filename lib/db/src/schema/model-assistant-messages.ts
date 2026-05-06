import { pgTable, text, serial, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { sessionsTable } from "./sessions";

export const modelAssistantMessagesTable = pgTable(
  "model_assistant_messages",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id").notNull().references(() => sessionsTable.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    attachments: jsonb("attachments"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionIdx: index("model_assistant_messages_session_idx").on(t.sessionId, t.id),
  }),
);

export type ModelAssistantMessage = typeof modelAssistantMessagesTable.$inferSelect;

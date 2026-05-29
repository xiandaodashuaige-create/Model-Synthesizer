import { boolean, pgTable, serial, timestamp } from "drizzle-orm/pg-core";

// Singleton settings row (always id=1). Insertions are handled by the
// migration seed; the row is upserted on first read if absent.
export const systemSettingsTable = pgTable("system_settings", {
  id: serial("id").primaryKey(),
  aiEnabled: boolean("ai_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

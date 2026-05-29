// Global AI kill-switch.
//
// Reads `system_settings.ai_enabled` from the DB and caches the result in
// memory for CACHE_TTL_MS so that every AI request doesn't hit the DB.
// Invalidated immediately when the admin toggles the flag.

import { type Request, type Response, type NextFunction } from "express";
import { db, systemSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const CACHE_TTL_MS = 5_000;

let _cachedEnabled: boolean | null = null;
let _cacheExpiresAt = 0;

async function _readFromDb(): Promise<boolean> {
  const [row] = await db
    .select({ aiEnabled: systemSettingsTable.aiEnabled })
    .from(systemSettingsTable)
    .where(eq(systemSettingsTable.id, 1))
    .limit(1);

  if (row) return row.aiEnabled;

  // No row yet — seed the singleton and return the default (enabled).
  await db
    .insert(systemSettingsTable)
    .values({ id: 1, aiEnabled: true })
    .onConflictDoNothing();
  return true;
}

export async function isAiEnabled(): Promise<boolean> {
  const now = Date.now();
  if (_cachedEnabled !== null && now < _cacheExpiresAt) return _cachedEnabled;

  try {
    _cachedEnabled = await _readFromDb();
  } catch (err) {
    logger.warn({ err }, "ai-gate: DB read failed, defaulting to enabled");
    _cachedEnabled = true;
  }
  _cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return _cachedEnabled;
}

/** Invalidate the in-memory cache so the next request re-reads from DB. */
export function invalidateAiGateCache(): void {
  _cachedEnabled = null;
  _cacheExpiresAt = 0;
}

// ---------------------------------------------------------------------------
// Routes that carry AI cost — only POST/PUT requests are checked.
// GET requests (reads) always pass through.
// ---------------------------------------------------------------------------
const AI_PATHS =
  /\/(model-assistant(?:\/|$)|models\/generate|models\/score-papers|landscape\/gap-report|models\/\d+\/(recompute-innovation|generate-contribution|refine-contribution|ai-review|reviewer-chat|evidence-search)|papers(?:\/\d+)?\/extract)/;

export async function aiGate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.method !== "POST" && req.method !== "PUT") {
    next();
    return;
  }
  if (!AI_PATHS.test(req.path)) {
    next();
    return;
  }

  const enabled = await isAiEnabled();
  if (enabled) {
    next();
  } else {
    res.status(503).json({
      error: "ai_disabled",
      message: "AI 服务当前已关闭，所有 AI 调用已暂停。请联系管理员开启。",
    });
  }
}

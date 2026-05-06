import { type Request, type Response, type NextFunction } from "express";
import { eq, or, isNull, and, type SQL } from "drizzle-orm";
import { db, sessionsTable } from "@workspace/db";
import { requireAuth } from "./authMiddleware";

// Visibility rule: a logged-in user sees their own sessions plus any
// "legacy" rows whose userId is NULL (unclaimed pre-auth data).
export function sessionVisibilityFilter(userId: string): SQL {
  return or(eq(sessionsTable.userId, userId), isNull(sessionsTable.userId))!;
}

// Loads the session at req.params.id, enforces auth + ownership, and stashes
// it on `res.locals.session`. Sends 401/400/404/403 itself on failure.
export async function loadAuthorizedSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!requireAuth(req, res)) return;
  const sessionId = Number(req.params["id"]);
  if (!Number.isFinite(sessionId) || sessionId <= 0) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const [session] = await db
    .select()
    .from(sessionsTable)
    .where(and(eq(sessionsTable.id, sessionId), sessionVisibilityFilter(req.user!.id)));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.locals["session"] = session;
  res.locals["sessionId"] = sessionId;
  next();
}

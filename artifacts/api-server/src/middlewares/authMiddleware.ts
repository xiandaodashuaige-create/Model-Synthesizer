import * as oidc from "openid-client";
import { type Request, type Response, type NextFunction } from "express";
import type { AuthUser } from "../lib/auth";
import {
  clearOidcSession,
  getOidcConfig,
  getSessionId,
  getOidcSession,
  updateOidcSession,
  type SessionData,
} from "../lib/auth";

declare global {
  namespace Express {
    interface User {
      id: string;
      email?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      profileImageUrl?: string | null;
    }

    interface Request {
      isAuthenticated(): this is AuthedRequest;
      user?: User | undefined;
    }

    export interface AuthedRequest {
      user: User;
    }
  }
}

async function refreshIfExpired(
  sid: string,
  session: SessionData,
): Promise<SessionData | null> {
  const now = Math.floor(Date.now() / 1000);
  if (!session.expires_at || now <= session.expires_at) return session;
  if (!session.refresh_token) return null;

  try {
    const config = await getOidcConfig();
    const tokens = await oidc.refreshTokenGrant(config, session.refresh_token);
    session.access_token = tokens.access_token;
    session.refresh_token = tokens.refresh_token ?? session.refresh_token;
    session.expires_at = tokens.expiresIn()
      ? now + tokens.expiresIn()!
      : session.expires_at;
    await updateOidcSession(sid, session);
    return session;
  } catch {
    return null;
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  req.isAuthenticated = function (this: Request) {
    return this.user != null;
  } as Request["isAuthenticated"];

  const sid = getSessionId(req);
  if (!sid) {
    next();
    return;
  }

  const session = await getOidcSession(sid);
  if (!session?.user?.id) {
    await clearOidcSession(res, sid);
    next();
    return;
  }

  const refreshed = await refreshIfExpired(sid, session);
  if (!refreshed) {
    await clearOidcSession(res, sid);
    next();
    return;
  }

  req.user = refreshed.user;
  next();
}

// Helper: require auth on a route. Call at the top of a handler. Returns true
// if the request is authenticated; otherwise sends 401 and returns false.
export function requireAuth(req: Request, res: Response): req is Request & { user: AuthUser } {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// Helper: require auth + whitelist approval. Returns true if authenticated
// AND the user has been approved by an admin. Otherwise sends 401/403.
// Import `db` and `usersTable` at the call site if you need DB-level checks;
// this helper does a lightweight session-only check and relies on the
// `loadAuthorizedSession` pattern that already queries the DB per route.
// For a simple fast-path check without an extra DB round-trip use:
//   if (!requireAuth(req, res)) return;
//   if (!userApproved) { res.status(403)... }
// The actual per-request approval gate is enforced in the global middleware
// registered in index.ts via `approvalGate`.
export function requireApproved(req: Request, res: Response): req is Request & { user: AuthUser } {
  if (!requireAuth(req, res)) return false;
  return true;
}

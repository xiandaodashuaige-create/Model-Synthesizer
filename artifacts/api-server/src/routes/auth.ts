import * as oidc from "openid-client";
import { Router, type IRouter, type Request, type Response } from "express";
import { GetCurrentAuthUserResponse } from "@workspace/api-zod";
import { db, usersTable, sessionsTable } from "@workspace/db";
import { eq, isNull, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/authMiddleware";
import {
  clearOidcSession,
  getOidcConfig,
  getSessionId,
  createOidcSession,
  SESSION_COOKIE,
  SESSION_TTL,
  type SessionData,
} from "../lib/auth";

const OIDC_COOKIE_TTL = 10 * 60 * 1000;

const router: IRouter = Router();

function getOrigin(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers["host"] || "localhost";
  return `${proto}://${host}`;
}

function setSessionCookie(res: Response, sid: string) {
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

function setOidcCookie(res: Response, name: string, value: string) {
  res.cookie(name, value, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: OIDC_COOKIE_TTL,
  });
}

function getSafeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

async function upsertUser(claims: Record<string, unknown>) {
  const userData = {
    id: claims["sub"] as string,
    email: (claims["email"] as string) || null,
    firstName: (claims["first_name"] as string) || null,
    lastName: (claims["last_name"] as string) || null,
    profileImageUrl: (claims["profile_image_url"] || claims["picture"]) as string | null,
  };

  const [existingCount] = await db.select({ c: sql<number>`count(*)::int` }).from(usersTable);
  const isFirstUser = (existingCount?.c ?? 0) === 0;

  const [user] = await db
    .insert(usersTable)
    .values({
      ...userData,
      // The very first user to sign in becomes admin and is auto-approved.
      approved: isFirstUser,
      isAdmin: isFirstUser,
    })
    .onConflictDoUpdate({
      target: usersTable.id,
      set: { ...userData, updatedAt: new Date() },
    })
    .returning();

  // One-time backfill: when the very first user signs in, claim ownership of
  // any pre-existing research sessions that have no userId. After that, new
  // legacy NULL rows can only appear if an admin created them by hand, which
  // we don't auto-claim.
  if (isFirstUser && user) {
    await db
      .update(sessionsTable)
      .set({ userId: user.id })
      .where(isNull(sessionsTable.userId));
  }

  return user;
}

router.get("/auth/user", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.json(GetCurrentAuthUserResponse.parse({ user: null }));
    return;
  }
  // Fetch fresh approved/isAdmin from DB so the client always has current status.
  const [dbUser] = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      profileImageUrl: usersTable.profileImageUrl,
      approved: usersTable.approved,
      isAdmin: usersTable.isAdmin,
    })
    .from(usersTable)
    .where(eq(usersTable.id, req.user.id));

  res.json(
    GetCurrentAuthUserResponse.parse({
      user: dbUser ?? null,
    }),
  );
});

// ---------------------------------------------------------------------------
// Admin routes — list all users, approve / revoke access
// ---------------------------------------------------------------------------

router.get("/admin/users", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const [me] = await db.select({ isAdmin: usersTable.isAdmin }).from(usersTable).where(eq(usersTable.id, req.user.id));
  if (!me?.isAdmin) { res.status(403).json({ error: "Forbidden" }); return; }

  const users = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      profileImageUrl: usersTable.profileImageUrl,
      approved: usersTable.approved,
      isAdmin: usersTable.isAdmin,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .orderBy(usersTable.createdAt);

  res.json({ users });
});

router.post("/admin/users/:userId/approve", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const [me] = await db.select({ isAdmin: usersTable.isAdmin }).from(usersTable).where(eq(usersTable.id, req.user.id));
  if (!me?.isAdmin) { res.status(403).json({ error: "Forbidden" }); return; }

  const userId = String(req.params.userId);
  const { approved } = req.body as { approved: boolean };

  const [updated] = await db
    .update(usersTable)
    .set({ approved: Boolean(approved), updatedAt: new Date() })
    .where(eq(usersTable.id, userId))
    .returning({
      id: usersTable.id,
      email: usersTable.email,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      profileImageUrl: usersTable.profileImageUrl,
      approved: usersTable.approved,
      isAdmin: usersTable.isAdmin,
      createdAt: usersTable.createdAt,
    });

  if (!updated) { res.status(404).json({ error: "User not found" }); return; }
  res.json(updated);
});

router.get("/login", async (req: Request, res: Response) => {
  const config = await getOidcConfig();
  const callbackUrl = `${getOrigin(req)}/api/callback`;
  const returnTo = getSafeReturnTo(req.query["returnTo"]);

  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

  const redirectTo = oidc.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl,
    scope: "openid email profile offline_access",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "login consent",
    state,
    nonce,
  });

  setOidcCookie(res, "code_verifier", codeVerifier);
  setOidcCookie(res, "nonce", nonce);
  setOidcCookie(res, "state", state);
  setOidcCookie(res, "return_to", returnTo);

  res.redirect(redirectTo.href);
});

router.get("/callback", async (req: Request, res: Response) => {
  const config = await getOidcConfig();
  const callbackUrl = `${getOrigin(req)}/api/callback`;

  const codeVerifier = req.cookies?.code_verifier;
  const nonce = req.cookies?.nonce;
  const expectedState = req.cookies?.state;

  if (!codeVerifier || !expectedState) {
    res.redirect("/api/login");
    return;
  }

  const currentUrl = new URL(
    `${callbackUrl}?${new URL(req.url, `http://${req.headers.host}`).searchParams}`,
  );

  let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
  try {
    tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedNonce: nonce,
      expectedState,
      idTokenExpected: true,
    });
  } catch {
    res.redirect("/api/login");
    return;
  }

  const returnTo = getSafeReturnTo(req.cookies?.return_to);

  res.clearCookie("code_verifier", { path: "/" });
  res.clearCookie("nonce", { path: "/" });
  res.clearCookie("state", { path: "/" });
  res.clearCookie("return_to", { path: "/" });

  const claims = tokens.claims();
  if (!claims) {
    res.redirect("/api/login");
    return;
  }

  const dbUser = await upsertUser(claims as unknown as Record<string, unknown>);

  const now = Math.floor(Date.now() / 1000);
  const sessionData: SessionData = {
    user: {
      id: dbUser!.id,
      email: dbUser!.email,
      firstName: dbUser!.firstName,
      lastName: dbUser!.lastName,
      profileImageUrl: dbUser!.profileImageUrl,
    },
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expiresIn() ? now + tokens.expiresIn()! : claims.exp,
  };

  const sid = await createOidcSession(sessionData);
  setSessionCookie(res, sid);
  res.redirect(returnTo);
});

router.get("/logout", async (req: Request, res: Response) => {
  const config = await getOidcConfig();
  const origin = getOrigin(req);
  const sid = getSessionId(req);
  await clearOidcSession(res, sid);

  const endSessionUrl = oidc.buildEndSessionUrl(config, {
    client_id: process.env["REPL_ID"]!,
    post_logout_redirect_uri: origin,
  });
  res.redirect(endSessionUrl.href);
});

// ---------------------------------------------------------------------------
// Admin settings — global AI kill-switch
// ---------------------------------------------------------------------------
import { systemSettingsTable } from "@workspace/db";
import { invalidateAiGateCache } from "../lib/ai-gate";

router.get("/admin/settings", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const [me] = await db.select({ isAdmin: usersTable.isAdmin }).from(usersTable).where(eq(usersTable.id, req.user.id));
  if (!me?.isAdmin) { res.status(403).json({ error: "Forbidden" }); return; }

  let [row] = await db
    .select({ aiEnabled: systemSettingsTable.aiEnabled, updatedAt: systemSettingsTable.updatedAt })
    .from(systemSettingsTable)
    .where(eq(systemSettingsTable.id, 1))
    .limit(1);

  if (!row) {
    await db.insert(systemSettingsTable).values({ id: 1, aiEnabled: true }).onConflictDoNothing();
    [row] = await db
      .select({ aiEnabled: systemSettingsTable.aiEnabled, updatedAt: systemSettingsTable.updatedAt })
      .from(systemSettingsTable)
      .where(eq(systemSettingsTable.id, 1))
      .limit(1);
  }

  res.json(row);
});

router.post("/admin/settings", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const [me] = await db.select({ isAdmin: usersTable.isAdmin }).from(usersTable).where(eq(usersTable.id, req.user.id));
  if (!me?.isAdmin) { res.status(403).json({ error: "Forbidden" }); return; }

  const { aiEnabled } = req.body as { aiEnabled: boolean };

  await db
    .insert(systemSettingsTable)
    .values({ id: 1, aiEnabled: Boolean(aiEnabled), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: systemSettingsTable.id,
      set: { aiEnabled: Boolean(aiEnabled), updatedAt: new Date() },
    });

  invalidateAiGateCache();

  const [updated] = await db
    .select({ aiEnabled: systemSettingsTable.aiEnabled, updatedAt: systemSettingsTable.updatedAt })
    .from(systemSettingsTable)
    .where(eq(systemSettingsTable.id, 1))
    .limit(1);

  res.json(updated);
});

export default router;

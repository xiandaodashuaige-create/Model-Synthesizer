import * as client from "openid-client";
import crypto from "crypto";
import { type Request, type Response } from "express";
import { db, authSessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export type AuthUser = {
  id: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  profileImageUrl?: string | null;
};

export const ISSUER_URL = process.env.ISSUER_URL ?? "https://replit.com/oidc";
export const SESSION_COOKIE = "sid";
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

export interface SessionData {
  user: AuthUser;
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
}

let oidcConfig: client.Configuration | null = null;

export async function getOidcConfig(): Promise<client.Configuration> {
  if (!oidcConfig) {
    oidcConfig = await client.discovery(
      new URL(ISSUER_URL),
      process.env["REPL_ID"]!,
    );
  }
  return oidcConfig;
}

export async function createOidcSession(data: SessionData): Promise<string> {
  const sid = crypto.randomBytes(32).toString("hex");
  await db.insert(authSessionsTable).values({
    sid,
    sess: data as unknown as Record<string, unknown>,
    expire: new Date(Date.now() + SESSION_TTL),
  });
  return sid;
}

export async function getOidcSession(sid: string): Promise<SessionData | null> {
  const [row] = await db
    .select()
    .from(authSessionsTable)
    .where(eq(authSessionsTable.sid, sid));

  if (!row || row.expire < new Date()) {
    if (row) await deleteOidcSession(sid);
    return null;
  }

  return row.sess as unknown as SessionData;
}

export async function updateOidcSession(
  sid: string,
  data: SessionData,
): Promise<void> {
  await db
    .update(authSessionsTable)
    .set({
      sess: data as unknown as Record<string, unknown>,
      expire: new Date(Date.now() + SESSION_TTL),
    })
    .where(eq(authSessionsTable.sid, sid));
}

export async function deleteOidcSession(sid: string): Promise<void> {
  await db.delete(authSessionsTable).where(eq(authSessionsTable.sid, sid));
}

export async function clearOidcSession(
  res: Response,
  sid?: string,
): Promise<void> {
  if (sid) await deleteOidcSession(sid);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function getSessionId(req: Request): string | undefined {
  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return req.cookies?.[SESSION_COOKIE];
}

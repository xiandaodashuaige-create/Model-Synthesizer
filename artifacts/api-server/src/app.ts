import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { authMiddleware } from "./middlewares/authMiddleware";
import { loadAuthorizedSession } from "./middlewares/sessionOwnership";
import { logger } from "./lib/logger";
import { aiGate } from "./lib/ai-gate";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ credentials: true, origin: true }));
app.use(cookieParser());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "6mb" }));
app.use(authMiddleware);

// ---------------------------------------------------------------------------
// Whitelist approval gate
// Routes that are always public (no approval needed):
//   GET /api/auth/user  — so the client can detect pending status
//   GET /api/login      — OIDC start
//   GET /api/callback   — OIDC return
//   GET /api/logout     — always allow sign-out
// All other /api/* routes require the user to be both authenticated AND approved.
// ---------------------------------------------------------------------------
const APPROVAL_EXEMPT = /^\/api\/(auth\/user|login|callback|logout)/;

async function approvalGate(req: Request, res: Response, next: NextFunction) {
  // Public routes & unauthenticated requests pass through (individual routes
  // already call requireAuth to gate themselves).
  if (APPROVAL_EXEMPT.test(req.path) || !req.isAuthenticated()) {
    next();
    return;
  }

  try {
    const [row] = await db
      .select({ approved: usersTable.approved, isAdmin: usersTable.isAdmin })
      .from(usersTable)
      .where(eq(usersTable.id, req.user.id));

    if (row?.approved || row?.isAdmin) {
      next();
    } else {
      res.status(403).json({ error: "pending_approval", message: "Your account is pending admin approval." });
    }
  } catch {
    // On DB error fail open (don't block the request) so a temporary DB issue
    // doesn't lock everyone out.
    next();
  }
}

app.use("/api", approvalGate);

// Global AI kill-switch — blocks AI-cost routes when admin has disabled AI.
app.use("/api", aiGate);

// Auth + ownership gate for ALL /api/sessions/:id/* (and /api/sessions/:sessionId/*).
// Individual route handlers can rely on res.locals.session being a session
// the caller is authorized to access.
app.use("/api/sessions/:id", loadAuthorizedSession);

app.use("/api", router);

export default app;

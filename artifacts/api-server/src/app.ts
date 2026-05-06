import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { authMiddleware } from "./middlewares/authMiddleware";
import { loadAuthorizedSession } from "./middlewares/sessionOwnership";
import { logger } from "./lib/logger";

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

// Auth + ownership gate for ALL /api/sessions/:id/* (and /api/sessions/:sessionId/*).
// Individual route handlers can rely on res.locals.session being a session
// the caller is authorized to access.
app.use("/api/sessions/:id", loadAuthorizedSession);

app.use("/api", router);

export default app;

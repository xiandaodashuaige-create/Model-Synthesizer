import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/authMiddleware";
import {
  getUserPersonalization,
  refreshUserPersonalization,
  resetUserPersonalization,
} from "../lib/personalization";

const router: IRouter = Router();

router.get("/me/personalization", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  try {
    const data = await getUserPersonalization(req.user!.id);
    res.json({
      profile: data.profile,
      counters: data.counters,
      lastRefreshedAt: data.lastRefreshedAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "GET /me/personalization failed");
    res.status(500).json({ error: "Failed to load personalization profile" });
  }
});

router.post("/me/personalization/refresh", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  try {
    const profile = await refreshUserPersonalization(req.user!.id);
    const data = await getUserPersonalization(req.user!.id);
    res.json({
      profile,
      counters: data.counters,
      lastRefreshedAt: data.lastRefreshedAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "POST /me/personalization/refresh failed");
    res.status(500).json({ error: "Failed to refresh personalization profile" });
  }
});

router.delete("/me/personalization", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  try {
    await resetUserPersonalization(req.user!.id);
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "DELETE /me/personalization failed");
    res.status(500).json({ error: "Failed to reset personalization profile" });
  }
});

export default router;

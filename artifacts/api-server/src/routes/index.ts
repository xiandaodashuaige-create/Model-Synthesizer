import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import sessionsRouter from "./sessions";
import papersRouter from "./papers";
import variablesRouter from "./variables";
import modelsRouter from "./models";
import modelAssistantRouter from "./model-assistant";
import liveModelRouter from "./live-model";
import aiUsageRouter from "./ai-usage";
import personalizationRouter from "./personalization";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(sessionsRouter);
router.use(papersRouter);
router.use(variablesRouter);
router.use(modelsRouter);
router.use(modelAssistantRouter);
router.use(liveModelRouter);
router.use(aiUsageRouter);
router.use(personalizationRouter);

export default router;

import { Router, type IRouter } from "express";
import healthRouter from "./health";
import sessionsRouter from "./sessions";
import papersRouter from "./papers";
import variablesRouter from "./variables";
import modelsRouter from "./models";
import modelAssistantRouter from "./model-assistant";
import liveModelRouter from "./live-model";

const router: IRouter = Router();

router.use(healthRouter);
router.use(sessionsRouter);
router.use(papersRouter);
router.use(variablesRouter);
router.use(modelsRouter);
router.use(modelAssistantRouter);
router.use(liveModelRouter);

export default router;

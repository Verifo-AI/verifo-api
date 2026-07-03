import { Router, type IRouter } from "express";
import healthRouter from "./health";
import nodesRouter from "./nodes";
import nodeClientRouter from "./nodeClient";
import tasksRouter from "./tasks";
import creditsRouter from "./credits";
import contributorsRouter from "./contributors";
import notificationsRouter from "./notifications";
import authRouter from "./auth";
import payoutsRouter from "./payouts";
import nodeProofsRouter from "./nodeProofs";

const router: IRouter = Router();

router.use(authRouter);
router.use(healthRouter);
router.use(nodesRouter);
router.use(nodeClientRouter);
router.use(tasksRouter);
router.use(creditsRouter);
router.use(contributorsRouter);
router.use(notificationsRouter);
router.use(payoutsRouter);
router.use(nodeProofsRouter);

export default router;

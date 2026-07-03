import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/jwtAuth";
import { db, nodesTable, payoutsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  sendUsdcPayout,
  isTreasuryConfigured,
  getTreasuryUsdcBalanceMicros,
} from "../lib/solanaTreasury";

const router: IRouter = Router();

// Anti-sybil / anti-drain guards: real money is moving here.
const MIN_PAYOUT_USDC_MICROS = 500_000; // $0.50 minimum (dust + gas protection)
const MIN_PAYOUT_INTERVAL_MS = 10 * 60 * 1000; // 10 min between payouts per node

router.get("/nodes/payout-info", requireAuth, async (req: any, res) => {
  try {
    const [node] = await db
      .select()
      .from(nodesTable)
      .where(eq(nodesTable.clerkUserId, req.userId))
      .limit(1);

    if (!node) {
      return res.status(404).json({ error: "No node registered. Register at /contributors/register." });
    }

    res.json({
      pendingRewardUsdc: node.pendingRewardUsdcMicros / 1_000_000,
      totalPaidUsdc: node.totalPaidUsdcMicros / 1_000_000,
      minPayoutUsdc: MIN_PAYOUT_USDC_MICROS / 1_000_000,
      lastPayoutAt: node.lastPayoutAt ? node.lastPayoutAt.toISOString() : null,
      treasuryConfigured: isTreasuryConfigured(),
      verified: node.verified,
    });
  } catch (err) {
    logger.error({ err }, "GET /nodes/payout-info error");
    res.status(500).json({ error: "Failed to fetch payout info" });
  }
});

router.post("/nodes/payout", requireAuth, async (req: any, res) => {
  if (!isTreasuryConfigured()) {
    return res.status(503).json({ error: "Payouts are not configured yet (treasury wallet missing)." });
  }

  try {
    const [node] = await db
      .select()
      .from(nodesTable)
      .where(eq(nodesTable.clerkUserId, req.userId))
      .limit(1);

    if (!node) {
      return res.status(404).json({ error: "No node registered." });
    }

    if (!node.verified) {
      return res.status(403).json({ error: "Node must be verified (linked via the real node client) before payouts." });
    }

    if (node.lastPayoutAt && Date.now() - node.lastPayoutAt.getTime() < MIN_PAYOUT_INTERVAL_MS) {
      const waitMs = MIN_PAYOUT_INTERVAL_MS - (Date.now() - node.lastPayoutAt.getTime());
      return res.status(429).json({ error: `Please wait ${Math.ceil(waitMs / 1000)}s before requesting another payout.` });
    }

    const amountMicros = node.pendingRewardUsdcMicros;
    if (amountMicros < MIN_PAYOUT_USDC_MICROS) {
      return res.status(400).json({
        error: `Minimum payout is $${(MIN_PAYOUT_USDC_MICROS / 1_000_000).toFixed(2)}. Current pending balance: $${(amountMicros / 1_000_000).toFixed(2)}.`,
      });
    }

    const treasuryBalanceMicros = await getTreasuryUsdcBalanceMicros();
    if (treasuryBalanceMicros < amountMicros) {
      logger.error({ treasuryBalanceMicros, amountMicros }, "Treasury has insufficient USDC for payout");
      return res.status(503).json({ error: "Treasury balance is too low to process this payout right now. Try again later." });
    }

    // Atomically claim the pending balance so a double-click or race can't
    // double-pay: only succeeds if the amount hasn't changed since we read it.
    const claimed = await db
      .update(nodesTable)
      .set({
        pendingRewardUsdcMicros: 0,
        lastPayoutAt: new Date(),
      })
      .where(sql`${nodesTable.id} = ${node.id} AND ${nodesTable.pendingRewardUsdcMicros} = ${amountMicros}`)
      .returning();

    if (claimed.length === 0) {
      return res.status(409).json({ error: "Balance changed, please retry." });
    }

    const [payoutRow] = await db
      .insert(payoutsTable)
      .values({
        nodeId: node.id,
        walletAddress: node.walletAddress,
        amountUsdcMicros: amountMicros,
        status: "pending",
      })
      .returning();

    try {
      const signature = await sendUsdcPayout(node.walletAddress, amountMicros);

      await db
        .update(payoutsTable)
        .set({ status: "completed", solanaTxSignature: signature, completedAt: new Date() })
        .where(eq(payoutsTable.id, payoutRow.id));

      await db
        .update(nodesTable)
        .set({ totalPaidUsdcMicros: sql`${nodesTable.totalPaidUsdcMicros} + ${amountMicros}` })
        .where(eq(nodesTable.id, node.id));

      res.json({
        success: true,
        amountUsdc: amountMicros / 1_000_000,
        solanaTxSignature: signature,
        solanaExplorerUrl: `https://explorer.solana.com/tx/${signature}`,
      });
    } catch (payoutErr: any) {
      logger.error({ err: payoutErr, nodeId: node.id }, "Real USDC payout failed, restoring pending balance");

      // Restore the claimed balance since the on-chain transfer didn't happen.
      await db
        .update(nodesTable)
        .set({
          pendingRewardUsdcMicros: sql`${nodesTable.pendingRewardUsdcMicros} + ${amountMicros}`,
          lastPayoutAt: null,
        })
        .where(eq(nodesTable.id, node.id));

      await db
        .update(payoutsTable)
        .set({ status: "failed", errorMessage: String(payoutErr?.message ?? payoutErr) })
        .where(eq(payoutsTable.id, payoutRow.id));

      res.status(502).json({ error: `Payout transaction failed: ${payoutErr?.message ?? "unknown error"}` });
    }
  } catch (err) {
    logger.error({ err }, "POST /nodes/payout error");
    res.status(500).json({ error: "Failed to process payout" });
  }
});

export default router;

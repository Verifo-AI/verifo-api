import { Router } from "express";
import { requireAuth } from "../middlewares/jwtAuth";
import { db } from "@workspace/db";
import { proofsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router = Router();

router.get("/proofs/:proofId", requireAuth, async (req: any, res) => {
  const { proofId } = req.params;

  try {
    const [proof] = await db
      .select()
      .from(proofsTable)
      .where(eq(proofsTable.proofId, proofId))
      .limit(1);

    if (!proof) return res.status(404).json({ error: "Proof not found" });

    if (proof.clerkUserId !== req.userId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    res.json({
      proofId: proof.proofId,
      taskId: proof.taskId,
      timestamp: proof.createdAt.toISOString(),
      modelIdentifier: proof.modelIdentifier,
      hashes: {
        promptHashSha256: proof.promptHashSha256,
        outputHashSha256: proof.outputHashSha256,
      },
      attestation: {
        computeNodeWallet: proof.computeNodeWallet,
        nodeSignature: proof.nodeSignature,
        verificationConsensus: proof.verificationConsensus,
        verifierCount: proof.verifierCount,
        verifierThreshold: 3,
      },
      solanaTransactionId: proof.solanaTransactionId,
      solanaExplorerUrl: `https://orbmarkets.io/tx/${proof.solanaTransactionId}`,
      verified: proof.verified,
    });
  } catch (err) {
    console.error("GET /proofs/:proofId error:", err);
    res.status(500).json({ error: "Failed to fetch proof" });
  }
});

export default router;

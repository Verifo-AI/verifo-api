import { Router } from "express";
import { requireAuth } from "../middlewares/jwtAuth";
import { db } from "@workspace/db";
import { nodesTable, nodeProofEventsTable, tasksTable } from "@workspace/db/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { authenticateNodeRequest } from "./nodeClient";
import { buildMemoText, buildUnsignedProofMessage, buildAndSubmitTreasuryOnlyProof, finalizeAndSubmitProof, type ProofEventType, type TaskCompletedSettlement, type RelatedWallets } from "../lib/solanaProofs";
import { CREDIT_USDC_MICROS } from "./tasks";

const router = Router();

const VALID_EVENT_TYPES: ProofEventType[] = ["connect", "disconnect", "task_assigned", "task_completed"];

// If the contributor node never manages to co-sign its own task_completed
// proof within this window (offline, crashed, flaky connection after
// finishing the task), the user should still see a real tx hash instead of
// waiting forever. After the timeout, the treasury broadcasts the same
// settlement memo alone and the proof is marked confirmed. Real work, real
// USDC reward and real on-chain settlement facts either way — only the
// *co-signature* is skipped when the node itself is unreachable.
const NODE_COSIGN_TIMEOUT_MS = 15_000;

async function fallbackToTreasuryOnlyProof(memoText: string): Promise<{ txSignature: string; memoText: string }> {
  const fallbackMemoText = `${memoText} (node did not co-sign in time; treasury attests alone)`;
  const txSignature = await buildAndSubmitTreasuryOnlyProof(fallbackMemoText);
  return { txSignature, memoText: fallbackMemoText };
}

// Fase 5: the node CLI calls this the moment a real event happens (connect,
// disconnect, task picked up, task completed). The server builds a real
// mainnet Solana transaction (Memo program) that the node must co-sign with
// its own key before it can be broadcast — see /nodes/proof/:id/submit.
router.post("/nodes/proof", async (req, res) => {
  try {
    const node = await authenticateNodeRequest(req, res, "verifo-request-proof");
    if (!node) return;

    const { eventType, taskId } = req.body ?? {};
    if (typeof eventType !== "string" || !VALID_EVENT_TYPES.includes(eventType as ProofEventType)) {
      return res.status(400).json({ error: `eventType must be one of: ${VALID_EVENT_TYPES.join(", ")}` });
    }

    let resolvedTaskId: string | null = null;
    let settlement: TaskCompletedSettlement | null = null;
    // Populated only for task_completed: lets the transaction itself carry
    // the requesting user's wallet and the earning node's reward wallet as
    // plain accounts, so the payer/payee relationship is verifiable
    // on-chain, not just asserted in the memo text.
    let relatedWallets: RelatedWallets | null = null;
    if (eventType === "task_assigned" || eventType === "task_completed") {
      if (typeof taskId !== "string" || !taskId) {
        return res.status(400).json({ error: "taskId is required for this event type" });
      }
      const [task] = await db.select().from(tasksTable).where(eq(tasksTable.taskId, taskId)).limit(1);
      if (!task || task.assignedNodeId !== node.id) {
        return res.status(404).json({ error: "Task not found for this node" });
      }
      resolvedTaskId = taskId;
      // For task_completed the /tasks handler already finished writing
      // creditsUsed + nodeRewardUsdcMicros before it let the node's
      // task-result response return (see waitForRewardFinalized), so these
      // numbers are guaranteed final by the time we read them here.
      if (eventType === "task_completed") {
        const totalPaidMicros = task.creditsUsed * CREDIT_USDC_MICROS;
        const rewardMicros = task.nodeRewardUsdcMicros ?? 0;
        settlement = {
          totalPaidUsdc: totalPaidMicros / 1_000_000,
          rewardUsdc: rewardMicros / 1_000_000,
          treasuryUsdc: Math.max(0, totalPaidMicros - rewardMicros) / 1_000_000,
        };
        // task.clerkUserId stores the requesting user's Solana wallet
        // address (see verifo-wallet-auth memory doc).
        relatedWallets = { userWallet: task.clerkUserId };
      }
    }

    const [nodeRow] = await db.select().from(nodesTable).where(eq(nodesTable.id, node.id)).limit(1);
    if (!nodeRow?.nodePublicKey) {
      return res.status(404).json({ error: "Node identity not found" });
    }
    if (relatedWallets) {
      relatedWallets.nodeWallet = nodeRow.walletAddress;
    }

    const memoText = buildMemoText(eventType as ProofEventType, nodeRow.nodePublicKey, resolvedTaskId, settlement, relatedWallets);
    const { messageBase64 } = await buildUnsignedProofMessage(nodeRow.nodePublicKey, memoText);

    const [proof] = await db
      .insert(nodeProofEventsTable)
      .values({
        nodeId: node.id,
        taskId: resolvedTaskId,
        eventType,
        status: "pending_signature",
        memoText,
        unsignedMessageBase64: messageBase64,
      })
      .returning();

    res.status(201).json({ proofId: proof!.id, messageBase64 });
  } catch (err: any) {
    console.error("POST /nodes/proof error:", err);
    res.status(503).json({ error: err?.message || "Failed to prepare on-chain proof" });
  }
});

// The node signs the message returned above locally, then posts the
// signature here. The server verifies it, co-signs as fee payer, and
// broadcasts to Solana mainnet.
router.post("/nodes/proof/:proofId/submit", async (req, res) => {
  try {
    const node = await authenticateNodeRequest(req, res, "verifo-submit-proof");
    if (!node) return;

    const proofId = parseInt(req.params.proofId, 10);
    const { nodeSignatureBase64 } = req.body ?? {};
    if (!Number.isFinite(proofId) || typeof nodeSignatureBase64 !== "string") {
      return res.status(400).json({ error: "proofId and nodeSignatureBase64 are required" });
    }

    const [proof] = await db.select().from(nodeProofEventsTable).where(eq(nodeProofEventsTable.id, proofId)).limit(1);
    if (!proof || proof.nodeId !== node.id) {
      return res.status(404).json({ error: "Proof not found for this node" });
    }
    if (proof.status !== "pending_signature") {
      return res.status(409).json({ error: `Proof is already ${proof.status}` });
    }

    const [nodeRow] = await db.select().from(nodesTable).where(eq(nodesTable.id, node.id)).limit(1);
    if (!nodeRow?.nodePublicKey) {
      return res.status(404).json({ error: "Node identity not found" });
    }

    try {
      const txSignature = await finalizeAndSubmitProof(proof.unsignedMessageBase64, nodeRow.nodePublicKey, nodeSignatureBase64);
      await db
        .update(nodeProofEventsTable)
        .set({ status: "confirmed", nodeSignatureBase64, txSignature, confirmedAt: new Date() })
        .where(eq(nodeProofEventsTable.id, proofId));
      res.json({ proofId, txSignature });
    } catch (err: any) {
      await db
        .update(nodeProofEventsTable)
        .set({ status: "failed", nodeSignatureBase64, failureReason: err?.message || "Unknown error" })
        .where(eq(nodeProofEventsTable.id, proofId));
      res.status(503).json({ error: err?.message || "Failed to submit on-chain proof" });
    }
  } catch (err: any) {
    console.error("POST /nodes/proof/:proofId/submit error:", err);
    res.status(500).json({ error: "Failed to submit on-chain proof" });
  }
});

// Contributor dashboard: recent proof feed for the caller's own node(s).
router.get("/nodes/proofs", requireAuth, async (req: any, res) => {
  try {
    const myNodes = await db.select({ id: nodesTable.id }).from(nodesTable).where(eq(nodesTable.clerkUserId, req.userId));
    const nodeIds = myNodes.map((n) => n.id);
    if (nodeIds.length === 0) return res.json({ proofs: [] });

    const proofs = await db
      .select()
      .from(nodeProofEventsTable)
      .where(inArray(nodeProofEventsTable.nodeId, nodeIds))
      .orderBy(desc(nodeProofEventsTable.createdAt))
      .limit(30);

    res.json({ proofs });
  } catch (err) {
    console.error("GET /nodes/proofs error:", err);
    res.status(500).json({ error: "Failed to fetch proof feed" });
  }
});

// User task page: on-chain proof for a specific task the caller submitted.
router.get("/tasks/:taskId/proof", requireAuth, async (req: any, res) => {
  try {
    const { taskId } = req.params;
    const [task] = await db
      .select()
      .from(tasksTable)
      .where(and(eq(tasksTable.taskId, taskId), eq(tasksTable.clerkUserId, req.userId)))
      .limit(1);
    if (!task) return res.status(404).json({ error: "Task not found" });

    let [proof] = await db
      .select()
      .from(nodeProofEventsTable)
      .where(and(eq(nodeProofEventsTable.taskId, taskId), eq(nodeProofEventsTable.eventType, "task_completed")))
      .orderBy(desc(nodeProofEventsTable.createdAt))
      .limit(1);

    // A node was assigned to this task but never produced (or never
    // finished) a co-signed proof. Instead of leaving the user staring at
    // "waiting for the node to co-sign" forever with no tx hash, resolve it
    // via a treasury-only attestation once it's clearly stuck.
    const referenceTime = proof?.createdAt ?? task.completedAt;
    const stuck =
      task.assignedNodeId != null &&
      task.completedAt != null &&
      (!proof || proof.status === "pending_signature") &&
      referenceTime != null &&
      Date.now() - new Date(referenceTime).getTime() > NODE_COSIGN_TIMEOUT_MS;

    if (stuck) {
      const totalPaidMicros = task.creditsUsed * CREDIT_USDC_MICROS;
      const rewardMicros = task.nodeRewardUsdcMicros ?? 0;
      const [node] = await db
        .select({ nodePublicKey: nodesTable.nodePublicKey, walletAddress: nodesTable.walletAddress })
        .from(nodesTable)
        .where(eq(nodesTable.id, task.assignedNodeId!))
        .limit(1);
      // Same on-chain payer/payee transparency as the happy-path co-signed
      // proof above: name the user's wallet and the node's reward wallet in
      // the fallback memo text too (can't attach them as instruction
      // accounts — the SPL Memo program requires every account it's given
      // to also be a signer, which neither of these wallets can do here).
      const relatedWallets: RelatedWallets = { userWallet: task.clerkUserId, nodeWallet: node?.walletAddress };
      const baseMemoText =
        proof?.memoText ??
        buildMemoText(
          "task_completed",
          node?.nodePublicKey ?? "unknown",
          taskId,
          {
            totalPaidUsdc: totalPaidMicros / 1_000_000,
            rewardUsdc: rewardMicros / 1_000_000,
            treasuryUsdc: Math.max(0, totalPaidMicros - rewardMicros) / 1_000_000,
          },
          relatedWallets
        );
      try {
        const { txSignature, memoText } = await fallbackToTreasuryOnlyProof(baseMemoText);
        if (proof) {
          [proof] = await db
            .update(nodeProofEventsTable)
            .set({ status: "confirmed", txSignature, memoText, confirmedAt: new Date() })
            .where(eq(nodeProofEventsTable.id, proof.id))
            .returning();
        } else {
          [proof] = await db
            .insert(nodeProofEventsTable)
            .values({
              nodeId: task.assignedNodeId!,
              taskId,
              eventType: "task_completed",
              status: "confirmed",
              memoText,
              unsignedMessageBase64: "",
              txSignature,
              confirmedAt: new Date(),
            })
            .returning();
        }
      } catch (fallbackErr: any) {
        console.error("Treasury-only proof fallback failed:", fallbackErr);
        // Leave the existing pending/null proof as-is; the next poll will retry.
      }
    }

    res.json({ proof: proof || null });
  } catch (err) {
    console.error("GET /tasks/:taskId/proof error:", err);
    res.status(500).json({ error: "Failed to fetch task proof" });
  }
});

export default router;

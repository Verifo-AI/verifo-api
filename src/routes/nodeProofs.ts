import { Router } from "express";
import { requireAuth } from "../middlewares/jwtAuth";
import { db } from "@workspace/db";
import { nodesTable, nodeProofEventsTable, tasksTable } from "@workspace/db/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { authenticateNodeRequest } from "./nodeClient";
import { buildMemoText, buildUnsignedProofMessage, finalizeAndSubmitProof, type ProofEventType } from "../lib/solanaProofs";

const router = Router();

const VALID_EVENT_TYPES: ProofEventType[] = ["connect", "disconnect", "task_assigned", "task_completed"];

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
    if (eventType === "task_assigned" || eventType === "task_completed") {
      if (typeof taskId !== "string" || !taskId) {
        return res.status(400).json({ error: "taskId is required for this event type" });
      }
      const [task] = await db.select().from(tasksTable).where(eq(tasksTable.taskId, taskId)).limit(1);
      if (!task || task.assignedNodeId !== node.id) {
        return res.status(404).json({ error: "Task not found for this node" });
      }
      resolvedTaskId = taskId;
    }

    const [nodeRow] = await db.select().from(nodesTable).where(eq(nodesTable.id, node.id)).limit(1);
    if (!nodeRow?.nodePublicKey) {
      return res.status(404).json({ error: "Node identity not found" });
    }

    const memoText = buildMemoText(eventType as ProofEventType, nodeRow.nodePublicKey, resolvedTaskId);
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

    const [proof] = await db
      .select()
      .from(nodeProofEventsTable)
      .where(and(eq(nodeProofEventsTable.taskId, taskId), eq(nodeProofEventsTable.eventType, "task_completed")))
      .orderBy(desc(nodeProofEventsTable.createdAt))
      .limit(1);

    res.json({ proof: proof || null });
  } catch (err) {
    console.error("GET /tasks/:taskId/proof error:", err);
    res.status(500).json({ error: "Failed to fetch task proof" });
  }
});

export default router;

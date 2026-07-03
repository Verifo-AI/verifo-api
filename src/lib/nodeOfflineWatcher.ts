import { db } from "@workspace/db";
import { nodesTable, nodeProofEventsTable } from "@workspace/db/schema";
import { and, eq, lt } from "drizzle-orm";
import { buildMemoText, buildAndSubmitTreasuryOnlyProof } from "./solanaProofs";
import { logger } from "./logger";

// A node that hasn't sent a heartbeat in this long is considered offline.
// Kept in sync with whatever heartbeat interval the CLI actually uses; wide
// enough to avoid false positives from a single missed beat or brief network
// blip, tight enough that the "node_offline" proof is still meaningful.
const ONLINE_WINDOW_MS = 90_000;

/**
 * Finds nodes that stopped sending heartbeats (crash, network drop, killed
 * process — anything that skips the graceful CLI disconnect path), flips
 * them to "offline", and submits a real treasury-only on-chain proof
 * recording the event. This is the only way an ungraceful disconnect gets a
 * proof, since the node itself can't co-sign once it's gone dark.
 */
export async function checkForOfflineNodes(): Promise<void> {
  const cutoff = new Date(Date.now() - ONLINE_WINDOW_MS);

  const staleNodes = await db
    .select({ id: nodesTable.id, nodePublicKey: nodesTable.nodePublicKey })
    .from(nodesTable)
    .where(and(eq(nodesTable.status, "active"), lt(nodesTable.lastSeenAt, cutoff)));

  for (const node of staleNodes) {
    // Atomically claim this node so concurrent poller ticks (or multiple
    // worker instances) never double-flip/double-submit for the same node.
    const claimed = await db
      .update(nodesTable)
      .set({ status: "offline" })
      .where(and(eq(nodesTable.id, node.id), eq(nodesTable.status, "active")))
      .returning({ id: nodesTable.id });

    if (claimed.length === 0) continue;

    if (!node.nodePublicKey) {
      logger.warn({ nodeId: node.id }, "[nodeOfflineWatcher] node went offline but has no public key, skipping proof");
      continue;
    }

    const memoText = buildMemoText("node_offline", node.nodePublicKey);

    const [proofRow] = await db
      .insert(nodeProofEventsTable)
      .values({
        nodeId: node.id,
        taskId: null,
        eventType: "node_offline",
        status: "pending_signature",
        memoText,
        unsignedMessageBase64: "",
      })
      .returning();

    try {
      const txSignature = await buildAndSubmitTreasuryOnlyProof(memoText);
      await db
        .update(nodeProofEventsTable)
        .set({ status: "confirmed", txSignature, confirmedAt: new Date() })
        .where(eq(nodeProofEventsTable.id, proofRow!.id));
      logger.info({ nodeId: node.id, txSignature }, "[nodeOfflineWatcher] node_offline proof confirmed");
    } catch (err: any) {
      await db
        .update(nodeProofEventsTable)
        .set({ status: "failed", failureReason: err?.message || "Unknown error" })
        .where(eq(nodeProofEventsTable.id, proofRow!.id));
      logger.error({ err, nodeId: node.id }, "[nodeOfflineWatcher] failed to submit node_offline proof");
    }
  }
}

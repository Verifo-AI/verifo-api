// Runs the platform-operated fallback nodes: official infrastructure we
// operate ourselves (transparently labeled "Verifo Official Platform Node",
// nodesTable.isPlatformNode = true), used purely as a last-resort safety net
// so task routing always has *some* capacity when no real contributor node
// is online. These are not disguised as independent contributors.
//
// This is a real client: each node signs real heartbeats with its own
// ed25519 identity (verified by the same code path as verifo-node-client),
// polls for real assigned tasks, and responds honestly — it has no local
// model to run, so it always reports failure, which is exactly what a real
// "relay" node does. That correctly routes the task through the existing
// Claude fallback + RELAY_REWARD_SHARE reward path in tasks.ts.
import nacl from "tweetnacl";
import bs58 from "bs58";
import { db, nodesTable, platformNodeCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./lib/logger";

const API_BASE = `http://localhost:${process.env["PORT"] ?? "8080"}/api`;
const HEARTBEAT_INTERVAL_MS = 25_000;
const POLL_INTERVAL_MS = 2_000;

interface PlatformNodeIdentity {
  nodeId: number;
  nodePublicKey: string;
  secretKey: Uint8Array;
}

function sign(purpose: string, publicKey: string, secretKey: Uint8Array, timestampMs: number): string {
  const message = new TextEncoder().encode(`${purpose}:${publicKey}:${timestampMs}`);
  const signature = nacl.sign.detached(message, secretKey);
  return Buffer.from(signature).toString("base64");
}

function signRawMessage(secretKey: Uint8Array, message: Uint8Array): string {
  const signature = nacl.sign.detached(message, secretKey);
  return Buffer.from(signature).toString("base64");
}

// Fase 5 parity for platform relay nodes: these are real on-chain co-signed
// proofs, using the exact same /nodes/proof + /nodes/proof/:id/submit flow as
// the independent contributor CLI (verifo-node.mjs). Platform nodes now leave
// the same genuine mainnet trail as any other node, instead of only real
// contributor nodes producing on-chain proof while platform relay traffic
// (currently ~100% of it) silently never did.
async function sendProofEvent(identity: PlatformNodeIdentity, eventType: string, taskId?: string): Promise<void> {
  try {
    const requestTimestampMs = Date.now();
    const requestSignature = sign("verifo-request-proof", identity.nodePublicKey, identity.secretKey, requestTimestampMs);

    const reqRes = await fetch(`${API_BASE}/nodes/proof`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodePublicKey: identity.nodePublicKey,
        timestampMs: requestTimestampMs,
        signature: requestSignature,
        eventType,
        taskId,
      }),
    });
    const reqData = (await reqRes.json().catch(() => ({}))) as { proofId?: number; messageBase64?: string; error?: string };
    if (!reqRes.ok || !reqData.messageBase64) {
      logger.warn({ nodeId: identity.nodeId, eventType, error: reqData.error }, "platform node proof request failed");
      return;
    }

    const messageBytes = new Uint8Array(Buffer.from(reqData.messageBase64, "base64"));
    const nodeSignatureBase64 = signRawMessage(identity.secretKey, messageBytes);

    const submitTimestampMs = Date.now();
    const submitSignature = sign("verifo-submit-proof", identity.nodePublicKey, identity.secretKey, submitTimestampMs);
    const submitRes = await fetch(`${API_BASE}/nodes/proof/${reqData.proofId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodePublicKey: identity.nodePublicKey,
        timestampMs: submitTimestampMs,
        signature: submitSignature,
        nodeSignatureBase64,
      }),
    });
    const submitData = (await submitRes.json().catch(() => ({}))) as { txSignature?: string; error?: string };
    if (submitRes.ok && submitData.txSignature) {
      logger.info({ nodeId: identity.nodeId, eventType, txSignature: submitData.txSignature }, "platform node on-chain proof confirmed");
    } else {
      logger.warn({ nodeId: identity.nodeId, eventType, error: submitData.error }, "platform node on-chain proof submit failed");
    }
  } catch (err) {
    logger.warn({ err, nodeId: identity.nodeId, eventType }, "platform node proof event error");
  }
}

async function loadIdentities(): Promise<PlatformNodeIdentity[]> {
  const rows = await db
    .select({
      nodeId: nodesTable.id,
      nodePublicKey: nodesTable.nodePublicKey,
      nodeSecretKeyBase64: platformNodeCredentialsTable.nodeSecretKeyBase64,
    })
    .from(platformNodeCredentialsTable)
    .innerJoin(nodesTable, eq(nodesTable.id, platformNodeCredentialsTable.nodeId))
    .where(eq(nodesTable.isPlatformNode, true));

  return rows
    .filter((r): r is typeof r & { nodePublicKey: string } => typeof r.nodePublicKey === "string")
    .map((r) => ({
      nodeId: r.nodeId,
      nodePublicKey: r.nodePublicKey,
      secretKey: new Uint8Array(Buffer.from(r.nodeSecretKeyBase64, "base64")),
    }));
}

async function sendHeartbeat(identity: PlatformNodeIdentity): Promise<void> {
  const timestampMs = Date.now();
  const signature = sign("verifo-heartbeat", identity.nodePublicKey, identity.secretKey, timestampMs);
  const res = await fetch(`${API_BASE}/nodes/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodePublicKey: identity.nodePublicKey, timestampMs, signature }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn({ nodeId: identity.nodeId, status: res.status, body }, "platform node heartbeat failed");
  }
}

async function pollAndRelay(identity: PlatformNodeIdentity): Promise<void> {
  const timestampMs = Date.now();
  const signature = sign("verifo-next-task", identity.nodePublicKey, identity.secretKey, timestampMs);
  const params = new URLSearchParams({
    nodePublicKey: identity.nodePublicKey,
    timestampMs: String(timestampMs),
    signature,
  });
  const res = await fetch(`${API_BASE}/nodes/next-task?${params.toString()}`);
  if (!res.ok) return;
  const data = (await res.json()) as { task: { taskId: string } | null };
  if (!data.task) return;

  logger.info({ nodeId: identity.nodeId, taskId: data.task.taskId }, "platform node received task, relaying to Claude fallback");
  void sendProofEvent(identity, "task_assigned", data.task.taskId);

  const resultTimestampMs = Date.now();
  const resultSignature = sign("verifo-task-result", identity.nodePublicKey, identity.secretKey, resultTimestampMs);
  const resultRes = await fetch(`${API_BASE}/nodes/task-result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nodePublicKey: identity.nodePublicKey,
      timestampMs: resultTimestampMs,
      signature: resultSignature,
      taskId: data.task.taskId,
      success: false,
      reason: "Platform relay node: no local model available, relaying to central inference.",
    }),
  }).catch((err) => {
    logger.warn({ err, nodeId: identity.nodeId }, "platform node failed to post task-result");
    return null;
  });

  // The server holds this response open until the reward for this task has
  // been finalized (see waitForRewardFinalized), so it's now safe to request
  // the task_completed on-chain proof with the final settlement numbers.
  if (resultRes?.ok) {
    void sendProofEvent(identity, "task_completed", data.task.taskId);
  }
}

let shuttingDown = false;

async function handleShutdown(identities: PlatformNodeIdentity[], signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, count: identities.length }, "platform nodes worker shutting down, sending disconnect proofs");
  const timeoutMs = 8_000;
  await Promise.race([
    Promise.all(identities.map((identity) => sendProofEvent(identity, "disconnect"))),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  process.exit(0);
}

async function runNode(identity: PlatformNodeIdentity): Promise<void> {
  await sendHeartbeat(identity).catch((err) => logger.warn({ err, nodeId: identity.nodeId }, "initial heartbeat failed"));
  void sendProofEvent(identity, "connect");

  setInterval(() => {
    sendHeartbeat(identity).catch((err) => logger.warn({ err, nodeId: identity.nodeId }, "heartbeat failed"));
  }, HEARTBEAT_INTERVAL_MS);

  setInterval(() => {
    pollAndRelay(identity).catch((err) => logger.warn({ err, nodeId: identity.nodeId }, "poll failed"));
  }, POLL_INTERVAL_MS);
}

async function main() {
  const identities = await loadIdentities();
  if (identities.length === 0) {
    logger.error("No platform node identities found in DB. Run scripts/seedPlatformNodes.ts first.");
    process.exit(1);
  }
  logger.info({ count: identities.length }, "Starting platform fallback nodes worker");
  for (const identity of identities) {
    void runNode(identity);
  }

  process.on("SIGINT", () => void handleShutdown(identities, "SIGINT"));
  process.on("SIGTERM", () => void handleShutdown(identities, "SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "platform-nodes worker crashed");
  process.exit(1);
});

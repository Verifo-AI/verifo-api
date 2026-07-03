import { Router, type IRouter } from "express";
import jwt from "jsonwebtoken";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { requireAuth, JWT_SECRET } from "../middlewares/jwtAuth";
import { db, nodesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { buildNodeClientZip } from "@workspace/verifo-node-client/scripts/build-dist.mjs";
import { popNextTaskForNode, resolveNodeTask, waitForRewardFinalized } from "../lib/taskRouter";
import {
  classifyContributionMode,
  WITNESS_REWARD_MICROS_PER_SECOND,
  WITNESS_REWARD_MAX_ELAPSED_SEC,
  BROWSER_MODE_REWARD_MULTIPLIER,
} from "../lib/contributionMode";

const router: IRouter = Router();

let cachedZip: Buffer | null = null;

router.get("/nodes/download", async (_req, res) => {
  try {
    if (!cachedZip) {
      cachedZip = Buffer.from(await buildNodeClientZip());
    }
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="verifo-node-client.zip"');
    res.send(cachedZip);
  } catch (err) {
    console.error("GET /nodes/download error:", err);
    res.status(500).json({ error: "Failed to build node client download" });
  }
});

const HEARTBEAT_MAX_SKEW_MS = 60_000; // reject heartbeats signed too far in the past/future
const ONLINE_WINDOW_MS = 90_000; // node considered "online" if a heartbeat landed within this window

export function isValidBase58Pubkey(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 64) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

// Shared signature check used by both the heartbeat and the task endpoints —
// proves the request came from whoever holds the node's private key.
function verifyNodeSignature(purpose: string, nodePublicKey: string, timestampMs: number, signature: string): boolean {
  const msgBytes = new TextEncoder().encode(`${purpose}:${nodePublicKey}:${timestampMs}`);
  try {
    const sigBytes = new Uint8Array(Buffer.from(signature, "base64"));
    const pubKeyBytes = new Uint8Array(bs58.decode(nodePublicKey));
    return nacl.sign.detached.verify(msgBytes, sigBytes, pubKeyBytes);
  } catch {
    return false;
  }
}

export async function authenticateNodeRequest(req: any, res: any, purpose: string): Promise<{ id: number } | null> {
  const { nodePublicKey, timestampMs, signature } = req.body ?? {};
  if (!isValidBase58Pubkey(nodePublicKey) || typeof timestampMs !== "number" || typeof signature !== "string") {
    res.status(400).json({ error: "nodePublicKey, timestampMs, and signature are required" });
    return null;
  }
  if (Math.abs(Date.now() - timestampMs) > HEARTBEAT_MAX_SKEW_MS) {
    res.status(400).json({ error: "Timestamp is out of the acceptable time window" });
    return null;
  }
  if (!verifyNodeSignature(purpose, nodePublicKey, timestampMs, signature)) {
    res.status(401).json({ error: "Invalid signature" });
    return null;
  }
  const [node] = await db.select({ id: nodesTable.id }).from(nodesTable).where(eq(nodesTable.nodePublicKey, nodePublicKey)).limit(1);
  if (!node) {
    res.status(404).json({ error: "Unknown node identity" });
    return null;
  }
  return node;
}

// Step 1: authenticated dashboard user requests a short-lived pairing token to
// hand to the CLI running on their own machine. This never touches the DB.
router.post("/nodes/pairing-code", requireAuth, async (req: any, res) => {
  try {
    const [node] = await db
      .select()
      .from(nodesTable)
      .where(eq(nodesTable.clerkUserId, req.userId))
      .limit(1);

    if (!node) {
      return res.status(404).json({ error: "No node registered. Register at /contributors/register first." });
    }

    const pairingToken = jwt.sign(
      { type: "node-pair", userId: req.userId, nodeId: node.id },
      JWT_SECRET,
      { expiresIn: "10m" }
    );

    res.json({ pairingToken, expiresInSeconds: 600 });
  } catch (err) {
    console.error("POST /nodes/pairing-code error:", err);
    res.status(500).json({ error: "Failed to generate pairing code" });
  }
});

// Step 2: the CLI (running on the contributor's real machine) redeems the
// pairing token and attaches its freshly-generated identity + real hardware
// report to the node row. No user-entered auth here — the pairing token IS
// the auth, and it's single-purpose + short-lived.
router.post("/nodes/link", async (req, res) => {
  try {
    const { pairingToken, nodePublicKey, os, cpu, gpu, ramGb, clientType } = req.body ?? {};

    if (typeof pairingToken !== "string") {
      return res.status(400).json({ error: "pairingToken is required" });
    }
    if (!isValidBase58Pubkey(nodePublicKey)) {
      return res.status(400).json({ error: "nodePublicKey must be a base58-encoded ed25519 public key" });
    }
    if (typeof os !== "string" || typeof cpu !== "string" || typeof ramGb !== "number") {
      return res.status(400).json({ error: "os, cpu, and ramGb are required hardware report fields" });
    }
    // Browser Mode self-links using a key generated in the tab itself, since
    // there's no separate CLI process to hold it. Anything other than the
    // literal string "browser" is treated as the default "cli" — never
    // trust an unrecognized value into a lower-verification bucket.
    const resolvedClientType: "cli" | "browser" = clientType === "browser" ? "browser" : "cli";

    let payload: { type: string; userId: string; nodeId: number };
    try {
      payload = jwt.verify(pairingToken, JWT_SECRET) as typeof payload;
    } catch {
      return res.status(401).json({ error: "Pairing code is invalid or expired. Generate a new one from the dashboard." });
    }
    if (payload.type !== "node-pair") {
      return res.status(401).json({ error: "Invalid pairing code" });
    }

    const [node] = await db
      .select()
      .from(nodesTable)
      .where(eq(nodesTable.id, payload.nodeId))
      .limit(1);

    if (!node || node.clerkUserId !== payload.userId) {
      return res.status(404).json({ error: "Node not found for this pairing code" });
    }

    const existingKeyOwner = await db
      .select({ id: nodesTable.id })
      .from(nodesTable)
      .where(eq(nodesTable.nodePublicKey, nodePublicKey))
      .limit(1);
    if (existingKeyOwner.length > 0 && existingKeyOwner[0]!.id !== node.id) {
      return res.status(409).json({ error: "This node identity is already linked to a different account" });
    }

    const reportedGpuValue = typeof gpu === "string" ? gpu : null;
    const contributionMode = classifyContributionMode(Math.round(ramGb), reportedGpuValue);

    const [updated] = await db
      .update(nodesTable)
      .set({
        nodePublicKey,
        verified: true,
        status: "active",
        lastSeenAt: new Date(),
        reportedOs: os,
        reportedCpu: cpu,
        reportedGpu: reportedGpuValue,
        reportedRamGb: Math.round(ramGb),
        contributionMode,
        clientType: resolvedClientType,
        updatedAt: new Date(),
      })
      .where(eq(nodesTable.id, node.id))
      .returning();

    res.json({ linked: true, nodeId: updated!.id, contributionMode, clientType: resolvedClientType });
  } catch (err) {
    console.error("POST /nodes/link error:", err);
    res.status(500).json({ error: "Failed to link node" });
  }
});

// Step 3: periodic proof-of-life from the real client. The signature proves
// the request came from whoever holds the private key generated at link time
// — this is what makes "online"/"verified" honest instead of simulated.
router.post("/nodes/heartbeat", async (req, res) => {
  try {
    const { nodePublicKey, timestampMs, signature } = req.body ?? {};

    if (!isValidBase58Pubkey(nodePublicKey)) {
      return res.status(400).json({ error: "nodePublicKey is invalid" });
    }
    if (typeof timestampMs !== "number" || typeof signature !== "string") {
      return res.status(400).json({ error: "timestampMs and signature are required" });
    }
    if (Math.abs(Date.now() - timestampMs) > HEARTBEAT_MAX_SKEW_MS) {
      return res.status(400).json({ error: "Heartbeat timestamp is out of the acceptable time window" });
    }

    const [node] = await db
      .select()
      .from(nodesTable)
      .where(eq(nodesTable.nodePublicKey, nodePublicKey))
      .limit(1);

    if (!node) {
      return res.status(404).json({ error: "Unknown node identity. Link the client via /nodes/link first." });
    }

    const msgBytes = new TextEncoder().encode(`verifo-heartbeat:${nodePublicKey}:${timestampMs}`);
    let sigBytes: Uint8Array;
    let pubKeyBytes: Uint8Array;
    try {
      sigBytes = new Uint8Array(Buffer.from(signature, "base64"));
      pubKeyBytes = new Uint8Array(bs58.decode(nodePublicKey));
    } catch {
      return res.status(400).json({ error: "Malformed signature or public key encoding" });
    }

    let valid = false;
    try {
      valid = nacl.sign.detached.verify(msgBytes, sigBytes, pubKeyBytes);
    } catch {
      valid = false;
    }
    if (!valid) {
      return res.status(401).json({ error: "Invalid heartbeat signature" });
    }

    const now = new Date();

    // Witness nodes never run AI work, so they can't earn per-task reward.
    // Instead they earn a small, honest reward for real signature-verified
    // uptime, computed from elapsed time since the previous heartbeat and
    // capped so hammering this endpoint can't inflate it.
    let witnessRewardMicros = 0;
    if (node.contributionMode === "witness" && node.lastSeenAt) {
      const elapsedSec = Math.min(
        (now.getTime() - node.lastSeenAt.getTime()) / 1000,
        WITNESS_REWARD_MAX_ELAPSED_SEC
      );
      if (elapsedSec > 0) {
        witnessRewardMicros = Math.round(elapsedSec * WITNESS_REWARD_MICROS_PER_SECOND);
        if (node.clientType === "browser") {
          witnessRewardMicros = Math.round(witnessRewardMicros * BROWSER_MODE_REWARD_MULTIPLIER);
        }
      }
    }

    await db
      .update(nodesTable)
      .set({
        lastSeenAt: now,
        status: "active",
        updatedAt: now,
        ...(witnessRewardMicros > 0
          ? { pendingRewardUsdcMicros: sql`${nodesTable.pendingRewardUsdcMicros} + ${witnessRewardMicros}` }
          : {}),
      })
      .where(eq(nodesTable.id, node.id));

    res.json({ ok: true, onlineWindowMs: ONLINE_WINDOW_MS, contributionMode: node.contributionMode });
  } catch (err) {
    console.error("POST /nodes/heartbeat error:", err);
    res.status(500).json({ error: "Failed to record heartbeat" });
  }
});

// Fase 2: the CLI polls this to check whether the server has routed a real
// user task to it. Auth uses the same node-identity signature scheme as the
// heartbeat, sent as query params since this is a GET.
router.get("/nodes/next-task", async (req, res) => {
  try {
    const nodePublicKey = req.query.nodePublicKey as string;
    const timestampMs = Number(req.query.timestampMs);
    const signature = req.query.signature as string;

    const node = await authenticateNodeRequest(
      { body: { nodePublicKey, timestampMs, signature } } as any,
      res,
      "verifo-next-task"
    );
    if (!node) return;

    const task = popNextTaskForNode(node.id);
    if (!task) {
      return res.json({ task: null });
    }
    res.json({ task: { taskId: task.taskId, prompt: task.prompt, type: task.type } });
  } catch (err) {
    console.error("GET /nodes/next-task error:", err);
    res.status(500).json({ error: "Failed to fetch next task" });
  }
});

// Fase 2: the CLI posts back the outcome of the task it was assigned — either
// a real local-model output, or an explicit "can't run this locally" signal
// (still counts as the node relaying the task; server falls back to Claude).
router.post("/nodes/task-result", async (req, res) => {
  try {
    const { taskId, success, output, reason } = req.body ?? {};
    const node = await authenticateNodeRequest(req, res, "verifo-task-result");
    if (!node) return;

    if (typeof taskId !== "string") {
      return res.status(400).json({ error: "taskId is required" });
    }

    const resolved =
      success === true && typeof output === "string"
        ? resolveNodeTask(taskId, node.id, { ok: true, output })
        : resolveNodeTask(taskId, node.id, { ok: false, reason: typeof reason === "string" ? reason : "local model unavailable" });

    if (!resolved) {
      return res.status(409).json({ error: "This task already timed out or was already resolved" });
    }

    // Block the response until the original /tasks handler has finished
    // computing and persisting the real reward for this task. This makes it
    // safe for the node to immediately request its on-chain task_completed
    // proof right after receiving this response, without racing the reward
    // write (see waitForRewardFinalized / finalizeReward in taskRouter.ts).
    await waitForRewardFinalized(taskId);

    res.json({ ok: true });
  } catch (err) {
    console.error("POST /nodes/task-result error:", err);
    res.status(500).json({ error: "Failed to record task result" });
  }
});

export default router;

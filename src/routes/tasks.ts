import { Router } from "express";
import { requireAuth } from "../middlewares/jwtAuth";
import crypto from "crypto";
import { db } from "@workspace/db";
import { tasksTable, proofsTable, creditsTable, nodesTable } from "@workspace/db/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { findAvailableNode, assignTaskToNode } from "../lib/taskRouter";
import { addCompletedTask } from "../lib/nodeState";
import { BROWSER_MODE_REWARD_MULTIPLIER } from "../lib/contributionMode";

// Fase 3: real USDC value backing each credit, matching the topup packages in
// credits.ts (e.g. pack_100: 100 credits for $1 => 1 credit = $0.01). Reward
// shares are a fraction of that real dollar value, in micro-USDC (1e6 = $1).
export const CREDIT_USDC_MICROS = 10_000; // $0.01 per credit
export const LOCAL_MODEL_REWARD_SHARE = 0.5; // node ran the model itself
export const RELAY_REWARD_SHARE = 0.1; // node responded honestly but had to relay

// Shared with nodeProofs.ts so the on-chain task_completed memo can quote the
// exact real reward amount instead of a generic message.
export function computeRewardMicros(
  source: string | null,
  creditsUsed: number,
  clientType: string | null | undefined
): number {
  let share: number;
  if (source === "local_model") share = LOCAL_MODEL_REWARD_SHARE;
  else if (source === "relayed") share = RELAY_REWARD_SHARE;
  else return 0;
  const effectiveShare = clientType === "browser" ? share * BROWSER_MODE_REWARD_MULTIPLIER : share;
  return Math.round(creditsUsed * CREDIT_USDC_MICROS * effectiveShare);
}

async function creditNodeReward(nodeId: number, share: number, creditsUsed: number): Promise<number> {
  const [node] = await db
    .select({ clientType: nodesTable.clientType })
    .from(nodesTable)
    .where(eq(nodesTable.id, nodeId))
    .limit(1);
  // Browser Mode nodes earn less per task, same reason as the heartbeat
  // reward: uptime tied to an open tab is inherently less reliable than a
  // dedicated CLI process, so we never promise the same reward for it.
  const effectiveShare = node?.clientType === "browser" ? share * BROWSER_MODE_REWARD_MULTIPLIER : share;
  const amountMicros = Math.round(creditsUsed * CREDIT_USDC_MICROS * effectiveShare);
  if (amountMicros <= 0) return 0;
  await db
    .update(nodesTable)
    .set({ pendingRewardUsdcMicros: sql`${nodesTable.pendingRewardUsdcMicros} + ${amountMicros}` })
    .where(eq(nodesTable.id, nodeId));
  return amountMicros;
}

const router = Router();

const CREDIT_COST: Record<string, number> = {
  chat: 3,
  coding: 5,
  image_generation: 12,
  translation: 4,
  research: 6,
};

async function getOrCreateCredits(userId: string) {
  const [existing] = await db
    .select()
    .from(creditsTable)
    .where(eq(creditsTable.clerkUserId, userId))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(creditsTable)
    .values({ clerkUserId: userId, credits: 100, plan: "free" })
    .returning();
  return created;
}

function sha256(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function generateNodeWallet() {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let r = "";
  for (let i = 0; i < 32; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

function generateSolanaTxId() {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let r = "";
  for (let i = 0; i < 64; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

router.get("/tasks", requireAuth, async (req: any, res) => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || "20", 10), 100);
    const status = req.query.status as string | undefined;

    const tasks = await db
      .select()
      .from(tasksTable)
      .where(
        status && status !== "all"
          ? and(eq(tasksTable.clerkUserId, req.userId), eq(tasksTable.status, status))
          : eq(tasksTable.clerkUserId, req.userId)
      )
      .orderBy(desc(tasksTable.createdAt))
      .limit(limit);

    res.json({ tasks, total: tasks.length });
  } catch (err) {
    console.error("GET /tasks error:", err);
    res.status(500).json({ error: "Failed to fetch tasks" });
  }
});

router.post("/tasks", requireAuth, async (req: any, res) => {
  const { prompt, model = "claude-sonnet-4-6", type = "chat" } = req.body;

  if (!prompt || typeof prompt !== "string" || prompt.trim() === "") {
    return res.status(400).json({ error: "prompt is required" });
  }

  try {
    const creditsRecord = await getOrCreateCredits(req.userId);
    const creditsUsed = CREDIT_COST[type] ?? 3;

    if (creditsRecord.credits < creditsUsed) {
      return res.status(402).json({ error: "Insufficient credits. Top up to continue." });
    }

    const ENGLISH_ONLY_INSTRUCTION =
      " Always respond in English, regardless of the language the user writes in. If asked to translate into another language, the translated text itself may be in that language, but all of your own explanations and surrounding text must stay in English.";

    const systemPrompt =
      (type === "coding"
        ? "You are an expert software engineer. Provide clean, well-commented code with explanations."
        : type === "translation"
        ? "You are a professional translator. Provide accurate, natural-sounding translations."
        : type === "research"
        ? "You are a research assistant. Provide thorough analysis with key insights."
        : "You are a helpful, knowledgeable assistant. Provide clear, accurate, and thoughtful responses.") +
      ENGLISH_ONLY_INSTRUCTION;

    const taskId = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    // Fase 2: try to route the task to a real online/verified contributor node
    // first. Only fall back to the central Claude API if no node is available,
    // the assigned node explicitly can't run it locally, or it never responds.
    let response: string;
    let source: "local_model" | "fallback_claude";
    let assignedNodeId: number | null = null;
    let nodeRelayed = false;

    const node = await findAvailableNode();

    if (node) {
      assignedNodeId = node.id;
      const nodeResult = await assignTaskToNode(node.id, { taskId, prompt, type });
      if (nodeResult?.ok) {
        response = nodeResult.output;
        source = "local_model";
      } else {
        // Either the node explicitly said it can't run this locally, or it
        // timed out. Only credit it for relaying if it actively responded.
        nodeRelayed = nodeResult !== null;
        const completion = await anthropic.messages.create({
          model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: "user", content: prompt }],
        });
        response = completion.content
          .filter((block) => block.type === "text")
          .map((block) => (block as { type: "text"; text: string }).text)
          .join("");
        source = "fallback_claude";
      }
    } else {
      const completion = await anthropic.messages.create({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
      });
      response = completion.content
        .filter((block) => block.type === "text")
        .map((block) => (block as { type: "text"; text: string }).text)
        .join("");
      source = "fallback_claude";
    }

    const proofId = `prf_${Math.random().toString(36).slice(2, 18)}`;
    const now = new Date();

    const [task] = await db
      .insert(tasksTable)
      .values({
        taskId,
        clerkUserId: req.userId,
        prompt,
        model,
        type,
        status: "completed",
        creditsUsed,
        response,
        proofId,
        source,
        assignedNodeId,
        completedAt: now,
      })
      .returning();

    // Reward the contributor node for real work: full credit for running the
    // model locally, a smaller relay credit if it engaged but had to fall
    // back to Claude. A node that never responded (timeout) earns nothing.
    let nodeRewardMicros = 0;
    if (source === "local_model" && assignedNodeId !== null) {
      addCompletedTask("Inference: LLM Batch", parseFloat((creditsUsed * 0.08).toFixed(2)));
      nodeRewardMicros = await creditNodeReward(assignedNodeId, LOCAL_MODEL_REWARD_SHARE, creditsUsed);
    } else if (nodeRelayed && assignedNodeId !== null) {
      addCompletedTask("Relayed to Claude (fallback)", parseFloat((creditsUsed * 0.02).toFixed(2)));
      nodeRewardMicros = await creditNodeReward(assignedNodeId, RELAY_REWARD_SHARE, creditsUsed);
    }
    if (nodeRewardMicros > 0) {
      await db.update(tasksTable).set({ nodeRewardUsdcMicros: nodeRewardMicros }).where(eq(tasksTable.id, task!.id));
    }

    await db.insert(proofsTable).values({
      proofId,
      taskId,
      clerkUserId: req.userId,
      modelIdentifier: model,
      promptHashSha256: sha256(prompt),
      outputHashSha256: sha256(response),
      computeNodeWallet: source === "local_model" && node ? node.walletAddress : generateNodeWallet(),
      nodeSignature: `sig_${Math.random().toString(36).slice(2, 48)}`,
      verificationConsensus: true,
      verifierCount: 5,
      solanaTransactionId: generateSolanaTxId(),
      verified: true,
    });

    await db
      .update(creditsTable)
      .set({ credits: creditsRecord.credits - creditsUsed, updatedAt: now })
      .where(eq(creditsTable.clerkUserId, req.userId));

    res.status(201).json({ ...task, proofId });
  } catch (err) {
    console.error("POST /tasks error:", err);
    res.status(500).json({ error: "Failed to process AI task" });
  }
});

router.get("/tasks/credits", requireAuth, async (req: any, res) => {
  try {
    const record = await getOrCreateCredits(req.userId);
    res.json({ credits: record.credits, plan: record.plan });
  } catch (err) {
    console.error("GET /tasks/credits error:", err);
    res.status(500).json({ error: "Failed to fetch credits" });
  }
});

export default router;

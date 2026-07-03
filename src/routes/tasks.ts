import { Router } from "express";
import { requireAuth } from "../middlewares/jwtAuth";
import { db } from "@workspace/db";
import { tasksTable, creditsTable, nodesTable } from "@workspace/db/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { findAvailableNode, assignTaskToNode, finalizeReward } from "../lib/taskRouter";
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

    // Ground the model in what it's actually running on: Verifo, a
    // decentralized AI compute network on Solana. Community-run contributor
    // nodes (compute/relay/witness) serve inference requests and earn real
    // USDC rewards, with on-chain proof-of-activity for every completed task.
    // Without this, the model has no idea it's part of Verifo and can give
    // generic or flatly wrong answers if asked about the platform itself.
    const VERIFO_CONTEXT =
      " You are running as part of Verifo, a decentralized AI compute network built on Solana. " +
      "Requests like this one are served by a distributed network of community-run contributor nodes " +
      "(compute nodes that run models locally, relay nodes that forward requests, and witness nodes that " +
      "attest to uptime), which earn real USDC rewards for their work, with on-chain proof-of-activity " +
      "recorded for transparency. If the user asks what Verifo is, how it works, or about contributing a " +
      "node, explain it accurately based on this description rather than guessing.";

    const systemPrompt =
      (type === "coding"
        ? "You are an expert software engineer. Provide clean, well-commented code with explanations."
        : type === "translation"
        ? "You are a professional translator. Provide accurate, natural-sounding translations."
        : type === "research"
        ? "You are a research assistant. Provide thorough analysis with key insights."
        : "You are a helpful, knowledgeable assistant. Provide clear, accurate, and thoughtful responses.") +
      ENGLISH_ONLY_INSTRUCTION +
      VERIFO_CONTEXT;

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
      nodeRewardMicros = await creditNodeReward(assignedNodeId, LOCAL_MODEL_REWARD_SHARE, creditsUsed);
    } else if (nodeRelayed && assignedNodeId !== null) {
      nodeRewardMicros = await creditNodeReward(assignedNodeId, RELAY_REWARD_SHARE, creditsUsed);
    }
    if (nodeRewardMicros > 0) {
      await db.update(tasksTable).set({ nodeRewardUsdcMicros: nodeRewardMicros }).where(eq(tasksTable.id, task!.id));
    }

    // Unblock the node's pending /nodes/task-result response (if any node was
    // actually involved) now that the reward is finalized and persisted. This
    // is what makes the node's subsequent on-chain task_completed proof
    // request safe to read final, non-racy numbers straight from the DB.
    if (assignedNodeId !== null) {
      finalizeReward(taskId, {
        source,
        rewardMicros: nodeRewardMicros,
        totalPaidMicros: creditsUsed * CREDIT_USDC_MICROS,
        treasuryMicros: Math.max(0, creditsUsed * CREDIT_USDC_MICROS - nodeRewardMicros),
      });
    }

    await db
      .update(creditsTable)
      .set({ credits: creditsRecord.credits - creditsUsed, updatedAt: now })
      .where(eq(creditsTable.clerkUserId, req.userId));

    res.status(201).json(task);
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

router.get("/tasks/:taskId", requireAuth, async (req: any, res) => {
  try {
    const { taskId } = req.params;
    const [task] = await db
      .select()
      .from(tasksTable)
      .where(and(eq(tasksTable.taskId, taskId), eq(tasksTable.clerkUserId, req.userId)))
      .limit(1);
    if (!task) return res.status(404).json({ error: "Task not found" });

    const totalPaidUsdcMicros = task.creditsUsed * CREDIT_USDC_MICROS;

    // Surface who actually did the work — real identity of the contributor
    // node that ran or relayed this task, never raw keys/secrets, so the
    // proof page can show a proper "who ran this" panel instead of a bare
    // internal node id.
    let contributorNode: {
      nodeId: string;
      contributionMode: string | null;
      clientType: string;
      isPlatformNode: boolean;
      walletAddress: string;
      os: string | null;
      hardwareSummary: string | null;
    } | null = null;

    if (task.assignedNodeId != null) {
      const [node] = await db
        .select({
          id: nodesTable.id,
          contributionMode: nodesTable.contributionMode,
          clientType: nodesTable.clientType,
          isPlatformNode: nodesTable.isPlatformNode,
          walletAddress: nodesTable.walletAddress,
          reportedOs: nodesTable.reportedOs,
          reportedCpu: nodesTable.reportedCpu,
          reportedGpu: nodesTable.reportedGpu,
          reportedRamGb: nodesTable.reportedRamGb,
        })
        .from(nodesTable)
        .where(eq(nodesTable.id, task.assignedNodeId))
        .limit(1);

      if (node) {
        const wallet = node.walletAddress;
        const walletTruncated = wallet.length > 10 ? `${wallet.slice(0, 4)}...${wallet.slice(-4)}` : wallet;
        const hardwareParts = [node.reportedCpu, node.reportedGpu, node.reportedRamGb ? `${node.reportedRamGb}GB RAM` : null].filter(Boolean);
        contributorNode = {
          nodeId: `vf-node-${node.id}`,
          contributionMode: node.contributionMode,
          clientType: node.clientType,
          isPlatformNode: node.isPlatformNode,
          walletAddress: walletTruncated,
          os: node.reportedOs,
          hardwareSummary: hardwareParts.length > 0 ? hardwareParts.join(" · ") : null,
        };
      }
    }

    res.json({
      ...task,
      totalPaidUsdcMicros,
      treasuryUsdcMicros: Math.max(0, totalPaidUsdcMicros - task.nodeRewardUsdcMicros),
      contributorNode,
    });
  } catch (err) {
    console.error("GET /tasks/:taskId error:", err);
    res.status(500).json({ error: "Failed to fetch task" });
  }
});

export default router;

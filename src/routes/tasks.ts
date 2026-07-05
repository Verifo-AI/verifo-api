import { Router } from "express";
import { requireAuth } from "../middlewares/jwtAuth";
import { db } from "@workspace/db";
import { tasksTable, creditsTable, nodesTable, payoutsTable } from "@workspace/db/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { generateImageBuffer } from "@workspace/integrations-openai-ai-server/image";
import { findAvailableNode, assignTaskToNode, finalizeReward } from "../lib/taskRouter";
import { sendUsdcPayout, isTreasuryConfigured } from "../lib/solanaTreasury";
import { logger } from "../lib/logger";

// Fase 3: real USDC value backing each credit, matching the topup packages in
// credits.ts (e.g. pack_100: 10,000 credits for $1 => 1 credit = $0.0001).
// Kept intentionally tiny so the real USDC price per task stays cheap
// (~$0.001-$0.003) even though CREDIT_COST below still reads as a normal
// 10-30 credit number. Reward shares are a fraction of that real dollar
// value, in micro-USDC (1e6 = $1).
export const CREDIT_USDC_MICROS = 100; // $0.0001 per credit
// Flat 70/30 split: any node that actually did real work for a task (ran the
// model locally, or honestly relayed/attempted it) earns 70% of what the
// user paid; the remaining 30% covers platform costs (inference API bills,
// infra, treasury). This applies uniformly regardless of whether the node
// ran the model itself or relayed — see verifo-payment-splits memory doc for
// why this replaced the old two-tier 50%/10% shares.
export const NODE_REWARD_SHARE = 0.7; // contributor node's share of the task price
export const TREASURY_SHARE = 1 - NODE_REWARD_SHARE; // platform's share

// Shared with nodeProofs.ts so the on-chain task_completed memo can quote the
// exact real reward amount instead of a generic message.
export function computeRewardMicros(
  source: string | null,
  creditsUsed: number,
  _clientType?: string | null | undefined
): number {
  if (source !== "local_model" && source !== "relayed") return 0;
  // Flat 70% for every node that did real work on a task, regardless of
  // clientType (browser tab vs CLI). The browser-mode discount only applies
  // to the passive witness heartbeat reward (see BROWSER_MODE_REWARD_MULTIPLIER
  // in contributionMode.ts / nodeClient.ts) — it must never touch task
  // rewards, or a browser-mode node doing real relay/compute work for a task
  // silently gets shorted below the advertised 70/30 split.
  return Math.round(creditsUsed * CREDIT_USDC_MICROS * NODE_REWARD_SHARE);
}

export type RewardPayoutStatus = "not_applicable" | "paid" | "failed";

export interface NodeRewardResult {
  amountMicros: number;
  status: RewardPayoutStatus;
  txSignature: string | null;
}

// Every task that earns a node a reward now pays that node in real, on-chain
// USDC the instant the task completes — no batching, no manual "Request
// Payout" click required. If the on-chain send itself fails (RPC hiccup,
// treasury underfunded, treasury wallet not configured), the amount is
// credited to the node's pendingRewardUsdcMicros balance instead, so nothing
// is ever lost — the node can still claim it later via the existing manual
// payout button as a safety net.
async function payNodeRewardOnChain(nodeId: number, share: number, creditsUsed: number): Promise<NodeRewardResult> {
  const [node] = await db
    .select({ clientType: nodesTable.clientType, walletAddress: nodesTable.walletAddress })
    .from(nodesTable)
    .where(eq(nodesTable.id, nodeId))
    .limit(1);

  if (!node) return { amountMicros: 0, status: "not_applicable", txSignature: null };

  // Flat share for every node that did real work on a task — no browser-mode
  // discount here. The browser-mode discount only applies to the passive
  // witness heartbeat reward (uptime-only, no actual work done); a
  // browser-mode node that ran/relayed a real task earns the full advertised
  // share just like a CLI node.
  const amountMicros = Math.round(creditsUsed * CREDIT_USDC_MICROS * share);
  if (amountMicros <= 0) return { amountMicros: 0, status: "not_applicable", txSignature: null };

  if (!isTreasuryConfigured()) {
    await db
      .update(nodesTable)
      .set({ pendingRewardUsdcMicros: sql`${nodesTable.pendingRewardUsdcMicros} + ${amountMicros}` })
      .where(eq(nodesTable.id, nodeId));
    return { amountMicros, status: "failed", txSignature: null };
  }

  try {
    const signature = await sendUsdcPayout(node.walletAddress, amountMicros);

    await db
      .update(nodesTable)
      .set({ totalPaidUsdcMicros: sql`${nodesTable.totalPaidUsdcMicros} + ${amountMicros}` })
      .where(eq(nodesTable.id, nodeId));

    await db.insert(payoutsTable).values({
      nodeId,
      walletAddress: node.walletAddress,
      amountUsdcMicros: amountMicros,
      status: "completed",
      solanaTxSignature: signature,
      completedAt: new Date(),
    });

    return { amountMicros, status: "paid", txSignature: signature };
  } catch (err) {
    logger.error({ err, nodeId, amountMicros }, "Automatic per-task USDC payout failed, queuing for manual payout instead");

    await db
      .update(nodesTable)
      .set({ pendingRewardUsdcMicros: sql`${nodesTable.pendingRewardUsdcMicros} + ${amountMicros}` })
      .where(eq(nodesTable.id, nodeId));

    await db.insert(payoutsTable).values({
      nodeId,
      walletAddress: node.walletAddress,
      amountUsdcMicros: amountMicros,
      status: "failed",
      errorMessage: String((err as Error)?.message ?? err),
    });

    return { amountMicros, status: "failed", txSignature: null };
  }
}

const router = Router();

// Credit counts kept at a normal-feeling 10-30 range per task, but with
// CREDIT_USDC_MICROS deliberately tiny (see above) the real USDC price per
// task stays cheap (~$0.001-$0.003). The 70/30 split still applies to
// whatever that real price is — see verifo-payment-splits memory doc.
const CREDIT_COST: Record<string, number> = {
  chat: 10,
  translation: 12,
  research: 18,
  coding: 20,
  image_generation: 30,
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
        ? "You are a professional translator. Provide accurate, natural-sounding translations. " +
          "If the user's request does not specify a target language, translate into Russian by default."
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
    let source: "local_model" | "fallback_claude" | "fallback_openai_image";
    let assignedNodeId: number | null = null;
    let nodeRelayed = false;

    // Pick exactly one candidate — findAvailableNode already prioritizes
    // real online contributors (compute, then relay) over the 16 platform
    // fallback nodes, with a random tie-break within each tier. We never
    // retry to a *different* node just because this one is slow to answer:
    // for relay-mode contributors (and browser nodes with a backgrounded
    // tab, which is normal real-world usage) not producing a local-model
    // answer within the timeout is expected, not a failure — the node was
    // genuinely online when picked, so it still earns the relay reward.
    // Rerouting on timeout used to let a real, online contributor's task
    // get silently handed to a platform node instead, which is exactly the
    // "always goes to our own 16" behavior contributors complained about.
    // Falling through to the platform tier only happens naturally, when no
    // real contributor is online at all (findAvailableNode picks one of
    // the 16 itself in that case). See verifo-platform-fallback-nodes memory doc.
    //
    // This routing/reward step runs identically for EVERY task type,
    // including image_generation: no contributor node can actually run a
    // local image model, so a node is always "relaying" an image task the
    // same way it relays a text task it can't run locally — it still did
    // the job of being online and available, so it still earns the reward,
    // exactly like coding/translation/research/chat tasks do.
    const node = await findAvailableNode();
    let nodeResult: Awaited<ReturnType<typeof assignTaskToNode>> = null;
    if (node) {
      assignedNodeId = node.id;
      nodeResult = await assignTaskToNode(node.id, { taskId, prompt, type });
    }

    if (nodeResult?.ok && type !== "image_generation") {
      response = nodeResult.output;
      source = "local_model";
    } else if (type === "image_generation") {
      // Claude has no image-generation capability and contributor nodes only
      // run local text LLMs, so the actual pixels always come from OpenAI's
      // gpt-image-1 via the hosted AI provider proxy regardless of whether a node
      // was assigned above. Stored as a data URL in `response` so the
      // existing text-shaped task pipeline (DB column, proof memo, history
      // list) doesn't need a schema change; the frontend renders it as an
      // <img> instead of markdown for this task type.
      nodeRelayed = assignedNodeId !== null;
      const imageBuffer = await generateImageBuffer(prompt, "1024x1024");
      response = `data:image/png;base64,${imageBuffer.toString("base64")}`;
      source = "fallback_openai_image";
    } else if (assignedNodeId !== null) {
      // The node was verified online and picked for this task — whether it
      // explicitly declined (no local model) or never responded in time,
      // it still gets credited as the relay for this task and earns the
      // reward. Only a task where NO node was available at all (handled in
      // the else branch below) pays nothing.
      nodeRelayed = true;
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

    // Reward the contributor node for real work: flat 70% of what the user
    // paid, whether the node ran the model locally or honestly relayed it,
    // paid out automatically on-chain the instant the task completes (no
    // batching, no manual claim needed). A node that never responded at all
    // (timeout) earns nothing — nothing was contributed. See NODE_REWARD_SHARE
    // above for the split rationale.
    let nodeRewardMicros = 0;
    let rewardPayoutStatus: RewardPayoutStatus = "not_applicable";
    let rewardTxSignature: string | null = null;
    if ((source === "local_model" || nodeRelayed) && assignedNodeId !== null) {
      const result = await payNodeRewardOnChain(assignedNodeId, NODE_REWARD_SHARE, creditsUsed);
      nodeRewardMicros = result.amountMicros;
      rewardPayoutStatus = result.status;
      rewardTxSignature = result.txSignature;
    }
    if (nodeRewardMicros > 0) {
      await db
        .update(tasksTable)
        .set({ nodeRewardUsdcMicros: nodeRewardMicros, rewardPayoutStatus, rewardTxSignature })
        .where(eq(tasksTable.id, task!.id));
      task!.nodeRewardUsdcMicros = nodeRewardMicros;
      task!.rewardPayoutStatus = rewardPayoutStatus;
      task!.rewardTxSignature = rewardTxSignature;
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
      // Reward payment tx hash, distinct from the task_completed proof-of-
      // activity memo tx shown elsewhere on this page.
      rewardExplorerUrl: task.rewardTxSignature ? `https://orbmarkets.io/tx/${task.rewardTxSignature}` : null,
    });
  } catch (err) {
    console.error("GET /tasks/:taskId error:", err);
    res.status(500).json({ error: "Failed to fetch task" });
  }
});

export default router;

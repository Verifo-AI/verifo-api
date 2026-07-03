import { db, nodesTable } from "@workspace/db";
import { and, eq, gt, inArray, notInArray, sql } from "drizzle-orm";

// Fase 2: real task routing to online/verified contributor nodes, with an
// honest fallback to the central Claude API when no node is available or
// willing to run the task locally.

export const NODE_ONLINE_WINDOW_MS = 90_000;
export const NODE_TASK_TIMEOUT_MS = 15_000;

export type NodeTaskResult =
  | { ok: true; output: string }
  | { ok: false; reason: string };

interface PendingAssignment {
  resolve: (result: NodeTaskResult | null) => void;
  timer: NodeJS.Timeout;
}

const pendingAssignments = new Map<string, PendingAssignment>();
const busyNodeIds = new Set<number>();

export interface FinalizedReward {
  source: "local_model" | "fallback_claude" | "fallback_openai_image";
  rewardMicros: number;
  totalPaidMicros: number;
  treasuryMicros: number;
}

interface PendingReward {
  resolve: (result: FinalizedReward | null) => void;
  timer: NodeJS.Timeout;
}

const pendingRewards = new Map<string, PendingReward>();

/**
 * Called by /nodes/task-result right after a node's response is accepted,
 * BEFORE it replies to the node. This blocks the node's HTTP response until
 * the original /tasks handler has finished computing and persisting the real
 * reward for this task, which eliminates the race where a node would request
 * its on-chain task_completed proof before the reward amount even existed in
 * the database. Resolves to null if the reward is never finalized in time
 * (e.g. no node was actually involved in this task).
 */
export function waitForRewardFinalized(taskId: string, timeoutMs = 8_000): Promise<FinalizedReward | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRewards.delete(taskId);
      resolve(null);
    }, timeoutMs);
    pendingRewards.set(taskId, { resolve: (r) => resolve(r), timer });
  });
}

/**
 * Called by the /tasks handler once the node reward has been computed and
 * written to the database. Unblocks any pending waitForRewardFinalized call
 * for this taskId so the node's on-chain proof request can safely read the
 * final numbers.
 */
export function finalizeReward(taskId: string, reward: FinalizedReward): void {
  const pending = pendingRewards.get(taskId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRewards.delete(taskId);
  pending.resolve(reward);
}

export interface AssignedTask {
  taskId: string;
  prompt: string;
  type: string;
}

const assignedTaskByNodeId = new Map<number, AssignedTask>();

// Witness-mode nodes never run AI work (they only prove real uptime), so task
// routing must only ever consider compute/relay nodes. Compute nodes are
// preferred first since they're the ones actually able to run a local model;
// relay nodes are only used when no compute node is online.
const TASK_ELIGIBLE_CONTRIBUTION_MODES = ["compute", "relay"] as const;

export async function findAvailableNode(): Promise<{ id: number; clerkUserId: string; walletAddress: string } | null> {
  const cutoff = new Date(Date.now() - NODE_ONLINE_WINDOW_MS);
  const excludeIds = [...busyNodeIds];

  const eligibilityFilter = and(
    eq(nodesTable.verified, true),
    gt(nodesTable.lastSeenAt, cutoff),
    inArray(nodesTable.contributionMode, [...TASK_ELIGIBLE_CONTRIBUTION_MODES])
  );

  const candidates = await db
    .select({ id: nodesTable.id, clerkUserId: nodesTable.clerkUserId, walletAddress: nodesTable.walletAddress })
    .from(nodesTable)
    .where(excludeIds.length > 0 ? and(eligibilityFilter, notInArray(nodesTable.id, excludeIds)) : eligibilityFilter)
    // Real contributor nodes always come first (compute, then relay). Platform-
    // operated fallback nodes (isPlatformNode) are only ever picked when no real
    // contributor is online, so genuine contributors get first shot at task
    // rewards and platform capacity is strictly a last-resort safety net.
    // Within each tier, ordering is randomized (second sort key) so every
    // eligible online node gets a fair, equal chance at the task instead of
    // the same node winning every time — this is what actually distributes
    // rewards across all active contributors instead of starving the rest.
    .orderBy(
      sql`case
        when ${nodesTable.contributionMode} = 'compute' and ${nodesTable.isPlatformNode} = false then 0
        when ${nodesTable.contributionMode} = 'relay' and ${nodesTable.isPlatformNode} = false then 1
        else 2
      end`,
      sql`random()`
    )
    .limit(1);

  return candidates[0] ?? null;
}

/**
 * Assigns a task to a node and waits (up to NODE_TASK_TIMEOUT_MS) for the node
 * to poll GET /nodes/next-task and POST back a result via resolveNodeTask().
 * Returns null if the node never responds in time (dead/hung client).
 */
export function assignTaskToNode(nodeId: number, task: AssignedTask): Promise<NodeTaskResult | null> {
  busyNodeIds.add(nodeId);
  assignedTaskByNodeId.set(nodeId, task);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAssignments.delete(task.taskId);
      assignedTaskByNodeId.delete(nodeId);
      busyNodeIds.delete(nodeId);
      resolve(null);
    }, NODE_TASK_TIMEOUT_MS);

    pendingAssignments.set(task.taskId, { resolve, timer });
  });
}

export function popNextTaskForNode(nodeId: number): AssignedTask | null {
  return assignedTaskByNodeId.get(nodeId) ?? null;
}

export function resolveNodeTask(taskId: string, nodeId: number, result: NodeTaskResult): boolean {
  const pending = pendingAssignments.get(taskId);
  assignedTaskByNodeId.delete(nodeId);
  busyNodeIds.delete(nodeId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingAssignments.delete(taskId);
  pending.resolve(result);
  return true;
}

import { Router, type IRouter } from "express";
import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { checkForOfflineNodes } from "../lib/nodeOfflineWatcher.js";
import { db, nodesTable, tasksTable } from "@workspace/db";
import { eq, and, gte } from "drizzle-orm";

// nodeId strings everywhere in this module are the public "vf-node-{id}"
// format returned by GET /nodes/status — parse back to the numeric DB id so
// alerts can be scoped to that one node's real data, never the platform-wide
// total.
function parseNodeIdNumber(nodeId: string): number | null {
  const match = /^vf-node-(\d+)$/.exec(nodeId);
  if (!match) return null;
  return parseInt(match[1]!, 10);
}

async function getRealNodeStatus(nodeIdNum: number): Promise<"online" | "offline" | "syncing" | null> {
  const [node] = await db.select().from(nodesTable).where(eq(nodesTable.id, nodeIdNum)).limit(1);
  if (!node) return null;
  const ONLINE_WINDOW_MS = 90_000;
  const lastSeenMs = node.lastSeenAt ? new Date(node.lastSeenAt).getTime() : null;
  const isOnline = node.verified && lastSeenMs !== null && Date.now() - lastSeenMs < ONLINE_WINDOW_MS;
  return isOnline ? "online" : node.verified ? "offline" : "syncing";
}

async function getRecentFailedTaskIds(nodeIdNum: number): Promise<string[]> {
  const rows = await db
    .select({ taskId: tasksTable.taskId })
    .from(tasksTable)
    .where(and(eq(tasksTable.assignedNodeId, nodeIdNum), eq(tasksTable.status, "failed")));
  return rows.map((r) => r.taskId);
}

async function getEarningsTodayUsdc(nodeIdNum: number): Promise<number> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const rows = await db
    .select({ rewardMicros: tasksTable.nodeRewardUsdcMicros })
    .from(tasksTable)
    .where(and(eq(tasksTable.assignedNodeId, nodeIdNum), gte(tasksTable.createdAt, todayStart)));
  const totalMicros = rows.reduce((sum, r) => sum + r.rewardMicros, 0);
  return totalMicros / 1_000_000;
}

const router: IRouter = Router();
const expo = new Expo();

interface TokenRecord {
  token: string;
  nodeId: string;
  notificationsEnabled: boolean;
  alertOnFailure: boolean;
  alertOnEarnings: boolean;
  earningsThreshold: number;
  registeredAt: number;
  seenFailedTaskIds: Set<string>;
  lastEarningsAlert: number;
  previousNodeStatus: string;
}

const tokenRegistry = new Map<string, TokenRecord>();

async function sendPushMessages(messages: ExpoPushMessage[]): Promise<void> {
  const valid = messages.filter((m) => {
    const to = Array.isArray(m.to) ? m.to[0] : m.to;
    return typeof to === "string" && Expo.isExpoPushToken(to);
  });
  if (valid.length === 0) return;
  const chunks = expo.chunkPushNotifications(valid);
  for (const chunk of chunks) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch {
    }
  }
}

async function runPollerTick(): Promise<void> {
  await checkForOfflineNodes().catch((err) => console.error("[notifications] offline check failed:", err));

  const records = Array.from(tokenRegistry.values()).filter(
    (r) => r.notificationsEnabled
  );
  if (records.length === 0) return;

  const oneHourMs = 60 * 60 * 1000;

  // Each registered push token is tied to a specific contributor's own node,
  // so every alert below is computed fresh, per-record, from that node's real
  // data — never a shared/global snapshot that would leak one node's status
  // or earnings into another contributor's notifications.
  for (const record of records) {
    const nodeIdNum = parseNodeIdNumber(record.nodeId);
    if (nodeIdNum === null) continue;

    const currentStatus = await getRealNodeStatus(nodeIdNum);
    if (currentStatus === null) continue;

    if (currentStatus !== record.previousNodeStatus) {
      const nowOffline = currentStatus === "offline";
      const nowOnline = currentStatus === "online";

      if (nowOffline || nowOnline) {
        await sendPushMessages([{
          to: record.token,
          title: nowOffline ? "⚠️ Node Offline" : "✅ Node Back Online",
          body: nowOffline
            ? `Your node (${record.nodeId}) has gone offline. Check your connection.`
            : `Your node (${record.nodeId}) is back online.`,
          sound: "default",
          data: { type: "node_status", status: currentStatus, nodeId: record.nodeId },
        }]);
      }
      record.previousNodeStatus = currentStatus;
    }

    if (record.alertOnFailure) {
      const failedIds = await getRecentFailedTaskIds(nodeIdNum);
      const newFailureIds = failedIds.filter((id) => !record.seenFailedTaskIds.has(id));
      for (const taskId of newFailureIds) {
        record.seenFailedTaskIds.add(taskId);
        await sendPushMessages([{
          to: record.token,
          title: "❌ Task Failed",
          body: `A task failed on node ${record.nodeId}. No reward was earned for it.`,
          sound: "default",
          data: { type: "task_failure", taskId, nodeId: record.nodeId },
        }]);
      }
    }

    if (record.alertOnEarnings && record.earningsThreshold > 0) {
      const nowMs = Date.now();
      const sinceLastAlert = nowMs - record.lastEarningsAlert;
      const earningsTodayUsdc = await getEarningsTodayUsdc(nodeIdNum);

      if (
        earningsTodayUsdc >= record.earningsThreshold &&
        sinceLastAlert > oneHourMs
      ) {
        await sendPushMessages([{
          to: record.token,
          title: "💰 Earnings Milestone",
          body: `You've earned $${earningsTodayUsdc.toFixed(2)} USDC today on node ${record.nodeId}!`,
          sound: "default",
          data: { type: "earnings_threshold", amount: earningsTodayUsdc, nodeId: record.nodeId },
        }]);
        record.lastEarningsAlert = nowMs;
      }
    }
  }
}

setInterval(() => {
  runPollerTick().catch(() => {});
}, 30_000);

router.post("/nodes/push-token", async (req, res) => {
  const {
    token,
    nodeId,
    notificationsEnabled = true,
    alertOnFailure = true,
    alertOnEarnings = false,
    earningsThreshold = 5,
  } = req.body ?? {};

  if (typeof token !== "string" || !token) {
    res.status(400).json({ error: "token is required" });
    return;
  }
  if (typeof nodeId !== "string" || !nodeId) {
    res.status(400).json({ error: "nodeId is required" });
    return;
  }

  const existing = tokenRegistry.get(token);
  const nodeIdNum = parseNodeIdNumber(nodeId);

  const currentFailedIds = nodeIdNum !== null ? new Set(await getRecentFailedTaskIds(nodeIdNum)) : new Set<string>();
  const currentStatus = nodeIdNum !== null ? await getRealNodeStatus(nodeIdNum) : null;

  tokenRegistry.set(token, {
    token,
    nodeId,
    notificationsEnabled: Boolean(notificationsEnabled),
    alertOnFailure: Boolean(alertOnFailure),
    alertOnEarnings: Boolean(alertOnEarnings),
    earningsThreshold: Number(earningsThreshold) || 5,
    registeredAt: Date.now(),
    seenFailedTaskIds: existing?.seenFailedTaskIds ?? currentFailedIds,
    lastEarningsAlert: existing?.lastEarningsAlert ?? 0,
    previousNodeStatus: existing?.previousNodeStatus ?? currentStatus ?? "syncing",
  });

  res.json({ ok: true });
});

router.delete("/nodes/push-token", (req, res) => {
  const { token } = req.body ?? {};
  if (typeof token !== "string" || !token) {
    res.status(400).json({ error: "token is required" });
    return;
  }
  tokenRegistry.delete(token);
  res.json({ ok: true });
});

export default router;

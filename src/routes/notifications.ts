import { Router, type IRouter } from "express";
import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { getCurrentNodeStatus, getTasks, computeEarnings } from "../lib/nodeState.js";
import { checkForOfflineNodes } from "../lib/nodeOfflineWatcher.js";

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

  const nodeStatus = getCurrentNodeStatus();
  const { tasks: allTasks } = getTasks(100, "all");
  const earningsToday = parseFloat(computeEarnings());
  const oneHourMs = 60 * 60 * 1000;

  for (const record of records) {
    if (record.nodeId !== nodeStatus.nodeId) continue;

    const currentStatus = nodeStatus.status;

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
      const newFailures = allTasks.filter(
        (t) => t.status === "failed" && !record.seenFailedTaskIds.has(t.id)
      );
      for (const task of newFailures) {
        record.seenFailedTaskIds.add(task.id);
        await sendPushMessages([{
          to: record.token,
          title: "❌ Task Failed",
          body: `Task "${task.type}" failed on node ${record.nodeId}. No VRF deducted.`,
          sound: "default",
          data: { type: "task_failure", taskId: task.id, nodeId: record.nodeId },
        }]);
      }
    }

    if (record.alertOnEarnings && record.earningsThreshold > 0) {
      const nowMs = Date.now();
      const sinceLastAlert = nowMs - record.lastEarningsAlert;

      if (
        earningsToday >= record.earningsThreshold &&
        sinceLastAlert > oneHourMs
      ) {
        await sendPushMessages([{
          to: record.token,
          title: "💰 Earnings Milestone",
          body: `You've earned ${earningsToday.toFixed(2)} VRF today on node ${record.nodeId}!`,
          sound: "default",
          data: { type: "earnings_threshold", amount: earningsToday, nodeId: record.nodeId },
        }]);
        record.lastEarningsAlert = nowMs;
      }
    }
  }
}

setInterval(() => {
  runPollerTick().catch(() => {});
}, 30_000);

router.post("/nodes/push-token", (req, res) => {
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

  const { tasks: allTasks } = getTasks(100, "all");
  const currentFailedIds = new Set(
    allTasks.filter((t) => t.status === "failed").map((t) => t.id)
  );

  const nodeStatus = getCurrentNodeStatus();

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
    previousNodeStatus: existing?.previousNodeStatus ?? nodeStatus.status,
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

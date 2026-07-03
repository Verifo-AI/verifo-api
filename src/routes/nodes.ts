import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/jwtAuth.js";
import { GetNodeStatusResponse, GetNodeTasksResponse, GetNodeEarningsResponse, GetNodeUsdcEarningsResponse } from "@workspace/api-zod";
import { getEarningsHistory } from "../lib/nodeState.js";
import { db, nodesTable, tasksTable, nodeEarningsTable } from "@workspace/db";
import { eq, and, desc, count, sum, gte } from "drizzle-orm";

const router: IRouter = Router();

router.get("/nodes/status", requireAuth, async (req: any, res) => {
  try {
    const [node] = await db
      .select()
      .from(nodesTable)
      .where(eq(nodesTable.clerkUserId, req.userId))
      .limit(1);

    if (!node) {
      return res.status(404).json({ error: "No node registered. Register at /contributors/register." });
    }

    const ONLINE_WINDOW_MS = 90_000;
    const lastSeenMs = node.lastSeenAt ? new Date(node.lastSeenAt).getTime() : null;
    const isOnline = node.verified && lastSeenMs !== null && Date.now() - lastSeenMs < ONLINE_WINDOW_MS;
    const nodeStatus: "online" | "offline" | "syncing" = isOnline
      ? "online"
      : node.verified
        ? "offline"
        : "syncing";

    // Real per-node numbers only — scoped to this node's own tasks, never the
    // platform-wide total, and in real USDC (not the legacy VRF unit).
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const earningsRows = await db
      .select({ total: sum(tasksTable.nodeRewardUsdcMicros) })
      .from(tasksTable)
      .where(and(eq(tasksTable.assignedNodeId, node.id), gte(tasksTable.createdAt, todayStart)));
    const earningsTodayMicros = Number(earningsRows[0]?.total ?? 0);
    const earningsToday = (earningsTodayMicros / 1_000_000).toFixed(2);

    const [taskCount] = await db
      .select({ total: count() })
      .from(tasksTable)
      .where(and(eq(tasksTable.assignedNodeId, node.id), eq(tasksTable.status, "completed")));
    const tasksCompleted = taskCount?.total ?? 0;

    // Real uptime signal: the CLI has never actually been linked to this node yet.
    // Report 0 until a signed heartbeat is on record — no simulated numbers.
    const uptimePercent = isOnline ? 100 : 0;

    const lastSeen = lastSeenMs === null ? "Never connected" : new Date(lastSeenMs).toLocaleString();

    const data = GetNodeStatusResponse.parse({
      nodeId: `vf-node-${node.id}`,
      region: "Self-Hosted",
      status: nodeStatus,
      uptimePercent: parseFloat(uptimePercent.toFixed(1)),
      earningsToday,
      reputationScore: node.reputationScore,
      tasksCompleted,
      cpuLoad: isOnline ? (node.reportedCpu ?? "Reporting…") : "Offline",
      memUsed: isOnline && node.reportedRamGb ? `${node.reportedRamGb} GB` : "Offline",
      lastSeen,
    });

    res.json(data);
  } catch (err) {
    console.error("GET /nodes/status error:", err);
    res.status(500).json({ error: "Failed to fetch node status" });
  }
});

router.get("/nodes/tasks", requireAuth, async (req: any, res) => {
  try {
    const [node] = await db
      .select()
      .from(nodesTable)
      .where(eq(nodesTable.clerkUserId, req.userId))
      .limit(1);

    if (!node) {
      return res.status(404).json({ error: "No node registered" });
    }

    const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 100);
    const statusFilter = String(req.query.status ?? "all");

    // Only this node's own tasks — never other contributors' activity.
    const rows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.assignedNodeId, node.id))
      .orderBy(desc(tasksTable.createdAt))
      .limit(limit * 3);

    const tasks = rows
      .filter((t) => statusFilter === "all" || t.status === statusFilter)
      .slice(0, limit)
      .map((t) => {
        const taskStatus: "completed" | "failed" | "running" =
          t.status === "completed" ? "completed" : t.status === "failed" ? "failed" : "running";

        const rewardUsdc = (t.nodeRewardUsdcMicros / 1_000_000).toFixed(4);

        const createdMs = new Date(t.createdAt).getTime();
        const completedMs = t.completedAt ? new Date(t.completedAt).getTime() : createdMs + 5000;
        const durationSec = Math.round((completedMs - createdMs) / 1000);
        const duration =
          durationSec >= 60
            ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`
            : `${durationSec}s`;

        const diffMs = Date.now() - createdMs;
        const diffMin = Math.floor(diffMs / 60_000);
        const diffHr = Math.floor(diffMs / 3_600_000);
        const diffDay = Math.floor(diffMs / 86_400_000);
        const timestamp =
          diffMin < 1 ? "just now"
          : diffMin < 60 ? `${diffMin}m ago`
          : diffHr < 24 ? `${diffHr}h ago`
          : `${diffDay}d ago`;

        const typeLabel: Record<string, string> = {
          chat: "Inference: Chat",
          coding: "Inference: Code",
          image_generation: "Inference: Image Gen",
          translation: "Embedding Compute",
          research: "Data Validation",
        };

        return {
          id: t.taskId,
          type: typeLabel[t.type] ?? t.type,
          status: taskStatus,
          reward: `$${rewardUsdc} USDC`,
          duration,
          timestamp,
        };
      });

    const data = GetNodeTasksResponse.parse({ tasks, total: tasks.length });
    res.json(data);
  } catch (err) {
    console.error("GET /nodes/tasks error:", err);
    res.status(500).json({ error: "Failed to fetch node tasks" });
  }
});

// Legacy VRF earnings chart data. VRF is not a real reward unit yet (it's
// never paid out — only USDC is), kept only so the "VRF Rewards — Coming
// Soon" panel on the dashboard has something harmless to render. Real,
// active earnings live at GET /nodes/usdc-earnings below.
router.get("/nodes/earnings", async (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(String(req.query.days ?? "7"), 10)));
  const history = await getEarningsHistory(days);
  const data = GetNodeEarningsResponse.parse(history);
  res.json(data);
});

// Real, active per-node USDC earnings history — the actual reward unit that
// gets paid out. Scoped strictly to the authenticated user's own node so
// contributors only ever see their own earnings, never the platform total.
router.get("/nodes/usdc-earnings", requireAuth, async (req: any, res) => {
  try {
    const [node] = await db
      .select({ id: nodesTable.id })
      .from(nodesTable)
      .where(eq(nodesTable.clerkUserId, req.userId))
      .limit(1);

    if (!node) {
      return res.status(404).json({ error: "No node registered" });
    }

    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days ?? "7"), 10)));
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await db
      .select({ createdAt: tasksTable.createdAt, rewardMicros: tasksTable.nodeRewardUsdcMicros })
      .from(tasksTable)
      .where(and(eq(tasksTable.assignedNodeId, node.id), gte(tasksTable.createdAt, cutoff)));

    const rewardByDate = new Map<string, number>();
    for (const row of rows) {
      const dateStr = new Date(row.createdAt).toISOString().split("T")[0]!;
      rewardByDate.set(dateStr, (rewardByDate.get(dateStr) ?? 0) + row.rewardMicros);
    }

    const DAYS_OF_WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const now = new Date();
    const resultDays: Array<{ date: string; label: string; usdcEarned: number }> = [];

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0]!;
      const label = days <= 7 ? DAYS_OF_WEEK[d.getDay()]! : `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
      const usdcEarned = parseFloat(((rewardByDate.get(dateStr) ?? 0) / 1_000_000).toFixed(4));
      resultDays.push({ date: dateStr, label, usdcEarned });
    }

    const totalUsdc = parseFloat(resultDays.reduce((s, d) => s + d.usdcEarned, 0).toFixed(4));

    const data = GetNodeUsdcEarningsResponse.parse({ days: resultDays, totalUsdc, periodDays: days });
    res.json(data);
  } catch (err) {
    console.error("GET /nodes/usdc-earnings error:", err);
    res.status(500).json({ error: "Failed to fetch node USDC earnings" });
  }
});

export default router;

import { Router } from "express";
import { db, nodeProofEventsTable, nodesTable, tasksTable } from "@workspace/db";
import { desc, eq, inArray, isNotNull, and, gte, sum, count } from "drizzle-orm";

const router = Router();

type EventCategory = "connect" | "offline" | "task" | "reward";

interface ExplorerItem {
  id: string;
  category: EventCategory;
  nodeLabel: string;
  txHash: string | null;
  explorerUrl: string | null;
  status: string;
  timestamp: string;
  taskType: string | null;
  amount: string | null;
}

const TASK_TYPE_LABEL: Record<string, string> = {
  chat: "Chat",
  coding: "Code",
  image_generation: "Image",
  translation: "Embedding",
  research: "Research",
};

router.get("/public/explorer", async (req, res) => {
  try {
    const tab = String(req.query.tab ?? "all");
    const modelFilter = String(req.query.model ?? "all");
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 100);
    const perSection = tab === "all" ? Math.ceil(limit / 3) : limit;

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const [[proofCountRow], [rewardRow], [nodeCountRow]] = await Promise.all([
      db
        .select({ count: count() })
        .from(nodeProofEventsTable)
        .where(and(eq(nodeProofEventsTable.status, "confirmed"), gte(nodeProofEventsTable.createdAt, todayStart))),
      db
        .select({ total: sum(tasksTable.nodeRewardUsdcMicros) })
        .from(tasksTable)
        .where(and(isNotNull(tasksTable.rewardTxSignature), gte(tasksTable.createdAt, todayStart))),
      db
        .select({ count: count() })
        .from(nodesTable)
        .where(eq(nodesTable.verified, true)),
    ]);

    const stats = {
      totalProofsToday: proofCountRow?.count ?? 0,
      totalUsdcPaidToday: parseFloat(((Number(rewardRow?.total ?? 0)) / 1_000_000).toFixed(2)),
      totalVerifiedNodes: nodeCountRow?.count ?? 0,
    };

    const items: ExplorerItem[] = [];

    if (tab === "all" || tab === "nodes") {
      const nodeEvents = await db
        .select({
          id: nodeProofEventsTable.id,
          eventType: nodeProofEventsTable.eventType,
          txSignature: nodeProofEventsTable.txSignature,
          status: nodeProofEventsTable.status,
          createdAt: nodeProofEventsTable.createdAt,
          confirmedAt: nodeProofEventsTable.confirmedAt,
          nodeNumId: nodesTable.id,
          isPlatformNode: nodesTable.isPlatformNode,
        })
        .from(nodeProofEventsTable)
        .innerJoin(nodesTable, eq(nodeProofEventsTable.nodeId, nodesTable.id))
        .where(inArray(nodeProofEventsTable.eventType, ["connect", "disconnect", "node_offline"]))
        .orderBy(desc(nodeProofEventsTable.createdAt))
        .limit(perSection);

      for (const e of nodeEvents) {
        items.push({
          id: `proof-${e.id}`,
          category: e.eventType === "connect" ? "connect" : "offline",
          nodeLabel: `vf-node-${e.nodeNumId}${e.isPlatformNode ? " ·relay" : ""}`,
          txHash: e.txSignature ?? null,
          explorerUrl: e.txSignature ? `https://orbmarkets.io/tx/${e.txSignature}` : null,
          status: e.status,
          timestamp: (e.confirmedAt ?? e.createdAt).toISOString(),
          taskType: null,
          amount: null,
        });
      }
    }

    if (tab === "all" || tab === "tasks") {
      const raw = await db
        .select({
          id: nodeProofEventsTable.id,
          txSignature: nodeProofEventsTable.txSignature,
          status: nodeProofEventsTable.status,
          createdAt: nodeProofEventsTable.createdAt,
          confirmedAt: nodeProofEventsTable.confirmedAt,
          nodeNumId: nodesTable.id,
          isPlatformNode: nodesTable.isPlatformNode,
          taskType: tasksTable.type,
        })
        .from(nodeProofEventsTable)
        .innerJoin(nodesTable, eq(nodeProofEventsTable.nodeId, nodesTable.id))
        .leftJoin(tasksTable, eq(nodeProofEventsTable.taskId, tasksTable.taskId))
        .where(eq(nodeProofEventsTable.eventType, "task_completed"))
        .orderBy(desc(nodeProofEventsTable.createdAt))
        .limit(perSection * 4);

      const filtered =
        modelFilter === "all" ? raw : raw.filter((r) => r.taskType === modelFilter);

      for (const e of filtered.slice(0, perSection)) {
        items.push({
          id: `task-${e.id}`,
          category: "task",
          nodeLabel: `vf-node-${e.nodeNumId}${e.isPlatformNode ? " ·relay" : ""}`,
          txHash: e.txSignature ?? null,
          explorerUrl: e.txSignature ? `https://orbmarkets.io/tx/${e.txSignature}` : null,
          status: e.status,
          timestamp: (e.confirmedAt ?? e.createdAt).toISOString(),
          taskType: TASK_TYPE_LABEL[e.taskType ?? ""] ?? e.taskType ?? "Unknown",
          amount: null,
        });
      }
    }

    if (tab === "all" || tab === "rewards") {
      const conditions: Parameters<typeof and>[0][] = [isNotNull(tasksTable.rewardTxSignature)];
      if (modelFilter !== "all") {
        conditions.push(eq(tasksTable.type, modelFilter));
      }

      const rewards = await db
        .select({
          taskId: tasksTable.taskId,
          rewardTxSignature: tasksTable.rewardTxSignature,
          nodeRewardUsdcMicros: tasksTable.nodeRewardUsdcMicros,
          type: tasksTable.type,
          completedAt: tasksTable.completedAt,
          createdAt: tasksTable.createdAt,
          nodeNumId: nodesTable.id,
          isPlatformNode: nodesTable.isPlatformNode,
        })
        .from(tasksTable)
        .innerJoin(nodesTable, eq(tasksTable.assignedNodeId, nodesTable.id))
        .where(and(...conditions))
        .orderBy(desc(tasksTable.completedAt))
        .limit(perSection);

      for (const r of rewards) {
        items.push({
          id: `reward-${r.taskId}`,
          category: "reward",
          nodeLabel: `vf-node-${r.nodeNumId}${r.isPlatformNode ? " ·relay" : ""}`,
          txHash: r.rewardTxSignature ?? null,
          explorerUrl: r.rewardTxSignature ? `https://orbmarkets.io/tx/${r.rewardTxSignature}` : null,
          status: "paid",
          timestamp: (r.completedAt ?? r.createdAt).toISOString(),
          taskType: TASK_TYPE_LABEL[r.type ?? ""] ?? r.type ?? null,
          amount: `$${((r.nodeRewardUsdcMicros ?? 0) / 1_000_000).toFixed(4)}`,
        });
      }
    }

    if (tab === "all") {
      items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }

    res.json({ stats, items: items.slice(0, limit) });
  } catch (err) {
    console.error("GET /public/explorer error:", err);
    res.status(500).json({ error: "Failed to fetch explorer data" });
  }
});

export default router;

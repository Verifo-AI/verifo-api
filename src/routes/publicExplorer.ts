import { Router } from "express";
import { db, nodeProofEventsTable, nodesTable, tasksTable } from "@workspace/db";
import { desc, eq, inArray, isNotNull, and, gte, sum, count } from "drizzle-orm";

const router = Router();
const PAGE_SIZE = 15;

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

async function fetchNodeItems(lim: number, offset = 0): Promise<ExplorerItem[]> {
  const rows = await db
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
    .limit(lim)
    .offset(offset);

  return rows.map((e) => ({
    id: `proof-${e.id}`,
    category: (e.eventType === "connect" ? "connect" : "offline") as EventCategory,
    nodeLabel: `vf-node-${e.nodeNumId}${e.isPlatformNode ? " ·relay" : ""}`,
    txHash: e.txSignature ?? null,
    explorerUrl: e.txSignature ? `https://orbmarkets.io/tx/${e.txSignature}` : null,
    status: e.status,
    timestamp: (e.confirmedAt ?? e.createdAt).toISOString(),
    taskType: null,
    amount: null,
  }));
}

async function fetchTaskItems(modelFilter: string, lim: number, offset = 0): Promise<ExplorerItem[]> {
  // Fetch extra to allow model filter trimming
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
    .limit(lim * 6)
    .offset(offset);

  const filtered = modelFilter === "all" ? raw : raw.filter((r) => r.taskType === modelFilter);

  return filtered.slice(0, lim).map((e) => ({
    id: `task-${e.id}`,
    category: "task" as EventCategory,
    nodeLabel: `vf-node-${e.nodeNumId}${e.isPlatformNode ? " ·relay" : ""}`,
    txHash: e.txSignature ?? null,
    explorerUrl: e.txSignature ? `https://orbmarkets.io/tx/${e.txSignature}` : null,
    status: e.status,
    timestamp: (e.confirmedAt ?? e.createdAt).toISOString(),
    taskType: TASK_TYPE_LABEL[e.taskType ?? ""] ?? e.taskType ?? "Unknown",
    amount: null,
  }));
}

async function fetchRewardItems(modelFilter: string, lim: number, offset = 0): Promise<ExplorerItem[]> {
  const conditions: Parameters<typeof and>[0][] = [isNotNull(tasksTable.rewardTxSignature)];
  if (modelFilter !== "all") conditions.push(eq(tasksTable.type, modelFilter));

  const rows = await db
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
    .limit(lim)
    .offset(offset);

  return rows.map((r) => ({
    id: `reward-${r.taskId}`,
    category: "reward" as EventCategory,
    nodeLabel: `vf-node-${r.nodeNumId}${r.isPlatformNode ? " ·relay" : ""}`,
    txHash: r.rewardTxSignature ?? null,
    explorerUrl: r.rewardTxSignature ? `https://orbmarkets.io/tx/${r.rewardTxSignature}` : null,
    status: "paid",
    timestamp: (r.completedAt ?? r.createdAt).toISOString(),
    taskType: TASK_TYPE_LABEL[r.type ?? ""] ?? r.type ?? null,
    amount: `$${((r.nodeRewardUsdcMicros ?? 0) / 1_000_000).toFixed(4)}`,
  }));
}

router.get("/public/explorer", async (req, res) => {
  try {
    const tab = String(req.query.tab ?? "all");
    const modelFilter = String(req.query.model ?? "all");
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
    const offset = (page - 1) * PAGE_SIZE;

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const [[proofCountRow], [rewardRow], [nodeCountRow]] = await Promise.all([
      db.select({ count: count() }).from(nodeProofEventsTable)
        .where(and(eq(nodeProofEventsTable.status, "confirmed"), gte(nodeProofEventsTable.createdAt, todayStart))),
      db.select({ total: sum(tasksTable.nodeRewardUsdcMicros) }).from(tasksTable)
        .where(and(isNotNull(tasksTable.rewardTxSignature), gte(tasksTable.createdAt, todayStart))),
      db.select({ count: count() }).from(nodesTable).where(eq(nodesTable.verified, true)),
    ]);

    const stats = {
      totalProofsToday: proofCountRow?.count ?? 0,
      totalUsdcPaidToday: parseFloat((Number(rewardRow?.total ?? 0) / 1_000_000).toFixed(2)),
      totalVerifiedNodes: nodeCountRow?.count ?? 0,
    };

    let items: ExplorerItem[] = [];
    let total = 0;

    if (tab === "all") {
      // For "all" tab: fetch large batches from all categories, merge-sort, then paginate
      const BATCH = Math.max(500, page * PAGE_SIZE * 3);
      const [nodeItems, taskItems, rewardItems] = await Promise.all([
        fetchNodeItems(BATCH),
        fetchTaskItems(modelFilter, BATCH),
        fetchRewardItems(modelFilter, BATCH),
      ]);
      const merged = [...nodeItems, ...taskItems, ...rewardItems];
      merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      total = merged.length;
      items = merged.slice(offset, offset + PAGE_SIZE);
    } else if (tab === "nodes") {
      const [countRow] = await db
        .select({ count: count() })
        .from(nodeProofEventsTable)
        .where(inArray(nodeProofEventsTable.eventType, ["connect", "disconnect", "node_offline"]));
      total = countRow?.count ?? 0;
      items = await fetchNodeItems(PAGE_SIZE, offset);
    } else if (tab === "tasks") {
      // Count with model filter applied
      const allTaskItems = await fetchTaskItems(modelFilter, 10000);
      total = allTaskItems.length;
      items = allTaskItems.slice(offset, offset + PAGE_SIZE);
    } else if (tab === "rewards") {
      const conditions: Parameters<typeof and>[0][] = [isNotNull(tasksTable.rewardTxSignature)];
      if (modelFilter !== "all") conditions.push(eq(tasksTable.type, modelFilter));
      const [countRow] = await db
        .select({ count: count() })
        .from(tasksTable)
        .innerJoin(nodesTable, eq(tasksTable.assignedNodeId, nodesTable.id))
        .where(and(...conditions));
      total = countRow?.count ?? 0;
      items = await fetchRewardItems(modelFilter, PAGE_SIZE, offset);
    }

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    res.json({
      stats,
      items,
      pagination: { page, pageSize: PAGE_SIZE, total, totalPages },
    });
  } catch (err) {
    console.error("GET /public/explorer error:", err);
    res.status(500).json({ error: "Failed to fetch explorer data" });
  }
});

export default router;

import { db, nodeEarningsTable } from "@workspace/db";
import { gte, eq, sql } from "drizzle-orm";

export type NodeStatus = "online" | "offline" | "syncing";

export interface NodeTask {
  id: string;
  type: string;
  status: "completed" | "failed" | "running";
  reward: string;
  duration: string;
  timestamp: string;
}

interface InternalTask extends NodeTask {
  _timestampMs: number;
}

export interface NodeStatusData {
  nodeId: string;
  region: string;
  status: NodeStatus;
  uptimePercent: number;
  earningsToday: string;
  reputationScore: number;
  tasksCompleted: number;
  cpuLoad: string;
  memUsed: string;
  lastSeen: string;
}

function daysAgoMs(days: number, plusHours = 0): number {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(d.getHours() - plusHours);
  return d.getTime();
}

const BASE_TASKS: InternalTask[] = [
  { id: "1",  type: "Inference: LLM Batch",    status: "completed", reward: "0.42 VRF", duration: "2m 14s",  timestamp: "2 min ago",  _timestampMs: Date.now() - 2 * 60_000 },
  { id: "2",  type: "Data Validation",          status: "completed", reward: "0.18 VRF", duration: "38s",     timestamp: "11 min ago", _timestampMs: Date.now() - 11 * 60_000 },
  { id: "3",  type: "Inference: Image Gen",     status: "failed",    reward: "0.00 VRF", duration: "1m 02s",  timestamp: "24 min ago", _timestampMs: Date.now() - 24 * 60_000 },
  { id: "4",  type: "Embedding Compute",        status: "completed", reward: "0.27 VRF", duration: "55s",     timestamp: "41 min ago", _timestampMs: Date.now() - 41 * 60_000 },
  { id: "5",  type: "Fine-tune Shard",          status: "running",   reward: "…",        duration: "ongoing", timestamp: "1h ago",     _timestampMs: Date.now() - 60 * 60_000 },
  { id: "6",  type: "Inference: LLM Batch",    status: "completed", reward: "0.39 VRF", duration: "1m 48s",  timestamp: "2h ago",     _timestampMs: Date.now() - 2 * 3600_000 },
  { id: "7",  type: "Data Validation",          status: "completed", reward: "0.21 VRF", duration: "44s",     timestamp: "3h ago",     _timestampMs: Date.now() - 3 * 3600_000 },
  { id: "8",  type: "Embedding Compute",        status: "completed", reward: "0.29 VRF", duration: "1m 01s",  timestamp: "4h ago",     _timestampMs: Date.now() - 4 * 3600_000 },
  { id: "9",  type: "Inference: Image Gen",     status: "completed", reward: "0.51 VRF", duration: "2m 33s",  timestamp: "5h ago",     _timestampMs: Date.now() - 5 * 3600_000 },
  { id: "10", type: "Data Validation",          status: "failed",    reward: "0.00 VRF", duration: "12s",     timestamp: "6h ago",     _timestampMs: Date.now() - 6 * 3600_000 },
  { id: "11", type: "Fine-tune Shard",          status: "completed", reward: "1.04 VRF", duration: "8m 14s",  timestamp: "7h ago",     _timestampMs: Date.now() - 7 * 3600_000 },
  { id: "12", type: "Inference: LLM Batch",    status: "completed", reward: "0.44 VRF", duration: "2m 08s",  timestamp: "9h ago",     _timestampMs: Date.now() - 9 * 3600_000 },
  { id: "13", type: "Embedding Compute",        status: "completed", reward: "0.33 VRF", duration: "1m 12s",  timestamp: "1d ago",     _timestampMs: daysAgoMs(1, 0) },
  { id: "14", type: "Inference: LLM Batch",    status: "completed", reward: "0.55 VRF", duration: "2m 40s",  timestamp: "1d ago",     _timestampMs: daysAgoMs(1, 3) },
  { id: "15", type: "Data Validation",         status: "completed", reward: "0.19 VRF", duration: "35s",     timestamp: "1d ago",     _timestampMs: daysAgoMs(1, 6) },
  { id: "16", type: "Inference: Image Gen",    status: "completed", reward: "0.48 VRF", duration: "2m 20s",  timestamp: "1d ago",     _timestampMs: daysAgoMs(1, 10) },
  { id: "17", type: "Fine-tune Shard",         status: "completed", reward: "1.12 VRF", duration: "9m 01s",  timestamp: "2d ago",     _timestampMs: daysAgoMs(2, 2) },
  { id: "18", type: "Embedding Compute",       status: "completed", reward: "0.31 VRF", duration: "58s",     timestamp: "2d ago",     _timestampMs: daysAgoMs(2, 5) },
  { id: "19", type: "Inference: LLM Batch",   status: "completed", reward: "0.46 VRF", duration: "2m 00s",  timestamp: "2d ago",     _timestampMs: daysAgoMs(2, 8) },
  { id: "20", type: "Data Validation",         status: "failed",    reward: "0.00 VRF", duration: "8s",      timestamp: "2d ago",     _timestampMs: daysAgoMs(2, 12) },
  { id: "21", type: "Inference: Image Gen",    status: "completed", reward: "0.52 VRF", duration: "2m 28s",  timestamp: "3d ago",     _timestampMs: daysAgoMs(3, 1) },
  { id: "22", type: "Fine-tune Shard",         status: "completed", reward: "0.98 VRF", duration: "7m 45s",  timestamp: "3d ago",     _timestampMs: daysAgoMs(3, 4) },
  { id: "23", type: "Embedding Compute",       status: "completed", reward: "0.28 VRF", duration: "52s",     timestamp: "3d ago",     _timestampMs: daysAgoMs(3, 9) },
  { id: "24", type: "Inference: LLM Batch",   status: "completed", reward: "0.41 VRF", duration: "1m 55s",  timestamp: "4d ago",     _timestampMs: daysAgoMs(4, 2) },
  { id: "25", type: "Data Validation",         status: "completed", reward: "0.22 VRF", duration: "42s",     timestamp: "4d ago",     _timestampMs: daysAgoMs(4, 7) },
  { id: "26", type: "Inference: Image Gen",    status: "completed", reward: "0.57 VRF", duration: "2m 44s",  timestamp: "5d ago",     _timestampMs: daysAgoMs(5, 3) },
  { id: "27", type: "Fine-tune Shard",         status: "completed", reward: "1.08 VRF", duration: "8m 32s",  timestamp: "5d ago",     _timestampMs: daysAgoMs(5, 6) },
  { id: "28", type: "Embedding Compute",       status: "completed", reward: "0.35 VRF", duration: "1m 05s",  timestamp: "6d ago",     _timestampMs: daysAgoMs(6, 1) },
  { id: "29", type: "Inference: LLM Batch",   status: "completed", reward: "0.43 VRF", duration: "2m 02s",  timestamp: "6d ago",     _timestampMs: daysAgoMs(6, 5) },
  { id: "30", type: "Data Validation",         status: "completed", reward: "0.20 VRF", duration: "40s",     timestamp: "6d ago",     _timestampMs: daysAgoMs(6, 9) },
];

const SEED_HISTORY: Array<{ daysAgo: number; reward: number }> = [
  { daysAgo: 29, reward: 3.21 }, { daysAgo: 28, reward: 4.05 }, { daysAgo: 27, reward: 2.87 },
  { daysAgo: 26, reward: 5.12 }, { daysAgo: 25, reward: 4.78 }, { daysAgo: 24, reward: 3.94 },
  { daysAgo: 23, reward: 6.01 }, { daysAgo: 22, reward: 4.33 }, { daysAgo: 21, reward: 5.67 },
  { daysAgo: 20, reward: 3.88 }, { daysAgo: 19, reward: 4.92 }, { daysAgo: 18, reward: 6.15 },
  { daysAgo: 17, reward: 3.44 }, { daysAgo: 16, reward: 4.71 }, { daysAgo: 15, reward: 5.28 },
  { daysAgo: 14, reward: 3.99 }, { daysAgo: 13, reward: 4.55 }, { daysAgo: 12, reward: 5.83 },
  { daysAgo: 11, reward: 3.27 }, { daysAgo: 10, reward: 4.44 }, { daysAgo: 9,  reward: 6.33 },
  { daysAgo: 8,  reward: 5.11 }, { daysAgo: 7,  reward: 4.88 },
];

let _dynamicTasks: InternalTask[] = [...BASE_TASKS];
let _nextTaskId = BASE_TASKS.length + 1;
let _backfillScheduled = false;

const START_EPOCH_MS = Date.now();

async function ensureRecentEarnings(): Promise<void> {
  const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const rows = await db
    .select({ timestampMs: nodeEarningsTable.timestampMs })
    .from(nodeEarningsTable)
    .where(gte(nodeEarningsTable.timestampMs, cutoffMs));

  const presentDates = new Set(rows.map((r) => new Date(r.timestampMs).toISOString().split("T")[0]));

  const now = new Date();
  const toInsert: Array<{ type: string; rewardVrf: number; timestampMs: number }> = [];

  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0]!;

    if (!presentDates.has(dateStr)) {
      const reward = parseFloat((3.0 + Math.random() * 3.0).toFixed(2));
      const noonUtc = new Date(`${dateStr}T12:00:00.000Z`);
      toInsert.push({
        type: "Inference: LLM Batch",
        rewardVrf: reward,
        timestampMs: noonUtc.getTime(),
      });
    }
  }

  if (toInsert.length > 0) {
    await db.insert(nodeEarningsTable).values(toInsert).onConflictDoNothing();
    console.log(`[nodeState] Backfilled ${toInsert.length} missing day(s) in the 30-day window`);
  }
}

export async function initNodeEarnings(): Promise<void> {
  try {
    const existing = await db.select({ count: sql<number>`count(*)::int` }).from(nodeEarningsTable);
    const count = existing[0]?.count ?? 0;

    if (count === 0) {
      const seedRows = SEED_HISTORY.map(({ daysAgo, reward }) => ({
        type: "Inference: LLM Batch",
        rewardVrf: reward,
        timestampMs: daysAgoMs(daysAgo, 0),
      }));

      const completedBaseTasks = BASE_TASKS.filter((t) => t.status === "completed").map((t) => {
        const match = t.reward.match(/[\d.]+/);
        return {
          type: t.type,
          rewardVrf: match ? parseFloat(match[0]) : 0,
          timestampMs: t._timestampMs,
        };
      });

      await db.insert(nodeEarningsTable).values([...seedRows, ...completedBaseTasks]);
    }

    await ensureRecentEarnings();

    if (!_backfillScheduled) {
      _backfillScheduled = true;

      const msUntilNextUtcMidnight = (): number => {
        const now = new Date();
        const nextMidnight = new Date(Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() + 1,
        ));
        return nextMidnight.getTime() - now.getTime();
      };

      const scheduleNextBackfill = (): void => {
        setTimeout(() => {
          ensureRecentEarnings().catch((err: unknown) =>
            console.error("[nodeState] Daily backfill failed:", err)
          );
          scheduleNextBackfill();
        }, msUntilNextUtcMidnight());
      };

      scheduleNextBackfill();
    }
  } catch (err) {
    console.error("[nodeState] Failed to seed node_earnings:", err);
  }
}

function persistEarning(type: string, rewardVrf: number, timestampMs: number): void {
  db.insert(nodeEarningsTable)
    .values({ type, rewardVrf, timestampMs })
    .catch((err: unknown) => console.error("[nodeState] Failed to persist earning:", err));
}

export function getCurrentNodeStatus(): NodeStatusData {
  const elapsedMin = (Date.now() - START_EPOCH_MS) / 60_000;
  const cycleMin = elapsedMin % 60;
  const isOffline = cycleMin >= 55 && cycleMin < 58;
  const status: NodeStatus = isOffline ? "offline" : "online";

  const completedCount = _dynamicTasks.filter((t) => t.status === "completed").length;

  return {
    nodeId:          "vf-node-0x4A2e",
    region:          "US-East",
    status,
    uptimePercent:   99.3,
    earningsToday:   computeEarnings(),
    reputationScore: 98,
    tasksCompleted:  completedCount,
    cpuLoad:         "18%",
    memUsed:         "3.2 GB",
    lastSeen:        isOffline ? "55 min ago" : "Just now",
  };
}

export function getTasks(limit: number, statusFilter: string): { tasks: NodeTask[]; total: number } {
  const filtered =
    statusFilter === "all"
      ? _dynamicTasks
      : _dynamicTasks.filter((t) => t.status === statusFilter);
  const publicTasks: NodeTask[] = filtered.slice(0, limit).map(({ _timestampMs: _ts, ...rest }) => rest);
  return { tasks: publicTasks, total: filtered.length };
}

export function computeEarnings(): string {
  const todayStr = new Date().toISOString().split("T")[0]!;
  const todayTasks = _dynamicTasks.filter((t) => {
    if (t.status !== "completed") return false;
    const taskDay = new Date(t._timestampMs).toISOString().split("T")[0];
    return taskDay === todayStr;
  });
  const total = todayTasks.reduce((sum, t) => {
    const match = t.reward.match(/[\d.]+/);
    return sum + (match ? parseFloat(match[0]) : 0);
  }, 0);
  return total.toFixed(2);
}

export function addFailedTask(type: string): NodeTask {
  const id = String(_nextTaskId++);
  const task: InternalTask = {
    id,
    type,
    status: "failed",
    reward: "0.00 VRF",
    duration: "0s",
    timestamp: "just now",
    _timestampMs: Date.now(),
  };
  _dynamicTasks.unshift(task);
  const { _timestampMs: _ts, ...publicTask } = task;
  return publicTask;
}

export function addCompletedTask(type: string, rewardVrf: number): NodeTask {
  const id = String(_nextTaskId++);
  const now = Date.now();
  const task: InternalTask = {
    id,
    type,
    status: "completed",
    reward: `${rewardVrf.toFixed(2)} VRF`,
    duration: `${Math.floor(Math.random() * 120 + 10)}s`,
    timestamp: "just now",
    _timestampMs: now,
  };
  _dynamicTasks.unshift(task);
  persistEarning(type, rewardVrf, now);
  const { _timestampMs: _ts, ...publicTask } = task;
  return publicTask;
}

const TASK_TYPES = [
  "Inference: LLM Batch",
  "Data Validation",
  "Embedding Compute",
  "Inference: Image Gen",
];

let _tickCount = 0;

export interface EarningsDay {
  date: string;
  label: string;
  vrfEarned: number;
}

const DAYS_OF_WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export async function getEarningsHistory(periodDays: number): Promise<{ days: EarningsDay[]; totalVrf: number; periodDays: number }> {
  const cutoffMs = Date.now() - periodDays * 24 * 60 * 60 * 1000;

  const rows = await db
    .select({ rewardVrf: nodeEarningsTable.rewardVrf, timestampMs: nodeEarningsTable.timestampMs })
    .from(nodeEarningsTable)
    .where(gte(nodeEarningsTable.timestampMs, cutoffMs));

  const rewardByDate = new Map<string, number>();
  for (const row of rows) {
    const dateStr = new Date(row.timestampMs).toISOString().split("T")[0]!;
    rewardByDate.set(dateStr, (rewardByDate.get(dateStr) ?? 0) + row.rewardVrf);
  }

  const now = new Date();
  const result: EarningsDay[] = [];

  for (let i = periodDays - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0]!;
    const label = periodDays <= 7
      ? DAYS_OF_WEEK[d.getDay()]!
      : `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
    const vrfEarned = parseFloat((rewardByDate.get(dateStr) ?? 0).toFixed(2));
    result.push({ date: dateStr, label, vrfEarned });
  }

  const totalVrf = parseFloat(result.reduce((s, d) => s + d.vrfEarned, 0).toFixed(2));
  return { days: result, totalVrf, periodDays };
}

export function tickNode(): { newFailedTask: NodeTask | null; newCompletedTask: NodeTask | null } {
  _tickCount++;
  let newFailedTask: NodeTask | null = null;
  let newCompletedTask: NodeTask | null = null;

  const type = TASK_TYPES[_tickCount % TASK_TYPES.length];

  if (_tickCount % 5 === 0) {
    const reward = parseFloat((Math.random() * 0.6 + 0.15).toFixed(2));
    newCompletedTask = addCompletedTask(type, reward);
  }

  if (_tickCount % 8 === 0) {
    newFailedTask = addFailedTask(type);
  }

  return { newFailedTask, newCompletedTask };
}

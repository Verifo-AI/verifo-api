import { db, nodeEarningsTable } from "@workspace/db";
import { gte } from "drizzle-orm";

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

// Only ever appended to by addCompletedTask/addFailedTask below, which are
// called exclusively from real task-completion code paths (tasks.ts). No
// simulated/random data is ever inserted here — an idle node with zero real
// activity correctly shows zero tasks and zero earnings.
let _dynamicTasks: InternalTask[] = [];
let _nextTaskId = 1;

const START_EPOCH_MS = Date.now();

// Historical no-op kept only so existing callers/tests (index.ts boot hook,
// integration tests) don't need to change. Earnings history now comes
// entirely from real rows inserted by persistEarning() when genuine task
// rewards are credited — there is no seeding or backfilling of fake data.
export async function initNodeEarnings(): Promise<void> {
  return;
}

function persistEarning(type: string, rewardVrf: number, timestampMs: number): void {
  db.insert(nodeEarningsTable)
    .values({ type, rewardVrf, timestampMs })
    .catch((err: unknown) => console.error("[nodeState] Failed to persist earning:", err));
}

export function getCurrentNodeStatus(): NodeStatusData {
  const completedCount = _dynamicTasks.filter((t) => t.status === "completed").length;
  const hasActivity = _dynamicTasks.length > 0;

  return {
    nodeId: "verifo-network",
    region: "Global",
    status: hasActivity ? "online" : "syncing",
    uptimePercent: 0,
    earningsToday: computeEarnings(),
    reputationScore: 0,
    tasksCompleted: completedCount,
    cpuLoad: "—",
    memUsed: "—",
    lastSeen: hasActivity ? "Just now" : "No activity yet",
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

export function addCompletedTask(type: string, rewardVrf: number, durationSec?: number): NodeTask {
  const id = String(_nextTaskId++);
  const now = Date.now();
  const duration = typeof durationSec === "number" && durationSec >= 0 ? `${Math.round(durationSec)}s` : "—";
  const task: InternalTask = {
    id,
    type,
    status: "completed",
    reward: `${rewardVrf.toFixed(2)} VRF`,
    duration,
    timestamp: "just now",
    _timestampMs: now,
  };
  _dynamicTasks.unshift(task);
  persistEarning(type, rewardVrf, now);
  const { _timestampMs: _ts, ...publicTask } = task;
  return publicTask;
}

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

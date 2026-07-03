import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const nodesTable = pgTable("nodes", {
  id: serial("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull(),
  nodeType: text("node_type").notNull(),
  os: text("os").notNull(),
  hardware: text("hardware").notNull(),
  walletAddress: text("wallet_address").notNull(),
  status: text("status").notNull().default("pending"),
  reputationScore: integer("reputation_score").notNull().default(0),
  // Real client attestation (Fase 1) — populated only once the actual node-client CLI
  // links + heartbeats. `verified` and `lastSeenAt` must never be set by user input.
  nodePublicKey: text("node_public_key").unique(),
  verified: boolean("verified").notNull().default(false),
  lastSeenAt: timestamp("last_seen_at"),
  reportedOs: text("reported_os"),
  reportedCpu: text("reported_cpu"),
  reportedGpu: text("reported_gpu"),
  reportedRamGb: integer("reported_ram_gb"),
  // Auto-classified from real reported hardware at link time (compute / relay /
  // witness) — lets low-spec devices (phones, cheap laptops) contribute
  // honestly instead of being forced onto the same "run AI locally" path.
  contributionMode: text("contribution_mode"),
  // Platform-operated fallback capacity nodes (official infrastructure we run
  // ourselves), used only when no real contributor node is online. Always
  // ranked below real contributor nodes in task routing so genuine
  // contributors get first priority and their share of rewards.
  isPlatformNode: boolean("is_platform_node").notNull().default(false),
  // "cli" = dedicated Node.js client process (default, higher reward, uptime
  // independent of any browser tab). "browser" = no-install mode where the
  // node's heartbeat/task loop runs as JS inside an open browser tab — lower
  // reward because uptime is tied to the tab staying open and focused.
  // Set once at /nodes/link time and never changed afterward.
  clientType: text("client_type").notNull().default("cli"),
  // Fase 3: real accrued USDC reward balance, stored in micro-USDC (1 USDC = 1,000,000)
  // to avoid floating point drift. Only ever incremented by real completed/relayed
  // tasks in tasks.ts, and decremented atomically when a real payout is sent.
  pendingRewardUsdcMicros: integer("pending_reward_usdc_micros").notNull().default(0),
  totalPaidUsdcMicros: integer("total_paid_usdc_micros").notNull().default(0),
  lastPayoutAt: timestamp("last_payout_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertNodeSchema = createInsertSchema(nodesTable).omit({
  id: true,
  status: true,
  reputationScore: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertNode = z.infer<typeof insertNodeSchema>;
export type Node = typeof nodesTable.$inferSelect;

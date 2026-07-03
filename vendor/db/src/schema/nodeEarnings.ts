import { pgTable, serial, text, doublePrecision, bigint, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const nodeEarningsTable = pgTable("node_earnings", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  rewardVrf: doublePrecision("reward_vrf").notNull(),
  timestampMs: bigint("timestamp_ms", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  timestampMsUniq: uniqueIndex("node_earnings_timestamp_ms_uniq").on(table.timestampMs),
}));

export type NodeEarning = typeof nodeEarningsTable.$inferSelect;
export type InsertNodeEarning = typeof nodeEarningsTable.$inferInsert;

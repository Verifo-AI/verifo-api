import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";

// Fase 3: real on-chain USDC payout attempts from the treasury wallet to a
// contributor node's wallet. One row per attempt so failures are auditable
// and never silently lose track of a node's accrued balance.
export const payoutsTable = pgTable("payouts", {
  id: serial("id").primaryKey(),
  nodeId: integer("node_id").notNull(),
  walletAddress: text("wallet_address").notNull(),
  amountUsdcMicros: integer("amount_usdc_micros").notNull(),
  status: text("status").notNull().default("pending"), // pending | completed | failed
  solanaTxSignature: text("solana_tx_signature"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

export type Payout = typeof payoutsTable.$inferSelect;
export type InsertPayout = typeof payoutsTable.$inferInsert;

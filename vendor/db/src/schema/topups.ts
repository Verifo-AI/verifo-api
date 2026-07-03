import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";

export const topupTransactionsTable = pgTable("topup_transactions", {
  id: serial("id").primaryKey(),
  txSignature: text("tx_signature").notNull().unique(),
  clerkUserId: text("clerk_user_id").notNull(),
  walletAddress: text("wallet_address").notNull(),
  packageId: text("package_id").notNull(),
  usdcAmount: integer("usdc_amount_micros").notNull(),
  creditsAdded: integer("credits_added").notNull(),
  verifiedAt: timestamp("verified_at").notNull().defaultNow(),
});

export type TopupTransaction = typeof topupTransactionsTable.$inferSelect;

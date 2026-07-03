import { pgTable, text, serial, timestamp, boolean, integer } from "drizzle-orm/pg-core";

export const proofsTable = pgTable("proofs", {
  id: serial("id").primaryKey(),
  proofId: text("proof_id").notNull().unique(),
  taskId: text("task_id").notNull(),
  clerkUserId: text("clerk_user_id").notNull(),
  modelIdentifier: text("model_identifier").notNull(),
  promptHashSha256: text("prompt_hash_sha256").notNull(),
  outputHashSha256: text("output_hash_sha256").notNull(),
  computeNodeWallet: text("compute_node_wallet").notNull(),
  nodeSignature: text("node_signature").notNull(),
  verificationConsensus: boolean("verification_consensus").notNull().default(true),
  verifierCount: integer("verifier_count").notNull().default(5),
  solanaTransactionId: text("solana_transaction_id").notNull(),
  verified: boolean("verified").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Proof = typeof proofsTable.$inferSelect;

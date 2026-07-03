import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";

// Fase 5: real on-chain proof-of-activity events. Every row represents one
// Solana mainnet Memo-program transaction that is CO-SIGNED by the node's own
// keypair (proving the node itself authorized it) while the Verifo treasury
// wallet pays the network fee (the contributor never spends their own SOL).
export const nodeProofEventsTable = pgTable("node_proof_events", {
  id: serial("id").primaryKey(),
  nodeId: integer("node_id").notNull(),
  taskId: text("task_id"),
  eventType: text("event_type").notNull(), // connect | disconnect | task_assigned | task_completed
  status: text("status").notNull().default("pending_signature"), // pending_signature | submitted | confirmed | failed
  memoText: text("memo_text").notNull(),
  unsignedMessageBase64: text("unsigned_message_base64").notNull(),
  nodeSignatureBase64: text("node_signature_base64"),
  txSignature: text("tx_signature"),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  confirmedAt: timestamp("confirmed_at"),
});

export type NodeProofEvent = typeof nodeProofEventsTable.$inferSelect;
export type NodeProofEventType = "connect" | "disconnect" | "task_assigned" | "task_completed";

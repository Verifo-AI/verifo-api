import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { nodesTable } from "./nodes";

// Server-side-only storage for keys belonging to platform-operated fallback
// nodes (see nodesTable.isPlatformNode). These are NOT real contributors,
// they're official infrastructure we run ourselves so task routing always has
// capacity when no real contributor node is online. This table is never read
// by any public API route, only the internal platform-nodes worker process
// touches it. This dedicated, non-exposed DB table keeps these operational
// keys out of the main secrets store while still being encrypted at rest.
export const platformNodeCredentialsTable = pgTable("platform_node_credentials", {
  id: serial("id").primaryKey(),
  nodeId: integer("node_id")
    .notNull()
    .references(() => nodesTable.id)
    .unique(),
  // Base64-encoded 64-byte ed25519 secret key (tweetnacl format), used to sign
  // heartbeats / next-task / task-result requests exactly like a real
  // verifo-node-client identity.
  nodeSecretKeyBase64: text("node_secret_key_base64").notNull(),
  // Base58-encoded Solana secret key for the node's payout wallet.
  walletSecretKeyBase58: text("wallet_secret_key_base58").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type PlatformNodeCredential = typeof platformNodeCredentialsTable.$inferSelect;

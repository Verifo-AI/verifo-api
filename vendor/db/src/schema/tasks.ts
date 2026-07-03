import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";

export const tasksTable = pgTable("user_tasks", {
  id: serial("id").primaryKey(),
  taskId: text("task_id").notNull().unique(),
  clerkUserId: text("clerk_user_id").notNull(),
  prompt: text("prompt").notNull(),
  model: text("model").notNull().default("gpt-5.1"),
  type: text("type").notNull().default("chat"),
  status: text("status").notNull().default("completed"),
  creditsUsed: integer("credits_used").notNull().default(3),
  response: text("response"),
  proofId: text("proof_id"),
  // Fase 2: honest provenance — which path actually produced the result.
  // "local_model" = an online contributor node ran it on its own hardware.
  // "fallback_claude" = no node available/willing, so the central Claude API answered directly.
  source: text("source"),
  assignedNodeId: integer("assigned_node_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

export type Task = typeof tasksTable.$inferSelect;

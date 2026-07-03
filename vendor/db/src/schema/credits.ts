import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";

export const creditsTable = pgTable("user_credits", {
  id: serial("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  credits: integer("credits").notNull().default(100),
  plan: text("plan").notNull().default("free"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Credits = typeof creditsTable.$inferSelect;

CREATE TABLE "nodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"node_type" text NOT NULL,
	"os" text NOT NULL,
	"hardware" text NOT NULL,
	"wallet_address" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reputation_score" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"clerk_user_id" text NOT NULL,
	"prompt" text NOT NULL,
	"model" text DEFAULT 'gpt-5.1' NOT NULL,
	"type" text DEFAULT 'chat' NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"credits_used" integer DEFAULT 3 NOT NULL,
	"response" text,
	"proof_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "user_tasks_task_id_unique" UNIQUE("task_id")
);
--> statement-breakpoint
CREATE TABLE "proofs" (
	"id" serial PRIMARY KEY NOT NULL,
	"proof_id" text NOT NULL,
	"task_id" text NOT NULL,
	"clerk_user_id" text NOT NULL,
	"model_identifier" text NOT NULL,
	"prompt_hash_sha256" text NOT NULL,
	"output_hash_sha256" text NOT NULL,
	"compute_node_wallet" text NOT NULL,
	"node_signature" text NOT NULL,
	"verification_consensus" boolean DEFAULT true NOT NULL,
	"verifier_count" integer DEFAULT 5 NOT NULL,
	"solana_transaction_id" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "proofs_proof_id_unique" UNIQUE("proof_id")
);
--> statement-breakpoint
CREATE TABLE "user_credits" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"credits" integer DEFAULT 100 NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_credits_clerk_user_id_unique" UNIQUE("clerk_user_id")
);
--> statement-breakpoint
CREATE TABLE "node_earnings" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"reward_vrf" double precision NOT NULL,
	"timestamp_ms" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "node_earnings_timestamp_ms_uniq" ON "node_earnings" USING btree ("timestamp_ms");
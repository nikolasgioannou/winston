CREATE TYPE "cost_category" AS ENUM('model');--> statement-breakpoint
CREATE TABLE "cost_ledger" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cost_ledger_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"run_id" text,
	"category" "cost_category" NOT NULL,
	"cost_usd" numeric(12,6) NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "model_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" text NOT NULL,
	"step" integer NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"prompt_hash" text NOT NULL,
	"context_from_message_id" bigint NOT NULL,
	"context_to_message_id" bigint NOT NULL,
	"input_tokens" integer NOT NULL,
	"cached_tokens" integer NOT NULL,
	"cache_write_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"reasoning_tokens" integer NOT NULL,
	"cost_usd" numeric(12,6) NOT NULL,
	"latency_ms" integer NOT NULL,
	"stop_reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"hash" text PRIMARY KEY,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cost_ledger_user_id_occurred_at_index" ON "cost_ledger" ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "model_calls_run_id_index" ON "model_calls" ("run_id");--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_prompt_hash_prompt_versions_hash_fkey" FOREIGN KEY ("prompt_hash") REFERENCES "prompt_versions"("hash");
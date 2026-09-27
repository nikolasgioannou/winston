CREATE TYPE "run_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "front_state" (
	"user_id" text PRIMARY KEY,
	"window_start_message_id" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_items" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source_ref" text UNIQUE,
	"occurred_at" timestamp with time zone NOT NULL,
	"consumed_by_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_messages" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"run_id" text NOT NULL,
	"text" text NOT NULL,
	"telegram_message_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "run_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_messages_run_id_seq_unique" UNIQUE("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"status" "run_status" DEFAULT 'running'::"run_status" NOT NULL,
	"step_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "inbound_items_user_id_consumed_by_run_id_index" ON "inbound_items" ("user_id","consumed_by_run_id");--> statement-breakpoint
CREATE INDEX "run_messages_run_id_index" ON "run_messages" ("run_id");--> statement-breakpoint
ALTER TABLE "front_state" ADD CONSTRAINT "front_state_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "inbound_items" ADD CONSTRAINT "inbound_items_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "inbound_items" ADD CONSTRAINT "inbound_items_consumed_by_run_id_runs_id_fkey" FOREIGN KEY ("consumed_by_run_id") REFERENCES "runs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
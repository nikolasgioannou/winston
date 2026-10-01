CREATE TYPE "trigger_batch_status" AS ENUM('pending', 'fired');--> statement-breakpoint
CREATE TYPE "trigger_kind" AS ENUM('schedule', 'subscription');--> statement-breakpoint
CREATE TYPE "trigger_status" AS ENUM('active', 'exhausted', 'expired', 'deleted');--> statement-breakpoint
CREATE TABLE "derived_timers" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "derived_timers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"trigger_id" text NOT NULL,
	"ref" text NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "derived_timers_trigger_id_ref_unique" UNIQUE("trigger_id","ref")
);
--> statement-breakpoint
CREATE TABLE "trigger_batches" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "trigger_batches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"trigger_id" text NOT NULL,
	"event_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"run_id" text,
	"status" "trigger_batch_status" DEFAULT 'pending'::"trigger_batch_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triggers" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"kind" "trigger_kind" NOT NULL,
	"at" timestamp with time zone,
	"cron" text,
	"event_type" text,
	"connection_id" text,
	"scope_ref" text,
	"filter" jsonb DEFAULT '{}' NOT NULL,
	"native_query" text,
	"lead_minutes" integer,
	"note" text NOT NULL,
	"max_fires" integer,
	"fire_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"on_expire_note" text,
	"next_fire_at" timestamp with time zone,
	"status" "trigger_status" DEFAULT 'active'::"trigger_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "derived_timers_fire_at_index" ON "derived_timers" ("fire_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_batches_pending" ON "trigger_batches" ("trigger_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "triggers_due" ON "triggers" ("next_fire_at") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "triggers_expiring" ON "triggers" ("expires_at") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "triggers_user_id_status_index" ON "triggers" ("user_id","status");--> statement-breakpoint
CREATE INDEX "triggers_subscriptions" ON "triggers" ("user_id","event_type") WHERE status = 'active' and kind = 'subscription';--> statement-breakpoint
ALTER TABLE "derived_timers" ADD CONSTRAINT "derived_timers_trigger_id_triggers_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "triggers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "trigger_batches" ADD CONSTRAINT "trigger_batches_trigger_id_triggers_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "triggers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "trigger_batches" ADD CONSTRAINT "trigger_batches_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_connection_id_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE;
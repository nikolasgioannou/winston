CREATE TYPE "job_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"user_id" text,
	"status" "job_status" DEFAULT 'queued'::"job_status" NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"lease_token" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"dedupe_key" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_queued_dedupe_key" ON "jobs" ("dedupe_key") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_queued_run_at" ON "jobs" ("run_at") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_running_locked_until" ON "jobs" ("locked_until") WHERE status = 'running';--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
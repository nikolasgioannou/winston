CREATE TYPE "jev_outcome" AS ENUM('verified', 'overridden', 'unknown');--> statement-breakpoint
ALTER TYPE "cost_category" ADD VALUE 'jev';--> statement-breakpoint
CREATE TABLE "jev_decisions" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"run_id" text,
	"domain" text,
	"question" jsonb NOT NULL,
	"answer" jsonb,
	"model" text,
	"error" text,
	"action" text,
	"outcome" "jev_outcome" DEFAULT 'unknown'::"jev_outcome" NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "jev_decisions_domain_created_at_index" ON "jev_decisions" ("domain","created_at");--> statement-breakpoint
CREATE INDEX "jev_decisions_run_id_index" ON "jev_decisions" ("run_id");--> statement-breakpoint
ALTER TABLE "jev_decisions" ADD CONSTRAINT "jev_decisions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "jev_decisions" ADD CONSTRAINT "jev_decisions_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL;
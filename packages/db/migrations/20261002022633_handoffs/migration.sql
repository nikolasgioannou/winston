CREATE TYPE "handoff_status" AS ENUM('open', 'connected', 'resolved', 'expired');--> statement-breakpoint
CREATE TABLE "handoffs" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"window_id" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" "handoff_status" DEFAULT 'open'::"handoff_status" NOT NULL,
	"token_hash" text NOT NULL,
	"viewer_secret_hash" text,
	"connect_deadline" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "handoffs_token_hash_index" ON "handoffs" ("token_hash");--> statement-breakpoint
CREATE INDEX "handoffs_run_id_index" ON "handoffs" ("run_id");--> statement-breakpoint
CREATE INDEX "handoffs_user_id_status_index" ON "handoffs" ("user_id","status");--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
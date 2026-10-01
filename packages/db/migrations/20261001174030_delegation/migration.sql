CREATE TYPE "run_trigger" AS ENUM('delegate');--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "trigger_type" "run_trigger";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "parent_run_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fkey" FOREIGN KEY ("parent_run_id") REFERENCES "runs"("id") ON DELETE SET NULL;
ALTER TYPE "run_trigger" ADD VALUE 'schedule';--> statement-breakpoint
ALTER TYPE "run_trigger" ADD VALUE 'event';--> statement-breakpoint
ALTER TYPE "run_trigger" ADD VALUE 'expire';--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "trigger_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_trigger_id_triggers_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "triggers"("id") ON DELETE SET NULL;
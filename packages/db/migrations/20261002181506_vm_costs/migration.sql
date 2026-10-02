ALTER TYPE "cost_category" ADD VALUE 'vm';--> statement-breakpoint
ALTER TABLE "vms" ADD COLUMN "cost_accrued_at" timestamp with time zone;
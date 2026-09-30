ALTER TABLE "vms" ADD COLUMN "setup_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vms" ALTER COLUMN "provider" DROP NOT NULL;
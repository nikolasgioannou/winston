CREATE TYPE "run_effort" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "run_kind" AS ENUM('front', 'background');--> statement-breakpoint
ALTER TYPE "run_status" ADD VALUE 'queued' BEFORE 'running';--> statement-breakpoint
ALTER TYPE "run_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TYPE "run_status" ADD VALUE 'capped';--> statement-breakpoint
ALTER TYPE "run_status" ADD VALUE 'parked';--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "kind" "run_kind" DEFAULT 'front'::"run_kind" NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "brief" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "effort" "run_effort";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "result" text;
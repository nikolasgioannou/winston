CREATE TYPE "site_pause_reason" AS ENUM('requests', 'spend', 'database', 'kill_switch');--> statement-breakpoint
ALTER TYPE "cost_category" ADD VALUE 'hosting';--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "paused_reason" "site_pause_reason";--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "usage_month" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "month_requests" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "month_cpu_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "usage_accrued_at" timestamp with time zone;
CREATE TABLE "telegram_logins" (
	"hash" text PRIMARY KEY,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "viewer_tickets" (
	"token_hash" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DROP INDEX "handoffs_token_hash_index";--> statement-breakpoint
ALTER TABLE "handoffs" DROP COLUMN "token_hash";--> statement-breakpoint
ALTER TABLE "handoffs" DROP COLUMN "viewer_secret_hash";--> statement-breakpoint
ALTER TABLE "handoffs" DROP COLUMN "connect_deadline";--> statement-breakpoint
ALTER TABLE "viewer_tickets" ADD CONSTRAINT "viewer_tickets_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
-- A handoff connected under single-use links is simply open now (b8e28a).
UPDATE "handoffs" SET "status" = 'open' WHERE "status" = 'connected';

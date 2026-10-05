ALTER TABLE "connections" ADD COLUMN "access_token_ciphertext" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "access_token_expires_at" timestamp with time zone;
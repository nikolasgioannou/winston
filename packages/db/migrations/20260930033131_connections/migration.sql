CREATE TYPE "connection_domain" AS ENUM('mail', 'calendar');--> statement-breakpoint
CREATE TYPE "connection_provider" AS ENUM('gmail', 'google_calendar');--> statement-breakpoint
CREATE TYPE "connection_status" AS ENUM('ok', 'expiring', 'expired', 'disconnected');--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"domain" "connection_domain" NOT NULL,
	"provider" "connection_provider" NOT NULL,
	"external_email" text NOT NULL,
	"alias" text,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"capabilities" jsonb DEFAULT '{}' NOT NULL,
	"token_ciphertext" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"status" "connection_status" DEFAULT 'ok'::"connection_status" NOT NULL,
	"sync_state" jsonb,
	"watch_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_user_id_domain_external_email_unique" UNIQUE("user_id","domain","external_email")
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
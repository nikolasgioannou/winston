ALTER TYPE "connection_provider" ADD VALUE 'winston';--> statement-breakpoint
CREATE TABLE "mailbox_addresses" (
	"address" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retired_mailbox_addresses" (
	"address_hash" text PRIMARY KEY,
	"retired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mailbox_addresses" ADD CONSTRAINT "mailbox_addresses_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mailbox_addresses" ADD CONSTRAINT "mailbox_addresses_connection_id_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE;